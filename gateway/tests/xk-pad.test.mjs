// 平板 App 的手机一侧（第三步 3a）：配对比 6 位数、加密请求、序号和时间、只放行聊天要用的接口、加密长轮询
import crypto from "node:crypto";
import http from "node:http";
import { test } from "node:test";
import assert from "node:assert/strict";
import { CFG } from "../gw/config.mjs";
import { onPublish, publish } from "../gw/bus.mjs";
import { confirmPair, derive, devices, open, openPairing, padCall, pairRequest, seal, unpair } from "../gw/xk-pad.mjs";

/** 平板放行的请求最后是转给网关自己的接口（selfApi，真 HTTP 到本机）：在同一个端口上起一个假的门口，记下转来了什么 */
async function fakeGateway() {
  const gw = { calls: [], reply: (m, p, b) => ({ ok: true, p }) };
  gw.srv = http.createServer((req, res) => {
    let t = "";
    req.on("data", (c) => (t += c));
    req.on("end", () => {
      const body = t ? JSON.parse(t) : null, p = new URL(req.url, "http://x").pathname;
      gw.calls.push([req.method, p, body]);
      let out;
      try { out = { s: 200, b: gw.reply(req.method, p, body) }; }
      catch (e) { out = { s: e.status || 500, error: e.message }; }
      res.writeHead(out.s, { "content-type": "application/json" });
      res.end(JSON.stringify(out.s < 300 ? out.b : { error: out.error }));
    });
  });
  await new Promise((ok) => gw.srv.listen(CFG.port, "127.0.0.1", ok));
  gw.close = () => new Promise((ok) => gw.srv.close(ok));
  return gw;
}

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
  const gw = await fakeGateway();
  try {
    assert.deepEqual(await t.call({ m: "POST", p: "/api/xk/room", b: { text: "在吗" } }), { s: 200, b: { ok: true, p: "/api/xk/room" } });
    assert.deepEqual(gw.calls[0], ["POST", "/api/xk/room", { text: "在吗" }]);
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
    // 本机接口报错：错误加密带回去，不是明文。selfApi 只把上游的状态码写进消息、不单独带出来，
    // 所以平板看到的是 500（以前这里把 PROXY 换成假的，看不出这一点；实际行为照旧，没改）
    gw.reply = () => { throw Object.assign(new Error("text 不能为空"), { status: 400 }); };
    const err = await t.call({ m: "POST", p: "/api/xk/room", b: {} });
    assert.equal(err.s, 500);
    assert.match(err.error, /text 不能为空/);
  } finally { await gw.close(); }
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

test("串流中转：开串流 → 升级连接 → 本机服务端的数据加密到平板、平板的加密数据解开送到服务端；改一个字节就断", async () => {
  const http = await import("node:http"), net = await import("node:net");
  const { STREAM, SPAWN, opener, sealer, streamKey, streamUpgrade } = await import("../gw/xk-pad.mjs");
  openPairing();
  const t = tablet(); const r = pairRequest({ pub: t.pub }); t.finish(r); confirmPair(r.id);
  // 开串流：网关发 stream_start 给外壳
  let started = null;
  const off = onPublish((e) => { if (e.op === "stream_start") started = e; });
  const { s, b } = await t.call({ m: "POST", p: "/pad/stream/start", b: { h265: true } });
  off();
  assert.equal(s, 200);
  assert.equal(started.sid, b.sid);
  assert.equal(started.opts.supportH265, 1);
  assert.equal(started.opts.serverPort, STREAM.port);
  // 假的易控服务端：把收到的原样回去，再主动发一句
  const fake = net.createServer((c) => { c.write("hello"); c.on("data", (d) => c.write(d)); });
  await new Promise((ok) => fake.listen(0, "127.0.0.1", ok));
  SPAWN.connect = () => net.connect(fake.address().port, "127.0.0.1");
  const gw = http.createServer();
  gw.on("upgrade", (req, sock, head) => streamUpgrade(req, sock, head));
  await new Promise((ok) => gw.listen(0, "127.0.0.1", ok));
  const salt = crypto.randomBytes(16);
  const hello = Buffer.from(JSON.stringify(t.req({ ch: "main", sid: b.sid, salt: salt.toString("base64") }))).toString("base64");
  const sock = net.connect(gw.address().port, "127.0.0.1");
  sock.write(`GET /pad/stream HTTP/1.1\r\nhost: x\r\nupgrade: xkpad\r\nconnection: Upgrade\r\nx-pad: ${hello}\r\n\r\n`);
  const got = [];
  let headerDone = false, pre = Buffer.alloc(0);
  const dec = opener(streamKey(t.key, salt, "main", 0), 0, (p) => got.push(p.toString()));
  sock.on("data", (d) => {
    if (!headerDone) { pre = Buffer.concat([pre, d]); const i = pre.indexOf("\r\n\r\n"); if (i < 0) return; assert.match(pre.subarray(0, i).toString(), /^HTTP\/1.1 101/); headerDone = true; d = pre.subarray(i + 4); }
    if (d.length) dec(d);
  });
  const enc = sealer(streamKey(t.key, salt, "main", 1), 1);
  await new Promise((r) => setTimeout(r, 200));
  sock.write(enc(Buffer.from(" world")));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(got.join(""), "hello world", "服务端→平板加密、平板→服务端解开");
  // 改一个字节：网关解不开就断
  const bad = enc(Buffer.from("x")); bad[bad.length - 1] ^= 1;
  const closed = new Promise((ok) => sock.on("close", ok));
  sock.write(bad);
  await closed;
  // 同一个升级请求再用一次：序号旧了
  const again = net.connect(gw.address().port, "127.0.0.1");
  let resp = "";
  again.on("data", (d) => { resp += d; });
  again.write(`GET /pad/stream HTTP/1.1\r\nhost: x\r\nupgrade: xkpad\r\nconnection: Upgrade\r\nx-pad: ${hello}\r\n\r\n`);
  await new Promise((ok) => again.on("close", ok));
  assert.match(resp, /^HTTP\/1.1 401[\s\S]*序号旧了/);
  gw.close(); fake.close(); unpair(r.id);
});
