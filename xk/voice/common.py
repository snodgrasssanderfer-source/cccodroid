"""语音服务和造音色脚本共用：模型放在 models/ 下，第一次用时从魔搭（ModelScope）下，国内直连就快。"""
import os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
VOICES = os.path.join(HERE, "voices")
ROLES = ("xiaoke", "hachimi", "deepseek")


def model_dir(name, repo, marker):
    """没下过就从魔搭下到 models/<名字>（marker 是下完才会有的文件，用来认下没下全）"""
    local = os.path.join(MODELS, name)
    if not os.path.exists(os.path.join(local, marker)):
        from modelscope import snapshot_download
        print(f"第一次用 {name}，从魔搭下载（几个 GB，要等一会儿）…", flush=True)
        snapshot_download(repo, local_dir=local)
    return local


def load_voxcpm(name):
    """VoxCPM2 / VoxCPM1.5（造音色用；要另外 pip install voxcpm）"""
    from voxcpm import VoxCPM
    return VoxCPM.from_pretrained(model_dir(name, f"OpenBMB/{name}", "config.json"), load_denoiser=False)


def load_cosyvoice3(repo_dir, fp16):
    """CosyVoice3：代码在 CosyVoice\\（setup.bat 克隆的，不是 pip 包），模型在 models\\Fun-CosyVoice3-0.5B"""
    repo = os.path.join(HERE, repo_dir)
    if not os.path.exists(os.path.join(repo, "cosyvoice")):
        raise FileNotFoundError(f"没有 CosyVoice 的代码（{repo}）：先运行 setup.bat")
    sys.path[:0] = [repo, os.path.join(repo, "third_party", "Matcha-TTS")]
    from cosyvoice.cli.cosyvoice import AutoModel
    return AutoModel(model_dir=model_dir("Fun-CosyVoice3-0.5B", "FunAudioLLM/Fun-CosyVoice3-0.5B-2512", "cosyvoice3.yaml"), fp16=fp16)


def voice(role):
    """她的参考录音和录音里说的原话（voices/<角色>.wav、.txt）"""
    wav, txt = os.path.join(VOICES, role + ".wav"), os.path.join(VOICES, role + ".txt")
    if not (os.path.exists(wav) and os.path.exists(txt)):
        raise LookupError(f"还没给 {role} 放音色：voices\\{role}.wav 和 voices\\{role}.txt（录音和它说的原话）")
    return wav, open(txt, encoding="utf-8").read().strip()


def safe_text(s):
    """开头的英文括号会被 VoxCPM 当声音描述、尖括号方括号会被 CosyVoice 当控制记号：她话里的换成中文的"""
    return s.replace("(", "（").replace(")", "）").replace("<", "〈").replace(">", "〉").replace("[", "【").replace("]", "】").strip()
