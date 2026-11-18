@echo off
title Radar de Preco
cd /d "%~dp0"
echo Iniciando o Radar de Preco...
echo Deixe esta janela aberta: enquanto ela estiver aberta, o app confere os precos sozinho.
echo.
start "" http://localhost:3000
node src\servidor.js
echo.
echo O Radar parou. Se apareceu "EADDRINUSE", ele ja estava aberto em outra janela.
pause
