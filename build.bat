@echo off
rem Builds the app into server\public and compiles the server into server\dist.
setlocal
cd /d "%~dp0client" || exit /b 1
call npm run build || exit /b 1
cd /d "%~dp0server" || exit /b 1
call npm run build || exit /b 1
echo.
echo Built. Start it with:  cd server ^&^& npm start
