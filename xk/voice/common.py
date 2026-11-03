"""语音服务和造音色脚本共用：模型放在 models/ 下，第一次用时从魔搭（ModelScope）下，国内直连就快。"""
import os

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(HERE, "models")
VOICES = os.path.join(HERE, "voices")
ROLES = ("xiaoke", "hachimi", "deepseek")


def model_dir(name):
    """VoxCPM2 / VoxCPM1.5：没下过就从魔搭下到 models/<名字>"""
    local = os.path.join(MODELS, name)
    if not os.path.exists(os.path.join(local, "config.json")):
        from modelscope import snapshot_download
        print(f"第一次用 {name}，从魔搭下载（几个 GB，要等一会儿）…", flush=True)
        snapshot_download(f"OpenBMB/{name}", local_dir=local)
    return local


def load_tts(name):
    from voxcpm import VoxCPM
    return VoxCPM.from_pretrained(model_dir(name), load_denoiser=False)


def safe_text(s):
    """VoxCPM 把开头英文括号里的话当声音描述：她说的话里的括号换成中文括号，免得被当成指令"""
    return s.replace("(", "（").replace(")", "）").strip()
