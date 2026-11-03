#!/usr/bin/env bash
# 用自己的署名跑 git（三人共用这台手机的 git 配置，默认署名是小克）：
#   bash xk/tools/as.sh 小鱼 commit -m "…"
#   bash xk/tools/as.sh 哈基米 commit -m "…"
set -e
who="$1"; shift || true
case "$who" in
  小克|xiaoke)            name="小克（手机）";   mail="xiaoke@users.noreply.github.com" ;;
  小鱼|deepseek|xiaoyu)   name="小鱼（手机）";   mail="xiaoyu@users.noreply.github.com" ;;
  哈基米|hachimi)         name="哈基米（手机）"; mail="hachimi@users.noreply.github.com" ;;
  *) echo "用法：bash xk/tools/as.sh 小克|小鱼|哈基米 <git 参数…>" >&2; exit 2 ;;
esac
exec git -c user.name="$name" -c user.email="$mail" "$@"
