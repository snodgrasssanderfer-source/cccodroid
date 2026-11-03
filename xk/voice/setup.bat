@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONUTF8=1
rem 国内下得慢的话，把下一行开头的 rem 删掉，用清华的镜像
rem set PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
where py >nul 2>nul || (echo 先装 Python 3.11：https://www.python.org/downloads/ ，安装时勾上 Add python.exe to PATH & pause & exit /b 1)
if not exist .venv (py -3.11 -m venv .venv || (echo 没找到 Python 3.11，装好再来 & pause & exit /b 1))
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :fail
.venv\Scripts\python -m pip install -r requirements.txt || goto :fail
.venv\Scripts\python -c "import torch; print('显卡：', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '没认到显卡，显卡驱动要更新到最新')"
echo.
echo 装好了。下一步：双击 design.bat 造音色候选。
pause
exit /b 0
:fail
echo 装的时候出错了，把上面的报错截图发给云端。
pause
exit /b 1
