@echo off
rem Abre a tela da ponte do Radar (liga a ponte se ela ainda nao estiver rodando).
cd /d "%~dp0"
powershell -NoProfile -Command "if (-not (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue)) { exit 1 }"
if errorlevel 1 (
  wscript "%~dp0scripts\iniciar-ponte.vbs"
  timeout /t 3 /nobreak >nul
)
start "" http://localhost:3001
