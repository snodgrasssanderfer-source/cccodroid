"""电脑牌局桥：游戏只执行动作，模型自己决定下一步。"""

import argparse
import copy
import json
import logging
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from events import diff_events
from rules import legal_actions, validate_action
from state import compact_state


class GameError(RuntimeError):
    pass


def ready(raw):
    meta = raw.get("bridge") or {}
    # Boss 提示动画使用非阻塞事件，但 block_play 会一直保留到提示结束。
    return bool(meta.get("ready") and not meta.get("play_blocked"))


class RpcClient:
    def __init__(self, url, timeout=180):
        self.url = url
        self.timeout = timeout
        # 游戏在本机；系统 HTTP 代理不能接管这条连接。
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        self.request_id = 0

    def call(self, method, params=None):
        self.request_id += 1
        body = json.dumps({"jsonrpc": "2.0", "id": self.request_id,
                           "method": method, "params": params or {}}).encode()
        request = urllib.request.Request(self.url, body, {"Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                result = json.load(response)
        except (OSError, urllib.error.URLError, ValueError) as exc:
            raise GameError(f"游戏接口 {method} 失败：{exc}") from exc
        if "error" in result:
            raise GameError(f"游戏拒绝 {method}：{result['error']}")
        return result["result"]


class Bridge:
    def __init__(self, rpc, poll=0.15, settle=0.35, action_timeout=180, record_dir=None):
        self.rpc = rpc
        self.poll = poll
        self.settle = settle
        self.action_timeout = action_timeout
        self.record_dir = Path(record_dir) if record_dir else None
        if self.record_dir:
            self.record_dir.mkdir(parents=True, exist_ok=True)
        # balatrobot 每次只服务一条连接；轮询和动作共用这把锁。
        self.operation = threading.Lock()
        self.changed = threading.Condition()
        self.stopping = threading.Event()
        self.raw = None
        self.event_raw = None
        self.current = None
        self.seq = 0
        self.history = []
        self.error = None

    def publish(self, raw, action=None):
        with self.changed:
            self.error = None
            if raw == self.raw:
                return copy.deepcopy(self.current), []
            is_ready = ready(raw)
            # 计分时 played 先变、chips 后变；业务事件只比较可操作的完整状态。
            changes = diff_events(self.event_raw, raw, action) if is_ready and self.event_raw is not None else []
            state = compact_state(raw)
            state["ready"] = is_ready
            state["actions"] = legal_actions(raw) if is_ready else {}
            self.seq += 1
            state["seq"] = self.seq
            if is_ready:
                self.event_raw = copy.deepcopy(raw)
            events = [{"seq": self.seq, **event} for event in changes]
            self.raw = copy.deepcopy(raw)
            if self.record_dir:
                (self.record_dir / f"{self.seq:05d}-{raw['state']}.json").write_text(
                    json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
            self.current = state
            self.history.extend(events)
            self.changed.notify_all()
            return copy.deepcopy(state), copy.deepcopy(events)

    def snapshot(self):
        with self.changed:
            if self.error:
                raise GameError(self.error)
            if self.current is None:
                raise GameError("还没有游戏状态；确认 balatrobot 和 xk_game_bridge 模组已启动")
            return copy.deepcopy(self.current)

    def watch(self):
        while not self.stopping.is_set():
            if self.operation.acquire(blocking=False):
                try:
                    self.publish(self.rpc.call("bridge_state"))
                except GameError as exc:
                    with self.changed:
                        if self.error != str(exc):
                            logging.error("%s", exc)
                        self.error = str(exc)
                        self.changed.notify_all()
                finally:
                    self.operation.release()
            self.stopping.wait(self.poll)

    def stable_state(self):
        end = time.monotonic() + self.action_timeout
        previous = None
        stable_since = None
        while time.monotonic() < end:
            raw = self.rpc.call("bridge_state")
            now = time.monotonic()
            if ready(raw):
                if raw != previous:
                    stable_since = now
                elif stable_since is not None and now - stable_since >= self.settle:
                    return raw
            else:
                stable_since = None
            previous = raw
            time.sleep(self.poll)
        raise GameError("动作已发出，但尚未等到动画结束；请读取当前状态，不要盲目重发动作")

    def act(self, request):
        started = time.monotonic()
        with self.operation:
            raw = self.rpc.call("bridge_state")
            state, _ = self.publish(raw)
            try:
                if not ready(raw):
                    raise ValueError("游戏正在播放动画，当前没有可执行动作")
                method, params = validate_action(raw, request)
            except ValueError as exc:
                return 400, {"ok": False, "error": str(exc), "state": state}
            self.rpc.call(method, params)
            result = self.stable_state()
            state, events = self.publish(result, request)
        return 200, {"ok": True, "state": state, "events": events,
                     "elapsed_ms": round((time.monotonic() - started) * 1000)}

    def events_since(self, since, wait=25):
        end = time.monotonic() + wait
        with self.changed:
            while self.seq <= since and not self.error and not self.stopping.is_set():
                remaining = end - time.monotonic()
                if remaining <= 0:
                    break
                self.changed.wait(remaining)
            if self.error:
                raise GameError(self.error)
            return {"seq": self.seq, "events": copy.deepcopy([
                event for event in self.history if event["seq"] > since])}


def handler_for(bridge):
    class Handler(BaseHTTPRequestHandler):
        def reply(self, status, payload):
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                logging.info("客户端在返回结果前断开：%s", self.path)

        def do_GET(self):
            url = urlsplit(self.path)
            try:
                if url.path == "/state":
                    self.reply(200, bridge.snapshot())
                elif url.path == "/events":
                    query = parse_qs(url.query)
                    since = int(query.get("since", ["0"])[0])
                    wait = float(query.get("wait", ["25"])[0])
                    if since < 0 or wait < 0:
                        raise ValueError("since 和 wait 不能为负数")
                    self.reply(200, bridge.events_since(since, wait))
                else:
                    self.reply(404, {"error": "使用 /state、/act 或 /events"})
            except ValueError as exc:
                self.reply(400, {"error": str(exc)})
            except GameError as exc:
                self.reply(502, {"error": str(exc)})

        def do_POST(self):
            if urlsplit(self.path).path != "/act":
                self.reply(404, {"error": "动作入口为 /act"})
                return
            try:
                request = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                if not isinstance(request, dict):
                    raise ValueError("动作必须是 JSON 对象")
                status, payload = bridge.act(request)
                self.reply(status, payload)
            except ValueError as exc:
                self.reply(400, {"ok": False, "error": str(exc)})
            except GameError as exc:
                self.reply(502, {"ok": False, "error": str(exc)})

        def log_message(self, fmt, *args):
            logging.info("%s %s", self.address_string(), fmt % args)

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=12347)
    parser.add_argument("--game-url", default="http://127.0.0.1:12346")
    parser.add_argument("--poll", type=float, default=0.15)
    parser.add_argument("--settle", type=float, default=0.35)
    parser.add_argument("--action-timeout", type=float, default=180)
    parser.add_argument("--record-dir", help="验收时保存原始状态样本；平时不写文件")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s")
    bridge = Bridge(RpcClient(args.game_url, args.action_timeout), args.poll, args.settle,
                    args.action_timeout, args.record_dir)
    worker = threading.Thread(target=bridge.watch, daemon=True)
    worker.start()
    server = ThreadingHTTPServer((args.host, args.port), handler_for(bridge))
    logging.info("牌局桥 http://%s:%s -> %s", args.host, args.port, args.game_url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        bridge.stopping.set()
        with bridge.changed:
            bridge.changed.notify_all()
        server.server_close()


if __name__ == "__main__":
    main()
