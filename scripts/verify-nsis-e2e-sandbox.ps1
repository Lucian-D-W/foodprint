[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [ValidateScript({
        [System.IO.Path]::GetFullPath($_).StartsWith(
            [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()),
            [System.StringComparison]::OrdinalIgnoreCase
        )
    })]
    [string]$SandboxRoot,
    [int]$LaunchTimeoutSeconds = 20
)

$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$root = [System.IO.Path]::GetFullPath($SandboxRoot)
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
$install = Join-Path $root 'installed-app'
$localAppData = Join-Path $root 'local-app-data'
$dataDir = Join-Path $localAppData 'com.dean.foodmap'
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$sentinel = Join-Path $dataDir 'retain-after-uninstall.txt'
[IO.File]::WriteAllText($sentinel, 'FoodMap GUI E2E disposable sentinel')

$result = [ordered]@{
    installer = $installer
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    sandboxRoot = $root
    temporaryLocalAppData = $localAppData
    installExitCode = $null
    firstInstancePids = @()
    loopbackConnections = @()
    sandboxDatabase = $null
    noExternalSockets = $false
    secondInstanceCreatedProcess = $false
    secondInstancePid = $null
    singleInstancePassed = $false
    uninstallExitCode = $null
    sentinelRetained = $false
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
}

$oldLocal = $env:LOCALAPPDATA
$oldRoaming = $env:APPDATA
$oldTestRoot = $env:FOODMAP_TEST_DATA_ROOT
try {
    # Tauri's Windows path resolver reads these inherited known-folder variables.
    # They are scoped to this PowerShell process and its child processes.
    $env:LOCALAPPDATA = $localAppData
    $env:APPDATA = Join-Path $root 'roaming-app-data'
    # Debug/e2e bundles expose this test-only override; release binaries omit it.
    $env:FOODMAP_TEST_DATA_ROOT = $dataDir
    $installProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$install") -Wait -PassThru
    $result.installExitCode = $installProcess.ExitCode
    if ($installProcess.ExitCode -ne 0) { throw "installer exited $($installProcess.ExitCode)" }
    $exe = Join-Path $install 'FoodMap.exe'
    if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'installed FoodMap.exe was not found' }

    $first = Start-Process -FilePath $exe -PassThru
    $deadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        $instances = @(Get-CimInstance Win32_Process -Filter "Name='FoodMap.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    } while ($instances.Count -eq 0 -and (Get-Date) -lt $deadline)
    if ($instances.Count -eq 0) { throw 'first GUI instance did not remain running' }
    $result.firstInstancePids = @($instances.ProcessId)
    $database = Join-Path $dataDir 'db\foodmap.sqlite3'
    $deadline = (Get-Date).AddSeconds($LaunchTimeoutSeconds)
    while (-not (Test-Path -LiteralPath $database) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }
    if (-not (Test-Path -LiteralPath $database -PathType Leaf)) { throw 'installed debug candidate did not initialize sandbox database' }
    $result.sandboxDatabase = $database
    $result.loopbackConnections = @(
        Get-NetTCPConnection -ErrorAction SilentlyContinue |
            Where-Object { $_.OwningProcess -in $result.firstInstancePids -and $_.LocalAddress -eq '127.0.0.1' } |
            Select-Object OwningProcess, LocalAddress, LocalPort, RemoteAddress, RemotePort, State
    )
    if ($result.loopbackConnections.Count -lt 1) { throw 'installed candidate has no loopback listener' }
    $external = @(Get-NetTCPConnection -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -in $result.firstInstancePids -and $_.RemoteAddress -notin @('127.0.0.1','::1','0.0.0.0','::') })
    $result.noExternalSockets = $external.Count -eq 0
    if (-not $result.noExternalSockets) { throw 'installed candidate opened an external socket' }

    $second = Start-Process -FilePath $exe -PassThru
    $result.secondInstanceCreatedProcess = $true
    $result.secondInstancePid = $second.Id
    Start-Sleep -Seconds 3
    $afterSecond = @(Get-CimInstance Win32_Process -Filter "Name='FoodMap.exe'" | Where-Object { $_.ExecutablePath -eq $exe })
    $result.singleInstancePassed = $afterSecond.Count -eq $instances.Count
    if (-not $result.singleInstancePassed) { throw 'second launch left an additional FoodMap process' }
} finally {
    Get-CimInstance Win32_Process -Filter "Name='FoodMap.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq (Join-Path $install 'FoodMap.exe') } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru
        $result.uninstallExitCode = $uninstall.ExitCode
    }
    $result.sentinelRetained = Test-Path -LiteralPath $sentinel -PathType Leaf
    $result.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'nsis-e2e-result.json') -Encoding utf8
    $env:LOCALAPPDATA = $oldLocal
    $env:APPDATA = $oldRoaming
    $env:FOODMAP_TEST_DATA_ROOT = $oldTestRoot
}

if ($result.installExitCode -ne 0 -or -not $result.sandboxDatabase -or -not $result.noExternalSockets -or -not $result.singleInstancePassed -or $result.uninstallExitCode -ne 0 -or -not $result.sentinelRetained) { exit 1 }
Write-Host "PASS installed GUI, second-instance, loopback capture, and uninstall retention: $root"
