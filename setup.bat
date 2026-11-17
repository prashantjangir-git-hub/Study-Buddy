@echo off
setlocal
cd /d "%~dp0"
echo.
echo  Setting up Study Buddy
echo  ======================

python --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Python isn't installed. Get Python 3.12 from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH" in the installer. Then run setup.bat again.
  pause
  exit /b 1
)

if not exist ".venv" (
  echo.
  echo  Creating a virtual environment...
  python -m venv .venv || (echo  Couldn't create the virtual environment. & pause & exit /b 1)
)
call ".venv\Scripts\activate.bat"

echo.
echo  Installing Python packages (this takes a few minutes the first time)...
python -m pip install --upgrade pip >nul
pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo  Some packages failed to install. See the error above.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul

where ollama >nul 2>&1
if errorlevel 1 (
  echo.
  echo  Ollama isn't installed yet. Download it from https://ollama.com/download
  echo  then run:  .venv\Scripts\python pull_models.py
) else (
  echo.
  echo  Downloading the local AI models, several GB, one time only...
  python pull_models.py
)

echo.
echo  Done. Double-click start.bat to open Study Buddy.
pause
