#requires -Version 7.0
$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot '..')
try {
    & node --test
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & actionlint
    exit $LASTEXITCODE
} finally { Pop-Location }
