package cc.codroid;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;

/**
 * 平板 App（第三步 3a）的手机一侧在外壳里只做一件事：在局域网里广播「这里有小克」（安卓 NSD，服务类型 _xkpad._tcp），
 * 平板 App 不用填地址就能找到手机。端口由网关定（gateway/gw/xk-pad.mjs 的 PAD_PORT），所以先问一次网关。
 * 配对、加密、放行哪些接口都在网关里；这个口子只有配对过的平板能用，广播出去也只是个服务名，不带主人的任何信息。
 *
 * 反着连（back）：手机开着 VPN 时，平板连进来的连接回不去（回包被 VPN 收走），往外连却没事。所以也去找平板广播的
 * _xkpadc._tcp，连过去挂一条控制线；平板要一条连接（'c'），就再连一条过去、接到本机网关的平板口子上。
 * 这里只搬字节：加密在平板和网关两头，搬运的这一截看不到内容。协议见 xk/pad/java/cc/codroid/pad/PadHub.java。
 */
final class XkPad {
    static final String TAG = "cccodroid";
    static final String TYPE = "_xkpad._tcp";
    static final String BACK = "_xkpadc._tcp";
    private static final java.util.Set<String> LINKED = java.util.concurrent.ConcurrentHashMap.newKeySet();
    private static volatile boolean started;

    static void start(Context c) {
        if (started) return;
        started = true;
        Context ctx = c.getApplicationContext();
        new Thread(() -> {
            // 网关刚起来时可能还没就绪：隔几秒问一次端口，问到为止
            for (int i = 0; ; i++) {
                try { int p = port(); register(ctx, p); back(ctx, p); return; }
                catch (Exception e) { if (i % 20 == 0) Log.w(TAG, "平板广播：还问不到网关的端口：" + e.getMessage()); }
                try { Thread.sleep(3000); } catch (InterruptedException e) { return; }
            }
        }, "xk-pad-nsd").start();
    }

    private static int port() throws Exception {
        HttpURLConnection c = Env.gateway("/api/xk/pad");
        try {
            c.setConnectTimeout(3000); c.setReadTimeout(5000);
            if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) {
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[4096];
                for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                return new JSONObject(new String(out.toByteArray(), StandardCharsets.UTF_8)).getInt("port");
            }
        } finally { c.disconnect(); }
    }

    private static void register(Context ctx, int port) {
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName("xkpad");   // 重名时系统自己加后缀；不放主人或设备的名字
        info.setServiceType(TYPE);
        info.setPort(port);
        NsdManager nsd = ctx.getSystemService(NsdManager.class);
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo s) { Log.i(TAG, "平板广播已开：" + s.getServiceName() + " 端口 " + port); }
            @Override public void onRegistrationFailed(NsdServiceInfo s, int code) { Log.w(TAG, "平板广播开不了，错误码 " + code); }
            @Override public void onServiceUnregistered(NsdServiceInfo s) { }
            @Override public void onUnregistrationFailed(NsdServiceInfo s, int code) { Log.w(TAG, "平板广播关不掉，错误码 " + code); }
        });
    }

    // ── 反着连 ──
    // 每一步都报给网关（「我的 → 平板」里看得到），开着 VPN 连不上时才知道卡在哪
    // 平板、电脑中转各记各的一行，拼起来报（只有一行时，一条路失败会盖掉另一条路成功的显示：#99）
    private static final java.util.Map<String, String> NOTES = new java.util.LinkedHashMap<>();
    private static volatile String lastNote = "";
    private static void note(String text) { noteFor("", text); }
    private static void noteFor(String who, String line) {
        Log.i(TAG, "反连：" + line);
        String text;
        synchronized (NOTES) {
            NOTES.put(who, line);
            text = String.join("；", NOTES.values());
        }
        if (text.equals(lastNote)) return;
        lastNote = text;
        new Thread(() -> {
            try {
                byte[] body = new JSONObject().put("text", text).toString().getBytes(StandardCharsets.UTF_8);
                HttpURLConnection c = Env.gateway("PUT", "/api/xk/pad/back", body);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (java.io.OutputStream o = c.getOutputStream()) { o.write(body); }
                c.getResponseCode();
                c.disconnect();
            } catch (Exception e) { Log.w(TAG, "反连：报不了状态给网关：" + e.getMessage()); }
        }, "xk-pad-note").start();
    }

    /** Wi‑Fi（或有线）那张网，不是 VPN。开着 VPN 时不指定网，找平板可能只在 VPN 上找（0.3.9 靠这个在真机上通的） */
    private static android.net.Network lan(Context ctx) {
        android.net.ConnectivityManager cm = ctx.getSystemService(android.net.ConnectivityManager.class);
        for (android.net.Network n : cm.getAllNetworks()) {
            android.net.NetworkCapabilities c = cm.getNetworkCapabilities(n);
            if (c != null && !c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_VPN)
                    && (c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_WIFI) || c.hasTransport(android.net.NetworkCapabilities.TRANSPORT_ETHERNET))) return n;
        }
        return null;
    }

    /** 连平板。试过先绑 Wi‑Fi（Network.bindSocket）：Hiddify 不许绕开，真机上一直是照常连通的，就不绕那一下了（0.3.9，#83） */
    private static java.net.Socket dialPad(java.net.InetAddress a, int port) throws java.io.IOException {
        java.net.Socket s = new java.net.Socket();
        try { s.connect(new java.net.InetSocketAddress(a, port), 3000); return s; }
        catch (java.io.IOException e) { close(s); throw e; }
    }

    private static void back(Context ctx, int padPort) {
        NsdManager nsd = ctx.getSystemService(NsdManager.class);
        new Thread(() -> {
            // 每 30 秒看一眼：没连着任何平板就重新找一遍（NSD 对同一台只报一次「找到了」，断了得重找）
            NsdManager.DiscoveryListener d = null;
            while (true) {
                if (LINKED.isEmpty()) {
                    if (d != null) try { nsd.stopServiceDiscovery(d); } catch (RuntimeException ignored) {}
                    d = discover(ctx, nsd, padPort);
                    viaGateway(ctx, padPort);
                }
                try { Thread.sleep(30_000); } catch (InterruptedException e) { return; }
            }
        }, "xk-pad-back").start();
    }

    /** 手机连着电脑开的热点时，电脑就是网关：电脑上的语音服务开着中转（xk/voice/relay.py，端口 8791），
     *  局域网广播过不来也能敲门找到它。门不开（家里路由器、电脑没开）就悄悄算了，30 秒后再来 */
    private static void viaGateway(Context ctx, int padPort) {
        android.net.Network w = lan(ctx);
        if (w == null) return;
        android.net.LinkProperties lp = ctx.getSystemService(android.net.ConnectivityManager.class).getLinkProperties(w);
        if (lp == null) return;
        java.net.InetAddress gw = null;
        for (android.net.RouteInfo r : lp.getRoutes())
            if (r.getDestination().getPrefixLength() == 0 && r.getGateway() instanceof java.net.Inet4Address) gw = r.getGateway();
        final java.net.InetAddress g = gw;
        if (g == null || !LINKED.add("gw")) return;
        new Thread(() -> {
            try {
                try (java.net.Socket t = new java.net.Socket()) { t.connect(new java.net.InetSocketAddress(g, 8791), 1500); }
                catch (java.io.IOException e) { return; }
                noteFor("电脑中转（网关）", "在网关 " + g.getHostAddress() + " 上找到电脑的中转，连过去");
                control(ctx, java.util.Collections.singletonList(g), 8791, padPort, "电脑中转（网关）");
            } finally { LINKED.remove("gw"); }
        }, "xk-pad-gw").start();
    }

    private static NsdManager.DiscoveryListener discover(Context ctx, NsdManager nsd, int padPort) {
        NsdManager.DiscoveryListener d = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { note("找平板开不了，错误码 " + code); }
            @Override public void onStopDiscoveryFailed(String t, int code) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                if (LINKED.contains(s.getServiceName())) return;
                note("看到广播了（平板或电脑中转），在问地址");
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo s2, int code) { note("看到广播了，但问不到地址，错误码 " + code); }
                    @Override public void onServiceResolved(NsdServiceInfo s2) {
                        java.util.List<java.net.InetAddress> as = android.os.Build.VERSION.SDK_INT >= 34 ? s2.getHostAddresses() : java.util.Collections.singletonList(s2.getHost());
                        String name = s2.getServiceName();
                        if (!LINKED.add(name)) return;
                        String who = name.startsWith("xkrelay") ? "电脑中转" : "平板";   // 电脑的中转报的名字是 xkrelay（xk/voice/server.py）
                        new Thread(() -> { try { control(ctx, as, s2.getPort(), padPort, who); } finally { LINKED.remove(name); } }, "xk-pad-ctl").start();
                    }
                });
            }
        };
        android.net.Network w = lan(ctx);
        if (android.os.Build.VERSION.SDK_INT >= 33 && w != null) {
            note("在 Wi‑Fi 里找平板…（平板上开着「小克 · 平板」才找得到）");
            nsd.discoverServices(BACK, NsdManager.PROTOCOL_DNS_SD, w, java.util.concurrent.Executors.newSingleThreadExecutor(), d);
        } else {
            note(w == null ? "没连 Wi‑Fi，照常找平板…" : "在局域网里找平板…");
            nsd.discoverServices(BACK, NsdManager.PROTOCOL_DNS_SD, d);
        }
        return d;
    }

    /** 挂着控制线，平板要一条就开一条；断了就回去（外面会重新找） */
    private static void control(Context ctx, java.util.List<java.net.InetAddress> as, int port, int padPort, String who) {
        StringBuilder fails = new StringBuilder();
        for (java.net.InetAddress a : as) {
            if (!(a instanceof java.net.Inet4Address)) continue;
            java.net.Socket c;
            try { c = dialPad(a, port); }
            catch (java.io.IOException e) { fails.append(a.getHostAddress()).append(":").append(port).append(" ").append(e.getMessage()).append("；"); continue; }
            try {
                java.io.OutputStream o = c.getOutputStream();
                o.write("XKREV\n".getBytes(StandardCharsets.US_ASCII)); o.flush();
                // 等平板回 OK：开着 VPN 时 connect 可能只是 VPN 在本机接下的，线根本没到平板（手机开热点时就这样）
                c.setSoTimeout(5000);
                InputStream in0 = c.getInputStream();
                StringBuilder ok = new StringBuilder();
                try { for (int b; (b = in0.read()) >= 0 && b != '\n' && ok.length() < 8; ) ok.append((char) b); }
                catch (java.net.SocketTimeoutException e) { ok.setLength(0); }
                if (!"OK".equals(ok.toString())) {
                    fails.append(a.getHostAddress()).append(" 连上了但没回话（这条线没真到对面：可能被 VPN 或热点拦下了）；");
                    close(c);
                    continue;
                }
                noteFor(who, who + " " + a.getHostAddress() + "：连上了");
                c.setSoTimeout(45_000);
                Thread ping = new Thread(() -> {
                    try { while (true) { Thread.sleep(15_000); synchronized (c) { o.write('p'); o.flush(); } } }
                    catch (Exception e) { close(c); }
                }, "xk-pad-ping");
                ping.start();
                InputStream in = in0;
                try {
                    for (int b; (b = in.read()) >= 0; ) if (b == 'c') pipe(ctx, a, port, padPort);
                } finally { ping.interrupt(); }
                noteFor(who, who + " " + a.getHostAddress() + "：线断了（对面关了或网断了），过一会儿重新找");
            } catch (java.io.IOException e) {
                noteFor(who, who + " " + a.getHostAddress() + "：线断了：" + e.getMessage());
            } finally { close(c); }
            return;
        }
        noteFor(who, "找到" + who + "了，但连不上：" + fails);
    }

    /** 往平板开一条数据线，接到本机网关的平板口子上，两头互相搬 */
    private static void pipe(Context ctx, java.net.InetAddress a, int port, int padPort) {
        new Thread(() -> {
            java.net.Socket t = null, g = new java.net.Socket();
            try {
                t = dialPad(a, port);
                t.setTcpNoDelay(true);
                t.getOutputStream().write("XKDATA\n".getBytes(StandardCharsets.US_ASCII));
            } catch (java.io.IOException e) { note("给平板开数据线失败：" + e.getMessage()); close(t); return; }
            try {
                g.connect(new java.net.InetSocketAddress("127.0.0.1", padPort), 3000);
                g.setTcpNoDelay(true);
            } catch (java.io.IOException e) { note("本机网关的平板口子连不上（" + padPort + "）：" + e.getMessage() + "。在「我的 → 平板」点一下「配对新平板」会打开它"); close(t); close(g); return; }
            java.util.concurrent.atomic.AtomicInteger left = new java.util.concurrent.atomic.AtomicInteger(2);
            copy(t, g, left); copy(g, t, left);
        }, "xk-pad-pipe").start();
    }
    private static void copy(java.net.Socket from, java.net.Socket to, java.util.concurrent.atomic.AtomicInteger left) {
        new Thread(() -> {
            try {
                InputStream in = from.getInputStream(); java.io.OutputStream o = to.getOutputStream();
                byte[] buf = new byte[64 * 1024];
                for (int n; (n = in.read(buf)) > 0; ) { o.write(buf, 0, n); o.flush(); }
                to.shutdownOutput();   // 这头说完了，另一头可能还有话：只关一半
                if (left.decrementAndGet() == 0) { close(from); close(to); }
            } catch (java.io.IOException e) { close(from); close(to); }
        }, "xk-pad-copy").start();
    }

    private static void close(java.io.Closeable c) { if (c != null) try { c.close(); } catch (java.io.IOException ignored) {} }
}
