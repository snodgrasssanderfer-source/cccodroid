@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONUTF8=1
rem 国内下得慢的话，把下一行开头的 rem 删掉，用阿里的镜像
rem set PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
rem 这里只装「听」（SenseVoice，CPU 上跑）和转发；念的 GPT-SoVITS 用它自己的整合包，见 README
where py >nul 2>nul || (echo 先装 Python 3.10 或 3.11：https://www.python.org/downloads/ ，安装时勾上 Add python.exe to PATH & pause & exit /b 1)
if not exist .venv (py -3.10 -m venv .venv || py -3.11 -m venv .venv || (echo 没找到 Python 3.10 或 3.11 & pause & exit /b 1))
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu || goto :fail
.venv\Scripts\python -m pip install -r requirements.txt || goto :fail
echo.
echo 装好了。下一步：装 GPT-SoVITS 整合包、放好三个人的参考录音（见 README），再双击 start.bat。
pause
exit /b 0
:fail
echo 装的时候出错了，把上面的报错截图发给云端。
pause
exit /b 1
