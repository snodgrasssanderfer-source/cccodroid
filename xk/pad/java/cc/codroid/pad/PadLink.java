package cc.codroid.pad;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;

/**
 * 平板和手机之间的那条线：找手机（局域网广播 _xkpad._tcp）、配对、加密请求、事件长轮询、断了重连。
 * 手机那边是 gateway/gw/xk-pad.mjs，算法见 PadCrypto。界面只看 state()，有变化就回调 Listener。
 *
 * 阶段：idle（没配对）→ searching（在找手机）→ confirm（显示 6 位数，等主人在手机上点确认）→ connected；
 *       已配对的直接 searching → connected；连不上就回 searching 重新找（手机换了 IP 也能找回来）。
 */
final class PadLink {
    static final String TAG = "xkpad";
    static final String TYPE = "_xkpad._tcp";

    interface Listener { void onState(JSONObject state); void onEvent(JSONObject ev); }

    private final Context ctx;
    private final SharedPreferences sp;
    private final NsdManager nsd;
    private final Listener out;
    private volatile String phase = "idle", sas = "", error = "", host = "";
    private volatile int port;
    private volatile boolean pairing, stopped;
    // 配对号和密钥：配对确认前只在内存里，主人在手机上点了确认才存下来（中途断了不会被当成已配对）
    private volatile String id;
    private volatile byte[] key;
    private Thread loop;
    private NsdManager.DiscoveryListener discovery;

    PadLink(Context c, Listener l) {
        ctx = c.getApplicationContext();
        sp = ctx.getSharedPreferences("pad", Context.MODE_PRIVATE);
        nsd = ctx.getSystemService(NsdManager.class);
        out = l;
        host = sp.getString("host", "");
        port = sp.getInt("port", 0);
        id = sp.getString("id", "");
        key = id.isEmpty() ? null : PadCrypto.unb64(sp.getString("key", ""));
    }

    boolean paired() { return !sp.getString("id", "").isEmpty(); }

    JSONObject state() {
        try { return new JSONObject().put("phase", phase).put("sas", sas).put("error", error).put("paired", paired()).put("phone", host.isEmpty() ? "" : host + ":" + port); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private void set(String p, String err) { phase = p; error = err == null ? "" : err; out.onState(state()); }

    /** 打开 App 时：配对过就去连，没配对就等主人点「配对」 */
    void start() {
        stopped = false;
        if (paired()) run();
        else set("idle", null);
    }
    void stop() { stopped = true; stopDiscovery(); if (loop != null) loop.interrupt(); }

    /** 主人点「配对」：先找到手机，再交换公钥（手机上要先点「配对新平板」） */
    void pair() { pairing = true; sp.edit().remove("id").remove("key").remove("seq").apply(); id = ""; key = null; run(); }
    /** 忘掉这台手机（手机那边也要在「我的 → 平板」里取消） */
    void forget() { stop(); sp.edit().clear().apply(); host = ""; port = 0; id = ""; key = null; set("idle", null); }

    private synchronized void run() {
        if (loop != null && loop.isAlive()) loop.interrupt();
        loop = new Thread(this::main, "xkpad-link");
        loop.start();
    }

    private void main() {
        long backoff = 2000;
        while (!stopped && !Thread.currentThread().isInterrupted()) {
            try {
                if (host.isEmpty() || port == 0) { set("searching", null); find(); }
                if (pairing) { doPair(); pairing = false; }
                set("connected", null);
                backoff = 2000;
                events();   // 一直等事件，断了才回来
            } catch (InterruptedException e) {
                return;
            } catch (Exception e) {
                Log.w(TAG, "连接断了：" + e.getMessage());
                // 配对没成：停下来把原因给主人看，等他再点「配对」
                if (pairing || !paired()) { pairing = false; id = ""; key = null; sas = ""; set("idle", e.getMessage()); return; }
                set("searching", e.getMessage());
                host = ""; port = 0;   // 手机可能换了地址：下一圈重新找
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 30000);
            }
        }
    }

    // ── 找手机：NSD 找到第一台就用（一个家里一般只有一台装了小克的手机） ──
    private void find() throws Exception {
        final Object lk = new Object();
        final String[] got = new String[2];
        discovery = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { synchronized (lk) { got[1] = "找不了（错误码 " + code + "）"; lk.notifyAll(); } }
            @Override public void onStopDiscoveryFailed(String t, int code) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                if (!s.getServiceType().contains("_xkpad")) return;
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo s2, int code) { Log.w(TAG, "解析不了：" + code); }
                    @Override public void onServiceResolved(NsdServiceInfo s2) {
                        synchronized (lk) { got[0] = s2.getHost().getHostAddress() + ":" + s2.getPort(); lk.notifyAll(); }
                    }
                });
            }
        };
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        try {
            synchronized (lk) {
                while (got[0] == null && got[1] == null) lk.wait(1000);
            }
        } finally { stopDiscovery(); }
        if (got[1] != null) throw new java.io.IOException(got[1]);
        int i = got[0].lastIndexOf(':');
        host = got[0].substring(0, i); port = Integer.parseInt(got[0].substring(i + 1));
        sp.edit().putString("host", host).putInt("port", port).apply();
    }
    private void stopDiscovery() {
        NsdManager.DiscoveryListener d = discovery; discovery = null;
        if (d != null) try { nsd.stopServiceDiscovery(d); } catch (RuntimeException ignored) {}
    }

    // ── 配对：交换公钥 → 两边各自算出 6 位数 → 等主人在手机上点确认（这期间试着发一个加密请求，通了就是确认了） ──
    private void doPair() throws Exception {
        KeyPair kp = PadCrypto.newKeyPair();
        String pub = PadCrypto.pub(kp);
        JSONObject r = post("/pad/pair", new JSONObject().put("pub", pub).put("name", Build.MODEL).toString(), 15000);
        if (r.has("error")) throw new java.io.IOException(r.getString("error"));
        PadCrypto.Derived d = PadCrypto.derive(kp.getPrivate(), r.getString("pub"), pub);
        id = r.getString("id"); key = d.key;
        sp.edit().putLong("seq", 0).apply();
        sas = d.sas;
        set("confirm", null);
        long until = System.currentTimeMillis() + 120_000;
        while (System.currentTimeMillis() < until) {
            JSONObject x = call("GET", "/api/xk/roles", null);
            if (x.optInt("s") == 200) { sas = ""; sp.edit().putString("id", id).putString("key", PadCrypto.b64(key)).apply(); return; }
            if (!x.optString("error").contains("等手机上确认")) throw new java.io.IOException(x.optString("error"));
            Thread.sleep(2000);
        }
        throw new java.io.IOException("两分钟内手机上没点确认，重新配对一次");
    }

    // ── 加密请求 ──
    private synchronized long nextSeq() { long n = sp.getLong("seq", 0) + 1; sp.edit().putLong("seq", n).commit(); return n; }

    /** 发一个请求给手机：回 {s: 状态, b: 内容} 或 {error}。网络断了才抛异常 */
    JSONObject call(String method, String path, Object body) throws Exception {
        JSONObject q = new JSONObject().put("t", System.currentTimeMillis()).put("q", nextSeq()).put("m", method).put("p", path);
        if (body != null) q.put("b", body);
        return send(q, 20000);
    }
    private JSONObject send(JSONObject q, int timeoutMs) throws Exception {
        String id = this.id;
        byte[] key = this.key;
        if (key == null) throw new java.io.IOException("还没配对");
        String[] env = PadCrypto.seal(key, q.toString(), id);
        JSONObject r = post("/pad/v1", new JSONObject().put("id", id).put("n", env[0]).put("c", env[1]).toString(), timeoutMs);
        if (r.has("error")) return r;   // 手机说不行（没配对、等确认、不放行……）：明文的错误说明
        return new JSONObject(PadCrypto.open(key, r.getString("n"), r.getString("c"), id));
    }

    // ── 串流用：升级连接请求头里带的加密身份校验（和请求一样带时间、序号），以及连谁、用哪把密钥 ──
    String hello(JSONObject q) throws Exception {
        q.put("t", System.currentTimeMillis()).put("q", nextSeq());
        String[] env = PadCrypto.seal(key, q.toString(), id);
        String j = new JSONObject().put("id", id).put("n", env[0]).put("c", env[1]).toString();
        return java.util.Base64.getEncoder().encodeToString(j.getBytes(StandardCharsets.UTF_8));
    }
    String host() { return host; }
    int port() { return port; }
    byte[] key() { return key; }

    // ── 事件：加密长轮询，光标从 -1 起（-1 = 刚连上，只要现在的光标） ──
    private void events() throws Exception {
        long cursor = -1;
        while (!stopped) {
            JSONObject q = new JSONObject().put("t", System.currentTimeMillis()).put("q", nextSeq()).put("ev", cursor);
            JSONObject r = send(q, 40_000);
            if (r.has("error")) throw new java.io.IOException(r.getString("error"));
            cursor = r.getLong("cursor");
            org.json.JSONArray evs = r.getJSONArray("events");
            for (int i = 0; i < evs.length(); i++) out.onEvent(evs.getJSONObject(i));
        }
    }

    private JSONObject post(String path, String body, int timeoutMs) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL("http://" + host + ":" + port + path).openConnection();
        try {
            c.setConnectTimeout(5000); c.setReadTimeout(timeoutMs);
            c.setRequestMethod("POST"); c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            try (OutputStream o = c.getOutputStream()) { o.write(b); }
            int code = c.getResponseCode();
            InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            if (in != null) try (InputStream i2 = in) { byte[] buf = new byte[8192]; for (int n; (n = i2.read(buf)) > 0; ) bo.write(buf, 0, n); }
            String t = new String(bo.toByteArray(), StandardCharsets.UTF_8);
            JSONObject j = t.isEmpty() ? new JSONObject() : new JSONObject(t);
            if (code >= 400 && !j.has("error")) j.put("error", "HTTP " + code);
            return j;
        } finally { c.disconnect(); }
    }
}
