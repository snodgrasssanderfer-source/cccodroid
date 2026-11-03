// 平板 App 的手机一侧（第三步 3a）：配对比 6 位数、加密请求、序号和时间、只放行聊天要用的接口、加密长轮询
import crypto from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { onPublish, publish } from "../gw/bus.mjs";
import { PROXY, confirmPair, derive, devices, open, openPairing, padCall, pairRequest, seal, unpair } from "../gw/xk-pad.mjs";

/** 假平板：照平板 App 的算法走一遍 */
function tablet() {
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const pub = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const t = { pub, seq: 0 };
  t.finish = (r) => {
    const shared = crypto.diffieHellman({ privateKey: kp.privateKey, publicKey: crypto.createPublicKey({ key: Buffer.from(r.pub, "base64"), format: "der", type: "spki" }) });
    Object.assign(t, derive(shared, r.pub, pub), { id: r.id });
  };
  t.req = (q, at = Date.now()) => ({ id: t.id, ...seal(t.key, { t: at, q: ++t.seq, ...q }, t.id) });
  t.call = async (q) => open(t.key, await padCall(t.req(q)), t.id);
  return t;
}

test("配对：没开窗口不认；两边算出同一个 6 位数；主人确认前请求不放行", async () => {
  const t = tablet();
  assert.throws(() => pairRequest({ pub: t.pub, name: "主人的平板" }, 0), /没开配对/);
  openPairing();
  let shown = null;
  const off = onPublish((e) => { if (e.op === "pad_pending") shown = e.sas; });
  const r = pairRequest({ pub: t.pub, name: "主人的平板" });
  off();
  t.finish(r);
  assert.equal(devices().devices.length, 0, "确认前还没记下来");
  await assert.rejects(t.call({ m: "GET", p: "/api/xk/roles" }), /等手机上确认/);
  assert.match(shown, /^\d{6}$/);
  assert.equal(shown, t.sas, "手机上显示的和平板算的是同一个数");
  confirmPair(r.id);
  assert.equal(devices().devices.length, 1);
  assert.equal(devices().devices[0].name, "主人的平板");
  unpair(r.id);
});

test("中间人换了公钥：两边的 6 位数对不上（主人就不会点确认）", () => {
  openPairing();
  const t = tablet(), mitm = tablet();
  const r = pairRequest({ pub: mitm.pub });   // 手机收到的是中间人的公钥
  mitm.finish(r);
  // 平板以为对面是手机，其实拿到的是中间人自己的公钥
  const kp = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const fakePhonePub = kp.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  t.finish({ id: "x", pub: fakePhonePub });
  assert.notEqual(t.sas, mitm.sas);
});

test("加密请求：放行的接口转给本机；别的接口、旧序号、钟差太大、别人的密钥都不认", async () => {
  openPairing();
  const t = tablet(); const r = pairRequest({ pub: t.pub }); t.finish(r); confirmPair(r.id);
  const calls = [];
  PROXY.call = async (m, p, b) => { calls.push([m, p, b]); return { ok: true, p }; };
  assert.deepEqual(await t.call({ m: "POST", p: "/api/xk/room", b: { text: "在吗" } }), { s: 200, b: { ok: true, p: "/api/xk/room" } });
  assert.deepEqual(calls[0], ["POST", "/api/xk/room", { text: "在吗" }]);
  await assert.rejects(t.call({ m: "GET", p: "/api/files/list" }), /不能用这个接口/);
  const old = t.req({ m: "GET", p: "/api/xk/roles" });
  await padCall(old);
  await assert.rejects(padCall(old), /序号旧了/, "同一个请求再发一遍");
  // 同时发的两个请求先后颠倒到达：都认（长轮询和发消息同时在路上）
  const a = t.req({ m: "GET", p: "/api/xk/roles" }), b = t.req({ m: "GET", p: "/api/xk/roles" });
  await padCall(b); await padCall(a);
  await assert.rejects(padCall(a), /序号旧了/);
  await assert.rejects(padCall(t.req({ m: "GET", p: "/api/xk/roles" }, Date.now() - 5 * 60000)), /时间对不上/);
  const other = tablet(); other.id = t.id; other.key = crypto.randomBytes(32);
  await assert.rejects(padCall(other.req({ m: "GET", p: "/api/xk/roles" })), /解不开/);
  // 本机接口报错：错误加密带回去，不是明文
  PROXY.call = async () => { throw Object.assign(new Error("text 不能为空"), { status: 400 }); };
  assert.deepEqual(await t.call({ m: "POST", p: "/api/xk/room", b: {} }), { s: 400, error: "text 不能为空" });
  unpair(r.id);
});

test("事件长轮询：加密送出聊天页要用的那几种，别的不给", async () => {
  openPairing();
  const t = tablet(); const r = pairRequest({ pub: t.pub }); t.finish(r); confirmPair(r.id);
  const { cursor } = await t.call({ ev: -1 });   // 先拿一次光标（之前别的测试发过事件，马上就回）
  const wait = t.call({ ev: cursor });
  publish({ type: "xk", op: "memory_failed", role: "xiaoke", error: "x" });
  publish({ type: "xk", op: "room", msg: { n: 0, from: "owner", text: "嗨" } });
  const got = await wait;
  assert.deepEqual(got.events.map((e) => e.op), ["room"]);
  unpair(r.id);
});
