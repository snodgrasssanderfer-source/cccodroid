"""照人设造音色候选：每人念一段试听的话，换几个随机种子各出一版，放在 candidates/<角色>/。
主人听了挑一个，用 pick.py 定下来。用法：python design.py [--n 4] [--roles xiaoke hachimi deepseek]
要 VoxCPM2（能按文字描述造声音，约 8GB 显存：跑之前把游戏、浏览器之类占显存的关掉）。
平时念用的是 CosyVoice3，VoxCPM 只在这里用：先 .venv\\Scripts\\pip install voxcpm（它要的 transformers 可能和 CosyVoice 的不一样，装不上就另建一个环境跑这个脚本）。"""
import argparse, json, os
import soundfile as sf
from common import HERE, ROLES, load_voxcpm, safe_text

ap = argparse.ArgumentParser()
ap.add_argument("--n", type=int, default=4, help="每人出几版")
ap.add_argument("--roles", nargs="*", default=list(ROLES))
a = ap.parse_args()

conf = json.load(open(os.path.join(HERE, "voices.json"), encoding="utf-8"))
model = load_voxcpm("VoxCPM2")
for role in a.roles:
    c = conf[role]
    out = os.path.join(HERE, "candidates", role)
    os.makedirs(out, exist_ok=True)
    for i in range(1, a.n + 1):
        wav = model.generate(text=f"({c['describe']}){safe_text(c['sample'])}", cfg_value=2.0, inference_timesteps=10, seed=i * 7)
        p = os.path.join(out, f"{i}.wav")
        sf.write(p, wav, model.tts_model.sample_rate)
        open(os.path.join(out, f"{i}.txt"), "w", encoding="utf-8").write(c["sample"])
        print(f"{c['name']} 第 {i} 版：{p}", flush=True)
print("都好了。挨个听 candidates 里的，挑中了就运行：python pick.py 角色 编号（比如 python pick.py xiaoke 3）")
