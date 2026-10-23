@echo off
rem Starts Saara's laptop server and the Cloudflare tunnel, each in its own window.
rem Keep both windows open. The tunnel window prints the address to put in Sarvam's tool URL (add /action).
start "Saara server" /D "%~dp0saara" cmd /k npm start
timeout /t 3 /nobreak >nul
start "Saara tunnel" cmd /k ""C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3710"
start "" http://localhost:3710
