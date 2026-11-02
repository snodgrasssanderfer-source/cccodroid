#!/bin/sh
# 手机上跑网关测试：/data/user/0 是 /data/data 的别名，临时目录走别名时 registry-flock 夹具的 realpath 断言会失败。
# 换成真路径再跑；参数照传给 scripts/test.mjs（比如 xk 只跑我们的）。
cd "$(dirname "$0")/../.." || exit 1
TMPDIR=$(realpath "${TMPDIR:-/data/data/cc.codroid/files/usr/tmp}") exec node scripts/test.mjs "$@"
