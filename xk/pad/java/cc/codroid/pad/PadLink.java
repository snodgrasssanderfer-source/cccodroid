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
    private final PadHub hub;
    /** 电脑上的中转（xk/voice/relay.py）：{地址, 端口}，没有就 null。手机平板互相连不上时走它 */
    interface Relay { String[] get(); }
    private volatile Relay relay = () -> null;
    private volatile boolean viaRelay;
    void relay(Relay r) { relay = r; }

    PadLink(Context c, Listener l) {
        ctx = c.getApplicationContext();
        sp = ctx.getSharedPreferences("pad", Context.MODE_PRIVATE);
        nsd = ctx.getSystemService(NsdManager.class);
        out = l;
        hub = new PadHub(ctx, () -> { if (!"connected".equals(phase)) out.onState(state()); });
        host = sp.getString("host", "");
        port = sp.getInt("port", 0);
        id = sp.getString("id", "");
        key = id.isEmpty() ? null : PadCrypto.unb64(sp.getString("key", ""));
    }

    boolean paired() { return !sp.getString("id", "").isEmpty(); }

    JSONObject state() {
        try { return new JSONObject().put("phase", phase).put("sas", sas).put("error", error).put("paired", paired()).put("diag", "平板 " + myIps() + "；反连：" + hub.note() + "；电脑中转：" + (relay.get() == null ? "还没找到电脑" : relay.get()[0] + ":" + relay.get()[1])).put("phone", hub.ready() ? hub.peer() + "（手机连过来的）" : viaRelay ? "（经电脑 " + host + " 中转）" : host.isEmpty() ? "" : host + ":" + port); }
        catch (Exception e) { throw new IllegalStateException(e); }
    }
    private void set(String p, String err) { phase = p; error = err == null ? "" : err; out.onState(state()); }

    /** 打开 App 时：配对过就去连，没配对就等主人点「配对」 */
    void start() {
        stopped = false;
        hub.start();
        if (paired()) run();
        else set("idle", null);
    }
    void stop() { stopped = true; stopDiscovery(); hub.stop(); if (loop != null) loop.interrupt(); }

    /** 主人点「配对」：先找到手机，再交换公钥（手机上要先点「配对新平板」） */
    void pair() { pairing = true; sp.edit().remove("id").remove("key").remove("seq").apply(); id = ""; key = null; run(); }
    /** 忘掉这台手机（手机那边也要在「我的 → 平板」里取消） */
    void forget() { stop(); sp.edit().clear().apply(); host = ""; port = 0; id = ""; key = null; set("idle", null); }

    private synchronized void run() {
        stopped = false;   // 「忘掉」之后再点配对也要能跑起来
        hub.start();
        if (loop != null && loop.isAlive()) loop.interrupt();
        loop = new Thread(this::main, "xkpad-link");
        loop.start();
    }

    private void main() {
        long backoff = 2000;
        while (!stopped && !Thread.currentThread().isInterrupted()) {
            try {
                if (!hub.ready() && (host.isEmpty() || port == 0)) { set("searching", null); find(); }
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
                // 手机那边没有这台平板了（在手机上取消了配对）：再连也没用，清掉这边的，回到配对页让主人点「配对」
                if (String.valueOf(e.getMessage()).contains("没配对过")) {
                    sp.edit().remove("id").remove("key").remove("seq").apply();
                    id = ""; key = null; sas = "";
                    set("idle", "手机上已经没有这台平板的配对了（可能在手机上取消过），在手机上点「配对新平板」，再点下面的「配对」");
                    return;
                }
                set("searching", e.getMessage());
                host = ""; port = 0; viaRelay = false;   // 手机可能换了地址：下一圈重新找
                try { Thread.sleep(backoff); } catch (InterruptedException ie) { return; }
                backoff = Math.min(backoff * 2, 30000);
            }
        }
    }

    // ── 找手机：NSD 找到第一台就用（一个家里一般只有一台装了小克的手机） ──
    private void find() throws Exception {
        viaRelay = false;
        if (hub.await(3000)) return;   // 手机已经连过来了（反着连），不用找
        if (useRelay()) return;        // 手机挂在电脑的中转上（电脑开热点、两台互相连不上时）
        // 主人手动填过地址：先试它（手机开着 VPN 时，局域网里的广播有时根本找不到手机）
        String m = sp.getString("manual", "");
        if (!m.isEmpty()) {
            int i = m.lastIndexOf(':');
            String ok = reachable(new String[] { m.substring(0, i) }, Integer.parseInt(m.substring(i + 1)));
            if (ok != null) { host = ok; port = Integer.parseInt(m.substring(i + 1)); return; }
        }
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
                        // 手机开着 VPN 时会多报一个 VPN 的虚拟地址（198.18.x.x、172.19.x.x 之类），只拿第一个可能连不上：全记下来，下面挨个试
                        StringBuilder all = new StringBuilder();
                        java.util.List<java.net.InetAddress> as = android.os.Build.VERSION.SDK_INT >= 34 ? s2.getHostAddresses() : java.util.Collections.singletonList(s2.getHost());
                        for (java.net.InetAddress a : as) if (a instanceof java.net.Inet4Address) all.append(all.length() > 0 ? "," : "").append(a.getHostAddress());
                        if (all.length() == 0) all.append(s2.getHost().getHostAddress());
                        synchronized (lk) { got[0] = all + "|" + s2.getPort(); lk.notifyAll(); }
                    }
                });
            }
        };
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        try {
            synchronized (lk) {
                for (int n = 1; got[0] == null && got[1] == null && !hub.ready(); n++) {
                    lk.wait(1000);
                    if (n % 5 == 0 && useRelay()) break;   // 等手机的广播时，每 5 秒看一眼电脑的中转
                }
            }
        } finally { stopDiscovery(); }
        if (hub.ready() || viaRelay) return;
        if (got[1] != null) throw new java.io.IOException(got[1]);
        int p = Integer.parseInt(got[0].substring(got[0].indexOf('|') + 1));
        String[] hosts = got[0].substring(0, got[0].indexOf('|')).split(",");
        String ok = reachable(hosts, p);
        // 手机开着 VPN 时这边连不过去，但手机会反过来连平板：再等它一会儿
        if (ok == null && (hub.await(15_000) || useRelay())) return;
        if (ok == null) throw new java.io.IOException("找到手机了，但连不上（试过 " + String.join("、", hosts) + "），手机也没连过来。看看手机上的小克开着没有、是不是 0.3.8 以上；手机开着 Hiddify 之类的 VPN 的话，要在 VPN 里打开「绕过局域网」");
        host = ok; port = p;
        sp.edit().putString("host", host).putInt("port", port).apply();
    }

    private static String myIps() {
        StringBuilder b = new StringBuilder();
        try {
            for (java.net.NetworkInterface n : java.util.Collections.list(java.net.NetworkInterface.getNetworkInterfaces()))
                for (java.net.InetAddress a : java.util.Collections.list(n.getInetAddresses()))
                    if (a instanceof java.net.Inet4Address && !a.isLoopbackAddress()) b.append(b.length() > 0 ? "、" : "").append(a.getHostAddress());
        } catch (Exception e) { return "（读不到 IP：" + e.getMessage() + "）"; }
        return b.length() == 0 ? "没有局域网地址" : b.toString();
    }

    /** 挨个试连，回第一个连得上的（手机开着 VPN 时，Wi‑Fi 那个地址才连得上） */
    private static String reachable(String[] hosts, int port) {
        for (String h : hosts) {
            try (java.net.Socket t = new java.net.Socket()) { t.connect(new java.net.InetSocketAddress(h, port), 1500); return h; }
            catch (Exception e) { Log.i(TAG, "连不上 " + h + ":" + port + "：" + e.getMessage()); }
        }
        return null;
    }

    /** 自动找不到时，主人手动填手机的地址（手机上「我的 → 平板」里写着），之后照常配对或连接 */
    void manual(String h, int p) {
        host = h.trim(); port = p;
        sp.edit().putString("host", host).putInt("port", port).putString("manual", host + ":" + port).apply();
        if (paired()) run(); else pair();
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
    /** 问电脑上的中转：手机挂在上面没有。挂着就改走中转 */
    private boolean useRelay() {
        String[] r = relay.get();
        if (r == null) return false;
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(r[0], Integer.parseInt(r[1])), 1500);
            s.setSoTimeout(3000);
            s.getOutputStream().write("XKSTAT\n".getBytes(StandardCharsets.UTF_8));
            if (!"1".equals(headLine(s.getInputStream()))) return false;
        } catch (Exception e) { Log.i(TAG, "电脑中转问不了：" + e.getMessage()); return false; }
        host = r[0]; port = Integer.parseInt(r[1]); viaRelay = true;
        return true;
    }

    /** 到手机网关平板口子的一条新连接：手机连过来了就走它给的（开着 VPN 也通），经电脑中转就请电脑接一条，不然直接连 */
    java.net.Socket dial() throws Exception {
        if (hub.ready()) return hub.dial();
        if (viaRelay) {
            String[] r = relay.get();
            if (r == null) throw new java.io.IOException("电脑的语音服务断了，中转也跟着断了");
            java.net.Socket s = new java.net.Socket();
            try {
                s.connect(new java.net.InetSocketAddress(host, port), 5000);
                s.setTcpNoDelay(true);
                s.getOutputStream().write("XKWANT\n".getBytes(StandardCharsets.UTF_8));
                s.setSoTimeout(8000);
                String ok = headLine(s.getInputStream());
                if (!"OK".equals(ok)) throw new java.io.IOException("电脑中转：" + ok);
                s.setSoTimeout(0);
                return s;
            } catch (Exception e) { s.close(); throw e; }
        }
        java.net.Socket s = new java.net.Socket();
        try { s.connect(new java.net.InetSocketAddress(host, port), 5000); }
        catch (Exception e) { s.close(); throw e; }
        s.setTcpNoDelay(true);
        return s;
    }
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

    /** 一个请求一条连接（connection: close），所以手机连过来的线也能直接用 */
    private JSONObject post(String path, String body, int timeoutMs) throws Exception {
        try (java.net.Socket sk = dial()) {
            sk.setSoTimeout(timeoutMs);
            byte[] b = body.getBytes(StandardCharsets.UTF_8);
            OutputStream o = sk.getOutputStream();
            o.write(("POST " + path + " HTTP/1.1\r\nhost: xkpad\r\ncontent-type: application/json\r\ncontent-length: " + b.length + "\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
            o.write(b); o.flush();
            java.io.DataInputStream in = new java.io.DataInputStream(new java.io.BufferedInputStream(sk.getInputStream()));
            String status = headLine(in);
            if (!status.startsWith("HTTP/1.")) throw new java.io.IOException("手机回的不是 HTTP：" + status);
            int code = Integer.parseInt(status.split(" ")[1]);
            int len = -1; boolean chunked = false;
            for (String h; !(h = headLine(in)).isEmpty(); ) {
                String k = h.toLowerCase(java.util.Locale.ROOT);
                if (k.startsWith("content-length:")) len = Integer.parseInt(k.substring(15).trim());
                else if (k.startsWith("transfer-encoding:") && k.contains("chunked")) chunked = true;
            }
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            if (chunked) {
                for (int n; (n = Integer.parseInt(headLine(in).split(";")[0].trim(), 16)) > 0; headLine(in)) { byte[] c = new byte[n]; in.readFully(c); bo.write(c); }
            } else if (len >= 0) { byte[] c = new byte[len]; in.readFully(c); bo.write(c); }
            else { byte[] buf = new byte[8192]; for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n); }
            String t = new String(bo.toByteArray(), StandardCharsets.UTF_8);
            JSONObject j = t.isEmpty() ? new JSONObject() : new JSONObject(t);
            if (code >= 400 && !j.has("error")) j.put("error", "HTTP " + code);
            return j;
        }
    }
    private static String headLine(java.io.InputStream in) throws java.io.IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        for (int c; (c = in.read()) != '\n'; ) { if (c < 0) throw new java.io.IOException("手机那边断了"); if (c != '\r') b.write(c); }
        return new String(b.toByteArray(), StandardCharsets.UTF_8);
    }
}
