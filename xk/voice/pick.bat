@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONUTF8=1
set /p ROLE=给谁定音色（xiaoke / hachimi / deepseek）：
set /p N=第几版：
.venv\Scripts\python pick.py %ROLE% %N%
pause
