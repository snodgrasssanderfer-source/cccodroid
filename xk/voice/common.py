"""语音服务和造音色脚本共用：模型放在 models/ 下，第一次用时从魔搭（ModelScope）下，国内直连就快。"""
import os

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
    """VoxCPM2（只有 design.py 造音色用；要另外 pip install voxcpm）"""
    from voxcpm import VoxCPM
    return VoxCPM.from_pretrained(model_dir(name, f"OpenBMB/{name}", "config.json"), load_denoiser=False)


def voice(role):
    """她的参考录音和录音里说的原话（voices/<角色>.wav、.txt）"""
    wav, txt = os.path.join(VOICES, role + ".wav"), os.path.join(VOICES, role + ".txt")
    if not (os.path.exists(wav) and os.path.exists(txt)):
        raise LookupError(f"还没给 {role} 放音色：voices\\{role}.wav 和 voices\\{role}.txt（3–10 秒的录音和它说的原话）")
    return wav, open(txt, encoding="utf-8").read().strip()


def safe_text(s):
    """她话里的英文括号、尖括号、方括号换成中文的：有的模型会把它们当成控制记号"""
    return s.replace("(", "（").replace(")", "）").replace("<", "〈").replace(">", "〉").replace("[", "【").replace("]", "】").strip()
