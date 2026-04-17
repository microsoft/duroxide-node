# Pre-publish smoke for Windows (PowerShell). See run-local.sh for details.
$ErrorActionPreference = 'Stop'

if (-not $env:TARBALL_MAIN)     { throw "TARBALL_MAIN must be set" }
if (-not $env:TARBALL_PLATFORM) { throw "TARBALL_PLATFORM must be set" }
if (-not $env:SMOKE_SCRIPT)     { throw "SMOKE_SCRIPT must be set" }

$workdir = Join-Path $env:RUNNER_TEMP ("duroxide-smoke-" + [System.Guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $workdir | Out-Null
Write-Host "[smoke] workdir=$workdir"
Write-Host "[smoke] main=$env:TARBALL_MAIN"
Write-Host "[smoke] platform=$env:TARBALL_PLATFORM"

Push-Location $workdir
try {
  npm init -y | Out-Null
  npm install --no-audit --no-fund --ignore-scripts $env:TARBALL_PLATFORM $env:TARBALL_MAIN
  if ($LASTEXITCODE -ne 0) { throw "npm install failed ($LASTEXITCODE)" }

  Copy-Item $env:SMOKE_SCRIPT ./smoke.mjs
  node ./smoke.mjs
  if ($LASTEXITCODE -ne 0) { throw "node smoke.mjs failed ($LASTEXITCODE)" }
  Write-Host "[smoke] local smoke OK"
} finally {
  Pop-Location
}
