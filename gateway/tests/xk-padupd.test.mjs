// 平板 App 自己更新：手机网关去 Release 下 xiaoke-pad.apk、核对 sha256，经配对的加密口子分块交给平板
import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmPair, derive, open, openPairing, padCall, pairRequest, seal } from "../gw/xk-pad.mjs";
import { UPD } from "../gw/xk-padupd.mjs";

async function pairedTablet() {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  openPairing();
  const r = pairRequest({ pub, name: "更新测试平板" });
  const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(r.pub, "base64"), format: "der", type: "spki" }) });
  const t = { id: r.id, ...derive(shared, r.pub, pub), seq: 0 };
  confirmPair(r.id);
  t.call = async (p, b) => open(t.key, await padCall({ id: t.id, ...seal(t.key, { t: Date.now(), q: ++t.seq, m: "GET", p, b }, t.id) }), t.id);
  return t;
}

function fakeRelease(apk, digest) {
  return async (u) => {
    if (u.endsWith("/xiaoke-pad.apk")) return new Response(apk);
    if (u.includes("api.github.com")) return new Response("rate limited", { status: 403 });   // 限流：退到备用那份
    return Response.json([
      { tag_name: "v9.9.9-rc1", draft: false, prerelease: true, assets: [{ name: "xiaoke-pad.apk" }] },
      { tag_name: "v9.9.8", draft: false, prerelease: false, assets: [{ name: "cccodroid.apk" }, { name: "xiaoke-pad.apk", browser_download_url: "https://x/v9.9.8/xiaoke-pad.apk", digest }] },
    ]);
  };
}
const settle = async () => { while (UPD.busy) await UPD.busy; };

test("平板更新：限流时用备用列表，跳过预发布，核对 sha256 后分块交给平板，拼回来一字不差", async () => {
  const t = await pairedTablet();
  const apk = crypto.randomBytes(600 * 1024);
  Object.assign(UPD, { version: "", at: 0, busy: null, error: "", fetch: fakeRelease(apk, "sha256:" + crypto.createHash("sha256").update(apk).digest("hex")) });
  let r = await t.call("/pad/update");
  assert.equal(r.s, 200); assert.equal(r.b.checking, true, "头一次问：后台去看，不让平板等");
  await settle();
  r = await t.call("/pad/update");
  assert.equal(r.b.version, "9.9.8"); assert.equal(r.b.size, apk.length); assert.equal(r.b.error, "");
  const parts = [];
  for (let off = 0; off < r.b.size; ) {
    const c = await t.call("/pad/update/chunk", { v: r.b.version, off });
    assert.equal(c.s, 200);
    const b = Buffer.from(c.b.data, "base64");
    parts.push(b); off += b.length;
  }
  assert.ok(parts.length > 1, "分了好几块");
  assert.deepEqual(Buffer.concat(parts), apk);
  assert.equal((await t.call("/pad/update/chunk", { v: "0.0.1", off: 0 })).s, 409, "版本对不上就让平板重来");
});

test("平板更新：下来的文件和 sha256 对不上就不交，原因报给平板", async () => {
  const t = await pairedTablet();
  Object.assign(UPD, { version: "", at: 0, busy: null, error: "", fetch: fakeRelease(crypto.randomBytes(1000), "sha256:" + "0".repeat(64)) });
  await t.call("/pad/update"); await settle();
  const r = await t.call("/pad/update");
  assert.equal(r.b.version, "");
  assert.match(r.b.error, /sha256 对不上/);
});
