#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    & node --test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    if (Test-Path 'tools\epic-dashboard') {
        & python -B -m unittest discover -s (Join-Path 'tools' 'epic-dashboard') -v
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else { Write-Host 'No Python test directory yet.' }
    & actionlint
    exit $LASTEXITCODE
} finally { Pop-Location }
