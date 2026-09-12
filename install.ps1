# hitch installer for Windows (PowerShell 5.1 or 7+).
#
#   irm https://raw.githubusercontent.com/Nigmat-future/hitch/main/install.ps1 | iex
#
# Options (environment variables, set before running):
#   $env:HITCH_VERSION = "0.1.0"   install a tagged release instead of main
#   $env:HITCH_REF = "<branch>"    install another branch
#   $env:HITCH_INSTALL_DIR         where the code goes    (default %LOCALAPPDATA%\hitch\app)
#   $env:HITCH_BIN_DIR             where the command goes (default %LOCALAPPDATA%\hitch\bin)
#   $env:HITCH_ARCHIVE             a local .zip to install from instead of GitHub
#   $env:HITCH_NO_PATH = "1"       do not add the bin folder to your user PATH
#
# Uninstall:  $env:HITCH_UNINSTALL = "1"; irm …/install.ps1 | iex
#
# This script downloads one archive from github.com over HTTPS, unpacks it,
# and writes a one-line hitch.cmd launcher. It needs Node.js 22+. It never
# touches your AI tool configs; hitch itself only does that when you ask.

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail($message) {
  Write-Host "hitch install: $message" -ForegroundColor Red
  exit 1
}

$repo = "Nigmat-future/hitch"
$root = Join-Path $env:LOCALAPPDATA "hitch"
$installDir = if ($env:HITCH_INSTALL_DIR) { $env:HITCH_INSTALL_DIR } else { Join-Path $root "app" }
$binDir = if ($env:HITCH_BIN_DIR) { $env:HITCH_BIN_DIR } else { Join-Path $root "bin" }

function Get-UserPath { [Environment]::GetEnvironmentVariable("Path", "User") }
function Split-PathList($value) { if ($value) { $value.Split(";") | Where-Object { $_ } } else { @() } }

if ($env:HITCH_UNINSTALL -eq "1") {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $installDir, (Join-Path $binDir "hitch.cmd")
  if ($env:HITCH_NO_PATH -ne "1") {
    $kept = Split-PathList (Get-UserPath) | Where-Object { $_.TrimEnd("\") -ne $binDir.TrimEnd("\") }
    [Environment]::SetEnvironmentVariable("Path", ($kept -join ";"), "User")
  }
  Write-Host "Removed $installDir and $binDir\hitch.cmd."
  Write-Host "Your Pi/OMP files and backups were not touched. ~\.hitch\state.json remains; delete it if you like."
  return
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js 22 or newer is required (https://nodejs.org)." }
$nodeMajor = [int](& node -p "process.versions.node.split('.')[0]")
if ($nodeMajor -lt 22) { Fail "Node.js 22 or newer is required; found $(& node --version)." }

if ($env:HITCH_VERSION) {
  $tag = "v" + $env:HITCH_VERSION.TrimStart("v")
  $refPath = "refs/tags/$tag"; $label = $tag
} else {
  $branch = if ($env:HITCH_REF) { $env:HITCH_REF } else { "main" }
  $refPath = "refs/heads/$branch"; $label = $branch
}
$url = "https://codeload.github.com/$repo/zip/$refPath"

$tmp = Join-Path ([IO.Path]::GetTempPath()) ("hitch-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zip = Join-Path $tmp "hitch.zip"
  if ($env:HITCH_ARCHIVE) {
    if (-not (Test-Path -LiteralPath $env:HITCH_ARCHIVE -PathType Leaf)) { Fail "HITCH_ARCHIVE does not exist: $($env:HITCH_ARCHIVE)" }
    Copy-Item -LiteralPath $env:HITCH_ARCHIVE -Destination $zip
  } else {
    Write-Host "Downloading hitch ($label) from github.com/$repo ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $zip } catch { Fail "download failed: $url" }
  }

  $extract = Join-Path $tmp "src"
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
  $top = Get-ChildItem -LiteralPath $extract -Directory | Select-Object -First 1
  if (-not $top -or -not (Test-Path (Join-Path $top.FullName "bin\hitch.js"))) { Fail "archive does not look like hitch (bin\hitch.js missing)." }

  # Swap the new copy in only after it unpacked cleanly.
  $staging = "$installDir.new"
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $staging
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  foreach ($item in "bin", "src", "package.json", "LICENSE", "README.md", "PRIVACY.md") {
    $from = Join-Path $top.FullName $item
    if (Test-Path -LiteralPath $from) { Copy-Item -Recurse -LiteralPath $from -Destination $staging }
  }
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $installDir
  New-Item -ItemType Directory -Force -Path (Split-Path $installDir) | Out-Null
  Move-Item -LiteralPath $staging -Destination $installDir
} finally {
  Remove-Item -Recurse -Force -ErrorAction SilentlyContinue $tmp
}

New-Item -ItemType Directory -Force -Path $binDir | Out-Null
$launcher = Join-Path $binDir "hitch.cmd"
Set-Content -LiteralPath $launcher -Encoding ASCII -Value "@node `"$installDir\bin\hitch.js`" %*"

$version = & node -p "require(process.argv[1]).version" (Join-Path $installDir "package.json")
Write-Host "Installed hitch $version to $installDir"
Write-Host "Command: $launcher"

$onPath = (Split-PathList $env:Path) | Where-Object { $_.TrimEnd("\") -eq $binDir.TrimEnd("\") }
if ($onPath) {
  Write-Host "Run: hitch"
} elseif ($env:HITCH_NO_PATH -eq "1") {
  Write-Host "$binDir is not on PATH (HITCH_NO_PATH=1). Add it yourself to use 'hitch' anywhere."
} else {
  $userPath = Get-UserPath
  $already = (Split-PathList $userPath) | Where-Object { $_.TrimEnd("\") -eq $binDir.TrimEnd("\") }
  if (-not $already) {
    $newPath = if ($userPath) { "$userPath;$binDir" } else { $binDir }
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
  }
  $env:Path = "$env:Path;$binDir"
  Write-Host "Added $binDir to your user PATH. Open a new terminal, then run: hitch"
  Write-Host "Restart Pi/OMP too if you use `"!hitch key`" references."
}
