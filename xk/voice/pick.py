"""定下某人的音色：python pick.py <角色> <编号>，把 candidates/<角色>/<编号>.wav 和文字稿拷成 voices/<角色>.wav / .txt。
也可以不用候选：自己放一段 5–15 秒的干净录音到 voices/<角色>.wav，再把它说的原话写进 voices/<角色>.txt。
改完要重启 start.bat 才生效。"""
import os, shutil, sys
from common import HERE, ROLES, VOICES

if len(sys.argv) != 3 or sys.argv[1] not in ROLES:
    sys.exit(f"用法：python pick.py <{'|'.join(ROLES)}> <编号>")
role, n = sys.argv[1], sys.argv[2]
src = os.path.join(HERE, "candidates", role, n)
if not os.path.exists(src + ".wav"):
    sys.exit(f"没有 {src}.wav：先运行 design.py，或看看编号对不对")
os.makedirs(VOICES, exist_ok=True)
shutil.copy(src + ".wav", os.path.join(VOICES, role + ".wav"))
shutil.copy(src + ".txt", os.path.join(VOICES, role + ".txt"))
print(f"{role} 的音色定成第 {n} 版了。重启 start.bat 生效。")
