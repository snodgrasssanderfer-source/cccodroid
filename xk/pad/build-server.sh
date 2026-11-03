#!/bin/sh
# 打出串流服务端（易控 EasyControlNext 的 server，GPL-3.0，见 xk/pad/NOTICE.md）：aidl → javac → d8 → 一个带 classes.dex 的 jar。
# 手机上由外壳经 Shizuku 以 shell 身份用 app_process 起它（XkStream.java）。
# 用法：ANDROID_JAR=… AIDL=… D8=… sh xk/pad/build-server.sh <输出的 jar>
set -e
P=$(cd "$(dirname "$0")" && pwd)
OUT=${1:?要给输出路径}
B=$P/build/server
rm -rf "$B"; mkdir -p "$B/gen" "$B/classes"
for f in $(cd "$P/server/aidl" && find android -name '*.aidl'); do
  ${AIDL:-aidl} -I"$P/server/aidl" -o"$B/gen" "$P/server/aidl/$f"
done
${JAVAC:-javac} -encoding UTF-8 --release 11 -nowarn -cp "$ANDROID_JAR" -d "$B/classes" \
  $(find "$P/server/java" "$B/gen" -name '*.java')
${D8:-d8} --release --min-api 26 --lib "$ANDROID_JAR" --output "$OUT" $(find "$B/classes" -name '*.class')
echo "✓ $OUT"
