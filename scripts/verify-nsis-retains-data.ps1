[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$InstallerPath,
    [Parameter(Mandatory = $true)]
    [ValidateScript({
        $resolved = [System.IO.Path]::GetFullPath($_)
        $temporary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
        $resolved.StartsWith($temporary, [System.StringComparison]::OrdinalIgnoreCase)
    })]
    [string]$SandboxRoot
)

$ErrorActionPreference = 'Stop'
$installer = (Resolve-Path -LiteralPath $InstallerPath).Path
$root = [System.IO.Path]::GetFullPath($SandboxRoot)
if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
New-Item -ItemType Directory -Path $root | Out-Null

# Never derive this from a real profile.  The fixture proves the installer and
# uninstaller do not target an arbitrary AppLocalData-shaped tree.
$install = Join-Path $root 'installed-app'
$fixture = Join-Path $root 'AppLocalData\com.dean.foodmap'
New-Item -ItemType Directory -Path $fixture -Force | Out-Null
$sentinel = Join-Path $fixture 'retain-after-uninstall.txt'
[System.IO.File]::WriteAllText($sentinel, 'FoodMap disposable retention fixture')

$record = [ordered]@{
    installer = $installer
    installerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
    sandboxRoot = $root
    installDirectory = $install
    fixturePath = $fixture
    startedAtUtc = [DateTime]::UtcNow.ToString('o')
    installExitCode = $null
    uninstallExitCode = $null
    retained = $false
    notes = @(
        'The fixture is deliberately below a temporary root, never the user AppLocalData.',
        'This verifies that NSIS install/uninstall does not recursively delete unrelated local-data-shaped directories.',
        'It does not claim that a launched WebView app used this fixture as its Windows known-folder AppLocalData.'
    )
}

try {
    $installProcess = Start-Process -FilePath $installer -ArgumentList @('/S', "/D=$install") -Wait -PassThru
    $record.installExitCode = $installProcess.ExitCode
    if ($installProcess.ExitCode -ne 0) { throw "NSIS installation exited $($installProcess.ExitCode)" }
    $uninstaller = Join-Path $install 'uninstall.exe'
    if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'NSIS installation did not produce uninstall.exe' }
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList @('/S') -Wait -PassThru
    $record.uninstallExitCode = $uninstallProcess.ExitCode
    if ($uninstallProcess.ExitCode -ne 0) { throw "NSIS uninstallation exited $($uninstallProcess.ExitCode)" }
    $record.retained = Test-Path -LiteralPath $sentinel -PathType Leaf
    if (-not $record.retained) { throw 'The disposable AppLocalData retention fixture was removed.' }
} finally {
    $record.finishedAtUtc = [DateTime]::UtcNow.ToString('o')
    $record | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'nsis-retention-result.json') -Encoding utf8
}

if (-not $record.retained) { exit 1 }
Write-Host "PASS NSIS install/uninstall retained disposable fixture: $sentinel"
