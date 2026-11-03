#!/bin/sh
# 打「小克 · 平板」（GPL-3.0，见 xk/pad/NOTICE.md）：javac → d8 → aapt2 → 对齐 → 签名。和手机小克同一把钥匙、同一个版本号。
# 用法：ANDROID_JAR=… D8=… AAPT2=… ZIPALIGN=… APKSIGNER=… KEY=钥匙.json（或 KS=测试 keystore）sh xk/pad/build.sh <输出的 apk>
set -e
P=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$P/../.." && pwd)
OUT=${1:?要给输出路径}
B=$P/build/app
[ -n "$KS" ] || [ -f "$KEY" ] || { echo "✗ 没有签名钥匙（KEY 或 KS）"; exit 1; }
rm -rf "$B"; mkdir -p "$B/classes" "$B/assets/art"

# 版本号跟手机小克走：两边一起发，平板认得出该不该更新
M=$ROOT/android/AndroidManifest.xml
VN=$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$M" | head -1)
VC=$(sed -n 's/.*android:versionCode="\([^"]*\)".*/\1/p' "$M" | head -1)
sed "s/@VN@/$VN/; s/@VC@/$VC/" "$P/AndroidManifest.xml" > "$B/AndroidManifest.xml"

${JAVAC:-javac} -encoding UTF-8 --release 11 -nowarn -cp "$ANDROID_JAR" -d "$B/classes" $(find "$P/java" -name '*.java')
${D8:-d8} --release --min-api 26 --lib "$ANDROID_JAR" --output "$B" $(find "$B/classes" -name '*.class')

# 聊天页和它要的图：图和手机小克用同一份（gateway/web/xk-art），不另存一份
cp "$P/assets/"* "$B/assets/"
for d in overlay mini pad room; do cp -R "$ROOT/gateway/web/xk-art/$d" "$B/assets/art/"; done

${AAPT2:-aapt2} compile --dir "$P/res" -o "$B/res.zip"
${AAPT2:-aapt2} link -o "$B/unsigned.apk" -I "$ANDROID_JAR" --manifest "$B/AndroidManifest.xml" -A "$B/assets" "$B/res.zip"
( cd "$B" && zip -q unsigned.apk classes.dex )
${ZIPALIGN:-zipalign} -p -f 4 "$B/unsigned.apk" "$B/aligned.apk"
if [ -n "$KS" ]; then
  ${APKSIGNER:-apksigner} sign --ks "$KS" --ks-pass "pass:${KS_PASS:-android}" --out "$OUT" "$B/aligned.apk"
else
  # 钥匙 JSON → PKCS#8 DER + 证书，只在构建目录里待一下（和 scripts/build.sh 一样）
  trap 'rm -f "$B/key.pk8" "$B/cert.pem"' EXIT
  node -e 'const fs=require("fs"),c=require("crypto"),j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    fs.writeFileSync(process.argv[2],c.createPrivateKey(j.key).export({type:"pkcs8",format:"der"}),{mode:0o600});
    fs.writeFileSync(process.argv[3],j.cert)' "$KEY" "$B/key.pk8" "$B/cert.pem"
  ${APKSIGNER:-apksigner} sign --key "$B/key.pk8" --cert "$B/cert.pem" --out "$OUT" "$B/aligned.apk"
fi
rm -f "$OUT.idsig"
echo "✓ $OUT（$VN）"
