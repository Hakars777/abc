@echo off
setlocal

cd /d "%~dp0"
set "ROOT=%cd%"
set "TOOLS=%ROOT%\.tools"
set "NODE_DIR=%TOOLS%\node"

rem Detect real OS architecture even if this .bat runs under 32-bit cmd.exe
set "ARCH=%PROCESSOR_ARCHITECTURE%"
if defined PROCESSOR_ARCHITEW6432 set "ARCH=%PROCESSOR_ARCHITEW6432%"

set "NODE_PLATFORM="
if /I "%ARCH%"=="AMD64" set "NODE_PLATFORM=win-x64"
if /I "%ARCH%"=="ARM64" set "NODE_PLATFORM=win-arm64"
if /I "%ARCH%"=="x86" set "NODE_PLATFORM=win-x86"

echo.
echo Local Soundsnap-like

rem Prefer local portable Node.js if present
if exist "%NODE_DIR%\node.exe" (
  set "PATH=%NODE_DIR%;%PATH%"
  goto have_node
)

rem Bootstrap portable Node.js into .tools\node (so the whole app is removable)
echo.
echo Installing portable Node.js LTS into .tools\node ...
call :install_node
if not errorlevel 1 (
  set "PATH=%NODE_DIR%;%PATH%"
  goto have_node
)

echo.
echo WARNING: Portable Node.js install failed. Trying system Node.js from PATH...
where node >nul 2>nul
if not errorlevel 1 goto have_node

echo.
echo ERROR: Node.js is not available.
echo Install Node.js 18+ system-wide OR ensure internet access so this script can download a portable build.
echo.
pause
exit /b 1

:have_node
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: node is not available.
  pause
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: npm is not available.
  pause
  exit /b 1
)

rem Keep npm cache inside the project so removing the folder cleans everything
set "npm_config_cache=%TOOLS%\npm-cache"

if not exist "node_modules\" (
  echo.
  echo Installing dependencies...
  npm install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Starting server on http://localhost:3000
npm start

echo.
pause
exit /b 0

:install_node
if "%NODE_PLATFORM%"=="" (
  echo ERROR: Unsupported architecture: %ARCH%
  exit /b 1
)

if not exist "%TOOLS%" mkdir "%TOOLS%" >nul 2>nul

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; try { try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {} ; $nodeDir=$env:NODE_DIR; $tools=Split-Path -Parent $nodeDir; $platform=$env:NODE_PLATFORM; if (-not $nodeDir -or -not $tools -or -not $platform) { throw 'Missing env vars' } ; New-Item -ItemType Directory -Force -Path $tools | Out-Null; $index=Invoke-RestMethod 'https://nodejs.org/dist/index.json'; $ver=($index | Where-Object { $_.lts -ne $false } | Select-Object -First 1).version; if (-not $ver) { throw 'Could not determine latest LTS version' } ; $zipName=('node-' + $ver + '-' + $platform + '.zip'); $url=('https://nodejs.org/dist/' + $ver + '/' + $zipName); $tmp=Join-Path $env:TEMP $zipName; if (Test-Path $tmp) { Remove-Item $tmp -Force }; Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing; if (Test-Path $nodeDir) { Remove-Item $nodeDir -Recurse -Force }; Expand-Archive -Path $tmp -DestinationPath $tools -Force; $extracted=Join-Path $tools ('node-' + $ver + '-' + $platform); if (-not (Test-Path $extracted)) { throw ('Extracted folder not found: ' + $extracted) }; Move-Item -Path $extracted -Destination $nodeDir -Force; Remove-Item $tmp -Force; Write-Host ('Installed Node.js ' + $ver + ' to ' + $nodeDir) } catch { Write-Host ('Install error: ' + $_.Exception.Message); exit 1 }"

exit /b %errorlevel%
