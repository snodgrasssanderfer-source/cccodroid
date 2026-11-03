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
    private static void back(Context ctx, int padPort) {
        NsdManager nsd = ctx.getSystemService(NsdManager.class);
        new Thread(() -> {
            // 每 30 秒看一眼：没连着任何平板就重新找一遍（NSD 对同一台只报一次「找到了」，断了得重找）
            NsdManager.DiscoveryListener d = null;
            while (true) {
                if (LINKED.isEmpty()) {
                    if (d != null) try { nsd.stopServiceDiscovery(d); } catch (RuntimeException ignored) {}
                    d = discover(nsd, padPort);
                }
                try { Thread.sleep(30_000); } catch (InterruptedException e) { return; }
            }
        }, "xk-pad-back").start();
    }

    private static NsdManager.DiscoveryListener discover(NsdManager nsd, int padPort) {
        NsdManager.DiscoveryListener d = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { Log.w(TAG, "找平板：开不了，错误码 " + code); }
            @Override public void onStopDiscoveryFailed(String t, int code) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                if (LINKED.contains(s.getServiceName())) return;
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo s2, int code) { Log.w(TAG, "找平板：解析不了，错误码 " + code); }
                    @Override public void onServiceResolved(NsdServiceInfo s2) {
                        java.util.List<java.net.InetAddress> as = android.os.Build.VERSION.SDK_INT >= 34 ? s2.getHostAddresses() : java.util.Collections.singletonList(s2.getHost());
                        String name = s2.getServiceName();
                        if (!LINKED.add(name)) return;
                        new Thread(() -> { try { control(as, s2.getPort(), padPort); } finally { LINKED.remove(name); } }, "xk-pad-ctl").start();
                    }
                });
            }
        };
        nsd.discoverServices(BACK, NsdManager.PROTOCOL_DNS_SD, d);
        return d;
    }

    /** 挂着控制线，平板要一条就开一条；断了就回去（外面会重新找） */
    private static void control(java.util.List<java.net.InetAddress> as, int port, int padPort) {
        for (java.net.InetAddress a : as) {
            if (!(a instanceof java.net.Inet4Address)) continue;
            java.net.Socket c = new java.net.Socket();
            try {
                c.connect(new java.net.InetSocketAddress(a, port), 3000);
            } catch (java.io.IOException e) { Log.i(TAG, "平板 " + a.getHostAddress() + " 连不上：" + e.getMessage()); close(c); continue; }
            Log.i(TAG, "连上平板了：" + a.getHostAddress());
            try {
                c.setSoTimeout(45_000);
                java.io.OutputStream o = c.getOutputStream();
                o.write("XKREV\n".getBytes(StandardCharsets.US_ASCII)); o.flush();
                Thread ping = new Thread(() -> {
                    try { while (true) { Thread.sleep(15_000); synchronized (c) { o.write('p'); o.flush(); } } }
                    catch (Exception e) { close(c); }
                }, "xk-pad-ping");
                ping.start();
                InputStream in = c.getInputStream();
                try {
                    for (int b; (b = in.read()) >= 0; ) if (b == 'c') pipe(a, port, padPort);
                } finally { ping.interrupt(); }
            } catch (java.io.IOException e) {
                Log.i(TAG, "和平板的控制线断了：" + e.getMessage());
            } finally { close(c); }
            return;
        }
    }

    /** 往平板开一条数据线，接到本机网关的平板口子上，两头互相搬 */
    private static void pipe(java.net.InetAddress a, int port, int padPort) {
        new Thread(() -> {
            java.net.Socket t = new java.net.Socket(), g = new java.net.Socket();
            try {
                t.connect(new java.net.InetSocketAddress(a, port), 3000);
                t.setTcpNoDelay(true);
                t.getOutputStream().write("XKDATA\n".getBytes(StandardCharsets.US_ASCII));
                g.connect(new java.net.InetSocketAddress("127.0.0.1", padPort), 3000);
                g.setTcpNoDelay(true);
            } catch (java.io.IOException e) {
                Log.w(TAG, "给平板开数据线失败：" + e.getMessage());
                close(t); close(g); return;
            }
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
