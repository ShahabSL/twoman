@echo off
setlocal

set ROOT=%~dp0..\..
set APP_ROOT=%ROOT%\desktop_app
set BUILD_ROOT=%APP_ROOT%\build\windows-sidecars
set DIST_DIR=%APP_ROOT%\src-tauri\resources\sidecars\windows
set STAGE_DIR=%BUILD_ROOT%\dist
set TUNNEL_DIR=%BUILD_ROOT%\tunnel
if "%TWOMAN_HELPER_BINARY_BASENAME%"=="" set TWOMAN_HELPER_BINARY_BASENAME=twoman-helper
if "%TWOMAN_GATEWAY_BINARY_BASENAME%"=="" set TWOMAN_GATEWAY_BINARY_BASENAME=twoman-gateway
if "%TWOMAN_TUNNEL_BINARY_BASENAME%"=="" set TWOMAN_TUNNEL_BINARY_BASENAME=twoman-tunnel
if "%TWOMAN_PRODUCT_VERSION%"=="" (
  for /f "usebackq delims=" %%v in ("%ROOT%\VERSION") do (
    set TWOMAN_PRODUCT_VERSION=%%v
    goto :twoman_version_read
  )
)
:twoman_version_read
if "%TWOMAN_PRODUCT_VERSION%"=="" set TWOMAN_PRODUCT_VERSION=dev
if "%TWOMAN_BUILD_COMMIT%"=="" (
  for /f %%c in ('git -C "%ROOT%" rev-parse --short=12 HEAD 2^>nul') do set TWOMAN_BUILD_COMMIT=%%c
)
if "%TWOMAN_BUILD_COMMIT%"=="" set TWOMAN_BUILD_COMMIT=unknown
if "%TWOMAN_BUILD_TIME%"=="" (
  for /f %%t in ('powershell -NoProfile -Command "Get-Date -AsUTC -Format yyyy-MM-ddTHH:mm:ssZ"') do set TWOMAN_BUILD_TIME=%%t
)
if "%TWOMAN_BUILD_TIME%"=="" set TWOMAN_BUILD_TIME=unknown

if exist "%BUILD_ROOT%" rmdir /s /q "%BUILD_ROOT%"
mkdir "%BUILD_ROOT%"
mkdir "%DIST_DIR%" 2>nul
mkdir "%STAGE_DIR%"
mkdir "%TUNNEL_DIR%"

if not "%TWOMAN_PREBUILT_HELPER_EXE%"=="" (
  if not exist "%TWOMAN_PREBUILT_HELPER_EXE%" (
    echo TWOMAN_PREBUILT_HELPER_EXE does not exist: %TWOMAN_PREBUILT_HELPER_EXE%
    exit /b 1
  )
  copy /Y "%TWOMAN_PREBUILT_HELPER_EXE%" "%DIST_DIR%\%TWOMAN_HELPER_BINARY_BASENAME%.exe" >nul
) else (
  where go >nul 2>nul
  if errorlevel 1 (
    if exist "%DIST_DIR%\%TWOMAN_HELPER_BINARY_BASENAME%.exe" (
      echo Reusing existing Twoman Go helper sidecar: %DIST_DIR%\%TWOMAN_HELPER_BINARY_BASENAME%.exe
    ) else (
      echo go is required to build the Twoman Go helper sidecar
      exit /b 1
    )
  ) else (
    pushd "%ROOT%\helper-agent"
    go build -trimpath -ldflags "-s -w -X main.version=%TWOMAN_PRODUCT_VERSION% -X main.commit=%TWOMAN_BUILD_COMMIT% -X main.buildTime=%TWOMAN_BUILD_TIME%" -o "%DIST_DIR%\%TWOMAN_HELPER_BINARY_BASENAME%.exe" .
    if errorlevel 1 exit /b 1
    popd
  )
)

if "%TWOMAN_WINDOWS_PYTHON%"=="" (
  set TWOMAN_WINDOWS_PYTHON=py -3
)

%TWOMAN_WINDOWS_PYTHON% -m pip install --upgrade pip wheel >nul
%TWOMAN_WINDOWS_PYTHON% -m pip install -r "%ROOT%\requirements.txt" pyinstaller >nul

%TWOMAN_WINDOWS_PYTHON% -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --noconsole ^
  --name %TWOMAN_GATEWAY_BINARY_BASENAME% ^
  --paths "%ROOT%" ^
  --distpath "%STAGE_DIR%" ^
  --workpath "%BUILD_ROOT%\work-gateway" ^
  --specpath "%BUILD_ROOT%\spec-gateway" ^
  "%ROOT%\desktop_client\socks_gateway.py"

copy /Y "%STAGE_DIR%\%TWOMAN_GATEWAY_BINARY_BASENAME%.exe" "%DIST_DIR%\%TWOMAN_GATEWAY_BINARY_BASENAME%.exe" >nul

if "%TWOMAN_SING_BOX_URL%"=="" (
  set TWOMAN_SING_BOX_URL=https://github.com/SagerNet/sing-box/releases/download/v1.12.12/sing-box-1.12.12-windows-amd64.zip
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ProgressPreference='SilentlyContinue';" ^
  "$zip='%TUNNEL_DIR%\sing-box.zip';" ^
  "$extract='%TUNNEL_DIR%\extract';" ^
  "New-Item -ItemType Directory -Force -Path '%TUNNEL_DIR%' | Out-Null;" ^
  "Invoke-WebRequest -Uri '%TWOMAN_SING_BOX_URL%' -OutFile $zip;" ^
  "if (Test-Path $extract) { Remove-Item -Recurse -Force $extract };" ^
  "Expand-Archive -Path $zip -DestinationPath $extract -Force;" ^
  "$exe=Get-ChildItem -Path $extract -Filter sing-box.exe -Recurse | Select-Object -First 1;" ^
  "if (-not $exe) { throw 'sing-box.exe not found in archive' };" ^
  "Copy-Item -Force $exe.FullName '%DIST_DIR%\%TWOMAN_TUNNEL_BINARY_BASENAME%.exe';"

if errorlevel 1 exit /b 1

echo Built Windows sidecars in %DIST_DIR%
