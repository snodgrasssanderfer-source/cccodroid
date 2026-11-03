@echo off
chcp 65001 >nul
cd /d %~dp0
set PYTHONUTF8=1
rem 国内下得慢的话，把下一行开头的 rem 删掉，用阿里的镜像
rem set PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/
where git >nul 2>nul || (echo 先装 Git：https://git-scm.com/download/win & pause & exit /b 1)
where py >nul 2>nul || (echo 先装 Python 3.10：https://www.python.org/downloads/ ，安装时勾上 Add python.exe to PATH & pause & exit /b 1)
if not exist .venv (py -3.10 -m venv .venv || (echo 没找到 Python 3.10，CosyVoice 官方用的是 3.10，装好再来 & pause & exit /b 1))
if not exist CosyVoice\cosyvoice (git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git || goto :fail)
git -C CosyVoice submodule update --init --recursive || goto :fail
.venv\Scripts\python -m pip install -U pip
.venv\Scripts\python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128 || goto :fail
.venv\Scripts\python cosyreq.py || goto :fail
.venv\Scripts\python -m pip install -r cosyvoice-req.txt || goto :fail
.venv\Scripts\python -m pip install -r requirements.txt || goto :fail
.venv\Scripts\python -c "import torch; print('显卡：', torch.cuda.get_device_name(0) if torch.cuda.is_available() else '没认到显卡，显卡驱动要更新到最新')"
echo.
echo 装好了。把三个人的参考录音放进 voices（见 README），再双击 start.bat。
pause
exit /b 0
:fail
echo 装的时候出错了，把上面的报错截图发给云端。
pause
exit /b 1
