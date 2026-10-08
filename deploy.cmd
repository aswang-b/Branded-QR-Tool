@echo off
rem Pull the latest Branded QR changes and deploy to Cloudflare.
cd /d "%~dp0"
echo === Pulling latest changes ===
set STASHED=0
git diff --quiet
if errorlevel 1 (
  echo Local edits found ^(e.g. wrangler wrote the database id^) - setting them aside...
  git stash push -m "deploy.cmd auto-stash" || goto :fail
  set STASHED=1
)
git pull || goto :fail
if "%STASHED%"=="1" (
  git stash pop || goto :fail
)
echo.
echo === Deploying ===
call npm run deploy || goto :fail
echo.
echo Done. Open https://qr.dancewithb.fun/links.html (the certificate can take a few minutes).
pause
exit /b 0
:fail
echo.
echo Something failed - copy the messages above and paste them to Claude.
pause
exit /b 1
