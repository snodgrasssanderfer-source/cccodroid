#!/bin/sh
cd "$(dirname "$0")" || exit 1
exec python3 bridge.py --host 0.0.0.0 --port 12347 --game-url http://127.0.0.1:12346 "$@"
