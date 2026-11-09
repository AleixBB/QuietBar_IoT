@echo off
echo =====================================================================
echo   Configurant i Iniciant QuietVenue IoT (Equip)
echo =====================================================================

:: Comprovar si cal fer npm install al backend
if not exist "%~dp0backend\node_modules\" (
  echo [1/3] Instal-lant dependencies del Backend...
  cd /d "%~dp0backend"
  call npm install
)

:: Comprovar si cal fer npm install al frontend-bar
if not exist "%~dp0frontend-bar\node_modules\" (
  echo [2/3] Instal-lant dependencies de FrontEnd 1 (Bar)...
  cd /d "%~dp0frontend-bar"
  call npm install
)

:: Comprovar si cal fer npm install al frontend-ajuntament
if not exist "%~dp0frontend-ajuntament\node_modules\" (
  echo [3/3] Instal-lant dependencies de FrontEnd 2 (Ajuntament)...
  cd /d "%~dp0frontend-ajuntament"
  call npm install
)

echo =====================================================================
echo   Totes les dependencies estan a punt! Iniciant servidors...
echo   - Backend API / WebSockets / MQTT : http://localhost:4000
echo   - FrontEnd 1 (Dashboard del Bar)  : http://localhost:5173
echo   - FrontEnd 2 (Ajuntament Molins)  : http://localhost:5174
echo =====================================================================

start "QuietVenue Backend (Port 4000)" cmd /k "cd /d %~dp0backend && npm start"
timeout /t 2 /nobreak >nul
start "QuietBar FrontEnd 1 - Bar (Port 5173)" cmd /k "cd /d %~dp0frontend-bar && npm run dev"
start "QuietVenue FrontEnd 2 - Ajuntament (Port 5174)" cmd /k "cd /d %~dp0frontend-ajuntament && npm run dev"

echo Tot en marxa! Pots tancar aquesta finestra.
pause
