"""Read phone health/state; optionally time one explicitly supplied bridge action."""

import argparse
import json
import time
from urllib.request import ProxyHandler, Request, build_opener


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", help='one JSON action, e.g. {"action":"select"}')
    parser.add_argument("--delay", type=float, default=0, help="seconds to switch the game into the foreground")
    args = parser.parse_args()
    action = json.loads(args.action) if args.action else None
    opener = build_opener(ProxyHandler({}))

    def request(port, path="", body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = Request(f"http://127.0.0.1:{port}{path}", data=data,
                      headers={"Content-Type": "application/json"})
        with opener.open(req, timeout=180) as response:
            return json.load(response)

    time.sleep(args.delay)
    result = {"health": request(12346, body={"jsonrpc": "2.0", "id": 1, "method": "health", "params": {}})}
    state = request(12347, "/state")
    result["state"] = state
    if action is not None:
        before = time.perf_counter()
        result["act"] = request(12347, "/act", action)
        result["wall_ms"] = round((time.perf_counter() - before) * 1000)
        result["events"] = request(12347, f'/events?since={state["seq"]}&wait=0')
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
