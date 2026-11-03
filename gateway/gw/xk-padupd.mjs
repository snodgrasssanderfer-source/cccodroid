// 平板 App 自己更新。平板多半直连不了 GitHub（家里 Wi‑Fi、手机热点都不走手机的 VPN），所以由手机网关去我们的 Release
// 下 xiaoke-pad.apk（照 Release 列表里给的 sha256 核对），再经配对的加密口子分块交给平板（xk-pad.mjs 的 PAD_SPECIAL）。
// 装不装由平板上的主人点，系统安装器会核对签名（和平板上那个是同一把钥匙才装得上）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { log } from "./config.mjs";
import { XK_HOME } from "./xk-core.mjs";
import { PAD_SPECIAL } from "./xk-pad.mjs";

const REPO = "snodgrasssanderfer-source/cccodroid";
const ASSET = "xiaoke-pad.apk", CHUNK = 256 * 1024, RECHECK_MS = 30 * 60_000, RETRY_MS = 60_000;
// 和手机自己检查更新同一个发布列表（设置里改过就用改过的），api.github.com 限流时退到 Release 附带的那份
const feeds = () => {
  const f = path.join(XK_HOME, "update-feed");
  const own = fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "";
  return [own || `https://api.github.com/repos/${REPO}/releases?per_page=30`, `https://github.com/${REPO}/releases/latest/download/releases.json`];
};
export const UPD = {
  version: "", file: "", size: 0, sha256: "", error: "", at: 0, busy: null,
  fetch: (u) => fetch(u, { headers: { "user-agent": "xiaoke-gateway" }, redirect: "follow" }),
};

async function latest() {
  let last;
  for (const u of feeds()) {
    try {
      const r = await UPD.fetch(u);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const rel = (await r.json()).find((x) => !x.draft && !x.prerelease && x.assets?.some((a) => a.name === ASSET));
      if (!rel) throw new Error("Release 里没有 " + ASSET);
      const a = rel.assets.find((x) => x.name === ASSET);
      return { version: rel.tag_name.replace(/^v/, ""), url: a.browser_download_url, sha256: String(a.digest || "").replace(/^sha256:/, "") };
    } catch (e) { last = new Error(`看不了发布列表（${u}）：${e.message}`); }
  }
  throw last;
}

async function refresh() {
  const rel = await latest();
  const dir = path.join(XK_HOME, "cache"), file = path.join(dir, `xiaoke-pad-${rel.version}.apk`);
  if (UPD.version === rel.version && fs.existsSync(file)) return;
  const r = await UPD.fetch(rel.url);
  if (!r.ok) throw new Error(`下不了 ${rel.url}：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  if (rel.sha256 && sha256 !== rel.sha256) throw new Error(`下来的 ${ASSET} 和发布列表里的 sha256 对不上`);
  fs.mkdirSync(dir, { recursive: true });
  for (const old of fs.readdirSync(dir)) if (/^xiaoke-pad-.*\.apk$/.test(old)) fs.rmSync(path.join(dir, old));
  fs.writeFileSync(file, buf);
  Object.assign(UPD, { version: rel.version, file, size: buf.length, sha256 });
  log(`平板更新：备好了 ${ASSET} ${rel.version}`);
}

/** 平板问最新版：头一次问、或过了半小时，就在后台去 Release 看一眼（不让平板干等，它过一会儿再问） */
export function padUpdate(now = Date.now()) {
  if (!UPD.busy && now - UPD.at > RECHECK_MS) {
    UPD.at = now;
    UPD.busy = refresh()
      .then(() => { UPD.error = ""; }, (e) => { UPD.error = e.message; UPD.at = now - RECHECK_MS + RETRY_MS; log("平板更新：" + e.message); })
      .finally(() => { UPD.busy = null; });
  }
  return { s: 200, b: { version: UPD.version, size: UPD.size, sha256: UPD.sha256, checking: !!UPD.busy, error: UPD.error } };
}

/** 分块拿：{ v: 版本, off: 从哪个字节起 } → 一块（base64）。版本中途变了就让平板重来 */
export function padUpdateChunk(b) {
  if (!UPD.version || String(b.v) !== UPD.version) return { s: 409, error: "手机上备的版本变了，重新点一次更新" };
  const off = Math.max(0, Math.floor(Number(b.off) || 0));
  const fd = fs.openSync(UPD.file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, Math.min(CHUNK, UPD.size - off)));
    fs.readSync(fd, buf, 0, buf.length, off);
    return { s: 200, b: { data: buf.toString("base64"), total: UPD.size } };
  } finally { fs.closeSync(fd); }
}

PAD_SPECIAL["/pad/update"] = () => padUpdate();
PAD_SPECIAL["/pad/update/chunk"] = (b) => padUpdateChunk(b);
