"""小克的语音服务，跑在主人电脑上（设计稿 xk/design/presence.md 第五节）：
  念：POST /tts {role, text} → WAV。交给 GPT-SoVITS（它自己的整合包、单独的进程），照 voices/<角色>.wav（和 .txt 里它说的原话）的音色念。
  听：POST /asr（请求体是 16kHz 单声道 WAV）→ {text}。SenseVoice，默认在 CPU 上跑，省显存给念。
  GET /health → 模型、哪几个人挑好了音色。
平板在家里 Wi‑Fi 里自己找到它（mDNS _xkvoice._tcp），请求头 x-xk-code 带配对码（第一次运行时生成，存在 config.json）。
平板不开 VPN，所以不经手机、直接连这里。用法：python server.py（或双击 start.bat）。
"""
import io, json, os, secrets, socket, tempfile, threading, time, traceback, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import soundfile as sf

from mandarin_phrasing import spoken_text
from mandarin_rhythm import adjust_audio
from common import HERE, ROLES, VOICES, safe_text, voice

CONF = os.path.join(HERE, "config.json")


def load_conf():
    # 念：GPT-SoVITS 的接口地址；gsv_dir 填整合包的位置就由这里顺手起它；gsv_config 是它自己的配置（版本、显卡、半精度在那里改）；
    # gsv_base_* 是底模权重（有人训练过、要来回换时才用得上）；gsv_extra 原样加进每次请求（语速 speed_factor 之类）
    # relay_port：手机和平板之间的中转（relay.py），手机平板互相连不上时走这里
    c = {"port": 8790, "relay_port": 8791, "gsv_url": "http://127.0.0.1:9880", "gsv_dir": "", "gsv_config": "GPT_SoVITS/configs/tts_infer.yaml",
         "gsv_base_gpt": "", "gsv_base_sovits": "", "gsv_extra": {}, "asr_device": "cpu", "code": "",
         # 每人一份的调音（主人电脑上的 Codex 和主人一起调的）：gsv_by_role 叠在 gsv_extra 上；gsv_phrasing 见 mandarin_phrasing.py；
         # gsv_rhythm 见 mandarin_rhythm.py，tempo / equalizer 要 ffmpeg
         "gsv_by_role": {}, "gsv_phrasing": {}, "gsv_rhythm": {}, "ffmpeg": "tools/ffmpeg/bin/ffmpeg.exe",
         # 谁的声音接入平板：null＝放好音色的都接；写成名单就只接名单里的（主人 11-04：先只接哈基米，另两位训练到满意再加）
         "tts_roles": None}
    if os.path.exists(CONF):
        c.update(json.load(open(CONF, encoding="utf-8")))
    if not c["code"]:
        # 只在第一次生成配对码时写回去：别的默认值留在内存里，不改动主人和 Codex 调好的 config.json
        c["code"] = "".join(secrets.choice("23456789ABCDEFGHJKMNPQRSTUVWXYZ") for _ in range(8))
        own = json.load(open(CONF, encoding="utf-8")) if os.path.exists(CONF) else {}
        json.dump({**own, "code": c["code"]}, open(CONF, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
    return c


C = load_conf()


def ready():
    """接入平板的人：放好了音色，而且在 tts_roles 名单里（没写名单就都算）"""
    return [r for r in ROLES if os.path.exists(os.path.join(VOICES, r + ".wav")) and (C["tts_roles"] is None or r in C["tts_roles"])]
GPU = threading.Lock()   # 一次只念一句：显存就这么多


def wav_bytes(samples, rate):
    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
    return buf.getvalue()


class GsvTts:
    """GPT-SoVITS：它用自己的整合包单独跑（api_v2.py，默认 127.0.0.1:9880），这里把每句话交给它的 /tts。
    每人一段参考录音 voices/<角色>.wav（3–10 秒）和原话 .txt；给谁训练过，就把她的 voices/<角色>.ckpt（GPT）和
    voices/<角色>.pth（SoVITS）放进去，轮到她说话时先换上她的权重，没有就用整合包默认的底模直接克隆。"""
    def __init__(self):
        self.name, self.url = "GPT-SoVITS", C["gsv_url"].rstrip("/")
        self.loaded = None   # 现在装着谁的权重（None＝底模）
        self.proc = None
        if C["gsv_dir"]:
            self.start()

    def start(self):
        """config.json 写了整合包的位置，就顺手把它的接口起起来，等它加载完"""
        import subprocess
        d = C["gsv_dir"]
        py = os.path.join(d, "runtime", "python.exe")
        port = C["gsv_url"].rsplit(":", 1)[1].split("/")[0]
        self.proc = subprocess.Popen([py if os.path.exists(py) else "python", "api_v2.py", "-a", "127.0.0.1", "-p", port, "-c", C["gsv_config"]], cwd=d)
        for _ in range(300):
            if self.proc.poll() is not None:
                raise RuntimeError(f"GPT-SoVITS 的接口没起来（退出码 {self.proc.returncode}），看上面它自己的报错")
            try:
                urllib.request.urlopen(self.url + "/control", timeout=2)
            except urllib.error.HTTPError:
                return   # 有回应（哪怕是参数不对）就是起来了
            except OSError:
                time.sleep(1)
                continue
            return
        raise RuntimeError("GPT-SoVITS 的接口 5 分钟还没起来")

    def get(self, path, q=None, body=None):
        url = self.url + path + ("?" + urllib.parse.urlencode(q) if q else "")
        req = urllib.request.Request(url, data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers={"content-type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"GPT-SoVITS 说：{e.read().decode('utf-8', 'replace')}") from e

    def weights(self, role):
        """她有自己训练的权重就换上；没有就回到底模（底模路径照 config.json）"""
        ckpt, pth = (os.path.join(VOICES, role + x) for x in (".ckpt", ".pth"))
        want = role if os.path.exists(ckpt) and os.path.exists(pth) else None
        if want == self.loaded:
            return
        g, s = (ckpt, pth) if want else (C["gsv_base_gpt"], C["gsv_base_sovits"])
        if not (g and s):
            raise RuntimeError(f"现在装着 {self.loaded} 训练的权重，{role} 没训练过，要换回底模：在 config.json 填 gsv_base_gpt 和 gsv_base_sovits")
        self.get("/set_gpt_weights", {"weights_path": g})
        self.get("/set_sovits_weights", {"weights_path": s})
        self.loaded = want

    def say(self, role, text):
        wav, said = voice(role)
        body = {"text": spoken_text(safe_text(text), C["gsv_phrasing"].get(role)), "text_lang": "zh", "ref_audio_path": wav,
                "prompt_text": said, "prompt_lang": "zh", "text_split_method": "cut5", "batch_size": 1, "media_type": "wav",
                "streaming_mode": False, **C["gsv_extra"], **C["gsv_by_role"].get(role, {})}
        with GPU:
            self.weights(role)
            raw = self.get("/tts", body=body)
        rhythm = C["gsv_rhythm"].get(role)
        return adjust_audio(raw, rhythm, os.path.join(HERE, C["ffmpeg"])) if rhythm else raw


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
            return self.send(200, {"name": "xkvoice", "tts": TTS.name, "asr": True, "relay": C["relay_port"],
                                   "voices": ready()})
        if self.command == "POST" and self.path == "/tts":
            q = json.loads(self.body() or b"{}")
            if q.get("role") not in ROLES or not str(q.get("text", "")).strip():
                return self.send(400, {"error": "要 role（xiaoke/hachimi/deepseek）和 text"})
            if q["role"] not in ready():
                return self.send(409, {"error": f"{q['role']} 的声音还没接入（config.json 的 tts_roles）"})
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


def advertise(port, relay_port, addrs):
    """局域网里报一声：这里有语音服务（平板找）、这里有中转（手机找，和平板 App 报的是同一种，手机分不出也不用分）"""
    from zeroconf import ServiceInfo, Zeroconf
    zc = Zeroconf()
    for kind, name, p in (("_xkvoice._tcp.local.", "xkvoice", port), ("_xkpadc._tcp.local.", "xkrelay", relay_port)):
        zc.register_service(ServiceInfo(kind, f"{name}.{kind}", port=p, addresses=[socket.inet_aton(a) for a in addrs],
                                        properties={"v": "1"}), allow_name_change=True)
    return zc


if __name__ == "__main__":
    print("连 GPT-SoVITS…" + ("（顺手起它的接口，等它加载完）" if C["gsv_dir"] else f"（{C['gsv_url']}，要先开着它的 api_v2.py）"), flush=True)
    TTS = GsvTts()
    print(f"加载听的模型 SenseVoice（{C['asr_device']}）…", flush=True)
    ASR = Asr(C["asr_device"])
    addrs = lan_addrs()
    from relay import Relay
    Relay(C["relay_port"])
    zc = advertise(C["port"], C["relay_port"], addrs)
    srv = ThreadingHTTPServer(("0.0.0.0", C["port"]), H)
    have = ready()
    print("\n语音服务开好了。", flush=True)
    print(f"  配对码：{C['code']}（在平板「小克 · 平板」里填一次）", flush=True)
    port = C["port"]
    print(f"  地址：{'、'.join(f'{a}:{port}' for a in addrs)}（手机和平板的中转在 {C['relay_port']}）", flush=True)
    none = "还没有（把录音和它说的原话放进 voices 文件夹，见 README）"
    print(f"  接入平板的声音：{'、'.join(have) or none}" + (f"（名单 tts_roles：{'、'.join(C['tts_roles'])}）" if C["tts_roles"] is not None else ""), flush=True)
    print("  关掉这个窗口就停了。\n", flush=True)
    try:
        srv.serve_forever()
    finally:
        zc.close()
        if TTS.proc:
            TTS.proc.terminate()
