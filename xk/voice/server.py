"""小克的语音服务，跑在主人电脑上（设计稿 xk/design/presence.md 第五节）：
  念：POST /tts {role, text} → WAV。VoxCPM 照 voices/<角色>.wav（和 .txt 里它说的原话）的音色念。
  听：POST /asr（请求体是 16kHz 单声道 WAV）→ {text}。SenseVoice，默认在 CPU 上跑，省显存给念。
  GET /health → 模型、哪几个人挑好了音色。
平板在家里 Wi‑Fi 里自己找到它（mDNS _xkvoice._tcp），请求头 x-xk-code 带配对码（第一次运行时生成，存在 config.json）。
平板不开 VPN，所以不经手机、直接连这里。用法：python server.py（或双击 start.bat）。
"""
import io, json, os, secrets, socket, tempfile, threading, time, traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf

from common import HERE, ROLES, VOICES, load_tts, safe_text

CONF = os.path.join(HERE, "config.json")


def load_conf():
    c = {"port": 8790, "tts_model": "VoxCPM1.5", "asr_device": "cpu", "code": ""}
    if os.path.exists(CONF):
        c.update(json.load(open(CONF, encoding="utf-8")))
    if not c["code"]:
        c["code"] = "".join(secrets.choice("23456789ABCDEFGHJKMNPQRSTUVWXYZ") for _ in range(8))
    json.dump(c, open(CONF, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return c


C = load_conf()
GPU = threading.Lock()   # 一次只念一句：显存就这么多


class Tts:
    def __init__(self, name):
        self.name, self.v2 = name, name.startswith("VoxCPM2")
        self.m = load_tts(name)
        self.rate = self.m.tts_model.sample_rate

    def voice(self, role):
        wav, txt = os.path.join(VOICES, role + ".wav"), os.path.join(VOICES, role + ".txt")
        if not (os.path.exists(wav) and os.path.exists(txt)):
            raise LookupError(f"还没给 {role} 挑音色：先运行 design.py 再 pick.py")
        return wav, open(txt, encoding="utf-8").read().strip()

    def say(self, role, text):
        wav, said = self.voice(role)
        kw = dict(text=safe_text(text), prompt_wav_path=wav, prompt_text=said, cfg_value=2.0, inference_timesteps=10)
        if self.v2:
            kw["reference_wav_path"] = wav   # VoxCPM2 才有：音色更像
        with GPU:
            out = self.m.generate(**kw)
        buf = io.BytesIO()
        sf.write(buf, out, self.rate, format="WAV", subtype="PCM_16")
        return buf.getvalue()


class Asr:
    def __init__(self, device):
        from funasr import AutoModel
        from funasr.utils.postprocess_utils import rich_transcription_postprocess
        self.post = rich_transcription_postprocess
        self.m = AutoModel(model="iic/SenseVoiceSmall", vad_model="fsmn-vad", device=device, disable_update=True)

    def hear(self, wav_bytes):
        f = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
        try:
            f.write(wav_bytes); f.close()
            res = self.m.generate(input=f.name, cache={}, language="auto", use_itn=True, batch_size_s=60, merge_vad=True)
            return "".join(self.post(r["text"]) for r in res).strip()
        finally:
            os.unlink(f.name)


class H(BaseHTTPRequestHandler):
    def send(self, code, body, kind="application/json; charset=utf-8"):
        if not isinstance(body, bytes):
            body = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("content-type", kind)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def body(self):
        return self.rfile.read(int(self.headers.get("content-length") or 0))

    def handle_one(self):
        if self.headers.get("x-xk-code", "").strip().upper() != C["code"]:
            return self.send(401, {"error": "配对码不对：看电脑上语音服务窗口里显示的那个"})
        if self.command == "GET" and self.path == "/health":
            return self.send(200, {"name": "xkvoice", "tts": TTS.name, "asr": True,
                                   "voices": [r for r in ROLES if os.path.exists(os.path.join(VOICES, r + ".wav"))]})
        if self.command == "POST" and self.path == "/tts":
            q = json.loads(self.body() or b"{}")
            if q.get("role") not in ROLES or not str(q.get("text", "")).strip():
                return self.send(400, {"error": "要 role（xiaoke/hachimi/deepseek）和 text"})
            t = time.time()
            wav = TTS.say(q["role"], str(q["text"]))
            print(f"念 {q['role']}：{len(q['text'])} 字，{time.time() - t:.1f} 秒", flush=True)
            return self.send(200, wav, "audio/wav")
        if self.command == "POST" and self.path == "/asr":
            text = ASR.hear(self.body())
            print(f"听到：{text}", flush=True)
            return self.send(200, {"text": text})
        return self.send(404, {"error": "没有这个接口"})

    def run(self):
        try:
            self.handle_one()
        except LookupError as e:
            self.send(409, {"error": str(e)})
        except Exception as e:
            traceback.print_exc()
            self.send(500, {"error": f"{type(e).__name__}: {e}"})

    do_GET = do_POST = run

    def log_message(self, *a):
        pass


def lan_addrs():
    import ifaddr
    return [ip.ip for ad in ifaddr.get_adapters() for ip in ad.ips
            if isinstance(ip.ip, str) and not ip.ip.startswith(("127.", "169.254."))]


def advertise(port, addrs):
    """家里 Wi‑Fi 里报一声「这里有语音服务」，平板不用填地址"""
    from zeroconf import ServiceInfo, Zeroconf
    zc = Zeroconf()
    info = ServiceInfo("_xkvoice._tcp.local.", "xkvoice._xkvoice._tcp.local.", port=port,
                       addresses=[socket.inet_aton(a) for a in addrs], properties={"v": "1"})
    zc.register_service(info, allow_name_change=True)
    return zc


if __name__ == "__main__":
    print(f"加载念的模型 {C['tts_model']}…", flush=True)
    TTS = Tts(C["tts_model"])
    print(f"加载听的模型 SenseVoice（{C['asr_device']}）…", flush=True)
    ASR = Asr(C["asr_device"])
    addrs = lan_addrs()
    zc = advertise(C["port"], addrs)
    srv = ThreadingHTTPServer(("0.0.0.0", C["port"]), H)
    have = [r for r in ROLES if os.path.exists(os.path.join(VOICES, r + ".wav"))]
    print("\n语音服务开好了。", flush=True)
    print(f"  配对码：{C['code']}（在平板「小克 · 平板」里填一次）", flush=True)
    port = C["port"]
    print(f"  地址：{'、'.join(f'{a}:{port}' for a in addrs)}", flush=True)
    print(f"  挑好音色的：{'、'.join(have) or '还没有（先 design.py 再 pick.py）'}", flush=True)
    print("  关掉这个窗口就停了。\n", flush=True)
    try:
        srv.serve_forever()
    finally:
        zc.close()
