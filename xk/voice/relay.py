"""手机和平板之间的中转（主人 11-04：电脑开热点、手机平板都连在上面时，两台互相连不上，可两台都连得到电脑）。
手机那头和平板 App 的 PadHub 一样（xk/pad/java/cc/codroid/pad/PadHub.java）：手机找到 _xkpadc._tcp 就连过来挂控制线
（写 XKREV → 这里回 OK → 两边每 15 秒互发 p），这里要一条连接就在控制线上写 c，手机连回来一条（先写 XKDATA）。
平板那头：XKSTAT <配对码> → 回 1（手机挂着）或 0；XKWANT <配对码> → 叫手机连回来一条，回 OK 后两条接上，之后就是平板和手机网关之间的字节。
这里只搬字节：加密在平板和手机网关两头，看不到也改不了内容。
"""
import queue, socket, threading


def readline(s):
    b = b""
    while not b.endswith(b"\n"):
        c = s.recv(1)
        if not c or len(b) > 64:
            raise OSError("开头不对")
        b += c
    return b.decode("ascii", "replace").strip()


def close(s):
    try:
        s.close()
    except OSError:
        pass


def splice(a, b):
    """两条连接互相搬，一头说完只关这一头的写，两头都完了才关"""
    left = [2]
    lock = threading.Lock()

    def pump(src, dst):
        try:
            while True:
                d = src.recv(65536)
                if not d:
                    break
                dst.sendall(d)
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            close(a); close(b)
            return
        with lock:
            left[0] -= 1
            if left[0] == 0:
                close(a); close(b)

    threading.Thread(target=pump, args=(a, b), daemon=True).start()
    threading.Thread(target=pump, args=(b, a), daemon=True).start()


class Relay:
    def __init__(self, port, code):
        self.code, self.port = code, port
        self.ctl = None                    # 手机的控制线
        self.ctl_lock = threading.Lock()   # 控制线上写东西的锁
        self.want_lock = threading.Lock()  # 一次只要一条，免得拿错
        self.data = queue.Queue()
        self.srv = socket.create_server(("0.0.0.0", port))
        threading.Thread(target=self.accept, daemon=True).start()

    def accept(self):
        while True:
            s, a = self.srv.accept()
            threading.Thread(target=self.hello, args=(s, a), daemon=True).start()

    def hello(self, s, a):
        try:
            s.settimeout(5)
            line = readline(s)
            if line == "XKREV":
                return self.control(s, a)
            if line == "XKDATA":
                s.settimeout(None)
                return self.data.put(s)
            cmd, _, code = line.partition(" ")
            if cmd in ("XKSTAT", "XKWANT") and code.strip().upper() != self.code:
                s.sendall(b"NO code\n")
                return close(s)
            if cmd == "XKSTAT":
                s.sendall(b"1\n" if self.ctl else b"0\n")
                return close(s)
            if cmd == "XKWANT":
                return self.want(s)
            close(s)
        except OSError as e:
            print(f"中转：{a[0]} 的连接断了：{e}", flush=True)
            close(s)

    def control(self, s, a):
        old, self.ctl = self.ctl, s
        if old:
            close(old)
        print(f"中转：手机 {a[0]} 连上来了", flush=True)
        try:
            with self.ctl_lock:
                s.sendall(b"OK\n")
            s.settimeout(45)
            while s.recv(1):
                with self.ctl_lock:
                    s.sendall(b"p")
            why = "手机断开了"
        except OSError as e:
            why = str(e)
        if self.ctl is s:
            self.ctl = None
            print(f"中转：手机的线断了（{why}）", flush=True)
        close(s)

    def want(self, t):
        c = self.ctl
        if not c:
            t.sendall(b"NO phone\n")
            return close(t)
        with self.want_lock:
            while not self.data.empty():   # 上次等超时后才到的，丢掉
                close(self.data.get_nowait())
            try:
                with self.ctl_lock:
                    c.sendall(b"c")
                d = self.data.get(timeout=5)
            except (OSError, queue.Empty) as e:
                t.sendall(f"NO 手机没连回来（{e or '5 秒'}）\n".encode("utf-8"))
                return close(t)
        t.sendall(b"OK\n")
        t.settimeout(None)
        splice(t, d)
