@echo off
rem First-time setup. Fill in server\.env first (copy server\.env.example).
setlocal
if not exist "%~dp0server\.env" (
  echo server\.env is missing. Copy server\.env.example to server\.env and fill it in, then run this again.
  exit /b 1
)
cd /d "%~dp0server" || exit /b 1
call npm install || exit /b 1
call npx prisma db push || exit /b 1
call npm run seed || exit /b 1
cd /d "%~dp0client" || exit /b 1
call npm install || exit /b 1
echo.
echo Setup finished. Start the API with dev-api.cmd and the app with dev-web.cmd.
