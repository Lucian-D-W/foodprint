[CmdletBinding()]
param(
    [switch]$Pressure
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$runRoot = Join-Path $temporaryRoot ("foodmap-stage9-" + [guid]::NewGuid().ToString('N'))
$previousTemp = @{ TEMP = $env:TEMP; TMP = $env:TMP; TMPDIR = $env:TMPDIR }
New-Item -ItemType Directory -Path $runRoot | Out-Null

function Invoke-Checked([string]$Program, [string[]]$NativeArguments) {
    & $Program @NativeArguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}

try {
    # TempDir-based Rust tests inherit these variables.  This makes every data,
    # backup, media and restore fixture disposable and outside AppLocalData.
    $env:TEMP = $runRoot
    $env:TMP = $runRoot
    $env:TMPDIR = $runRoot
    Push-Location $root
    Invoke-Checked -Program cargo -NativeArguments @('test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', '--no-fail-fast')
    Invoke-Checked -Program corepack -NativeArguments @('pnpm', 'lint')
    Invoke-Checked -Program corepack -NativeArguments @('pnpm', 'typecheck')
    Invoke-Checked -Program corepack -NativeArguments @('pnpm', 'test')
    if ($Pressure) {
        Invoke-Checked -Program cargo -NativeArguments @('test', '--manifest-path', 'src-tauri/Cargo.toml', '--locked', 'stage9_disposable_pressure_matrix', '--', '--nocapture')
    }
}
finally {
    Pop-Location -ErrorAction SilentlyContinue
    foreach ($name in $previousTemp.Keys) {
        if ($null -eq $previousTemp[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
        else { Set-Item -LiteralPath "Env:$name" -Value $previousTemp[$name] }
    }
    if ([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($runRoot)) -eq $temporaryRoot) {
        Remove-Item -LiteralPath $runRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
}
