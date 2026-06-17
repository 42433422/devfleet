$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Data = Join-Path $Root "data"
$SecretFile = Join-Path $Data "jwt-secret.txt"
New-Item -ItemType Directory -Force -Path $Data | Out-Null
if (-not (Test-Path $SecretFile)) {
  [Guid]::NewGuid().ToString("N") | Set-Content -NoNewline $SecretFile
}
$env:JWT_SECRET = Get-Content -Raw $SecretFile
$env:DEVFLEET_DB_FILE = Join-Path $Data "db.json"
if (-not $env:PORT) { $env:PORT = "3001" }
$Node = Join-Path $Root "runtime\node.exe"
if (-not (Test-Path $Node)) {
  $Node = "node"
}
& $Node (Join-Path $Root "devfleet-server.cjs")
