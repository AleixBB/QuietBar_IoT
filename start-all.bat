@echo off
echo =====================================================================
echo   Iniciant Sistema QuietVenue IoT (Backend + 2 FrontEnds)
echo =====================================================================
echo   - Backend API / WebSockets / MQTT : http://localhost:4000
echo   - FrontEnd 1 (Dashboard del Bar)  : http://localhost:5173
echo   - FrontEnd 2 (Ajuntament Molins)  : http://localhost:5174
echo =====================================================================

start "QuietVenue Backend (Port 4000)" cmd /k "cd /d %~dp0backend && npm start"
timeout /t 2 /nobreak >nul
start "QuietBar FrontEnd 1 - Bar (Port 5173)" cmd /k "cd /d %~dp0frontend-bar && npm run dev"
start "QuietVenue FrontEnd 2 - Ajuntament (Port 5174)" cmd /k "cd /d %~dp0frontend-ajuntament && npm run dev"

echo Tots els serveis s'estan iniciant en finestres separades!
