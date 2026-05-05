@echo off
setlocal

set ROOT=%~dp0..
set BUILD_ROOT=%ROOT%\desktop_client\build\windows
set DIST_DIR=%ROOT%\desktop_client\dist\windows
set GO_HELPER_BIN=%DIST_DIR%\twoman-helper-agent.exe

if exist "%BUILD_ROOT%" rmdir /s /q "%BUILD_ROOT%"
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
mkdir "%BUILD_ROOT%"
mkdir "%DIST_DIR%"

if "%TWOMAN_WINDOWS_PYTHON%"=="" (
  set TWOMAN_WINDOWS_PYTHON=python
)

%TWOMAN_WINDOWS_PYTHON% -m pip install --upgrade pip wheel >nul
%TWOMAN_WINDOWS_PYTHON% -m pip install -r "%ROOT%\requirements.txt" -r "%ROOT%\desktop_client\requirements.txt" pyinstaller >nul

pushd "%ROOT%\helper-agent"
go build -trimpath -ldflags "-s -w" -o "%GO_HELPER_BIN%" .
popd

%TWOMAN_WINDOWS_PYTHON% -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --name twoman-desktop ^
  --paths "%ROOT%" ^
  --distpath "%DIST_DIR%" ^
  --workpath "%BUILD_ROOT%\work" ^
  --specpath "%BUILD_ROOT%\spec" ^
  "%ROOT%\desktop_client\__main__.py"

echo Built %DIST_DIR%\twoman-desktop.exe and %GO_HELPER_BIN%
