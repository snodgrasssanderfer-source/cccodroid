@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONUTF8=1
title 小克的语音服务
.venv\Scripts\python server.py
pause
