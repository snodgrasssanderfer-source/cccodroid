"""从 CosyVoice 自带的 requirements.txt 里去掉装不上或会坏事的几行，写成 cosyvoice-req.txt 给 setup.bat 装：
torch / torchaudio 锁在 2.3.1（不认 RTX 50 系，setup.bat 先单独装 CUDA 12.8 版的）；deepspeed、tensorrt、onnxruntime-gpu 只有 Linux 用；
额外的下载源指向 cu121。"""
import os, re
from common import HERE

src = open(os.path.join(HERE, "CosyVoice", "requirements.txt"), encoding="utf-8").read().splitlines()
drop = re.compile(r"^\s*(--extra-index-url|torch==|torchaudio==|deepspeed|tensorrt|onnxruntime-gpu)")
keep = [l for l in src if l.strip() and not drop.match(l)]
open(os.path.join(HERE, "cosyvoice-req.txt"), "w", encoding="utf-8").write("\n".join(keep) + "\n")
print(f"CosyVoice 的依赖：留下 {len(keep)} 行，去掉了 {len([l for l in src if drop.match(l)])} 行")
