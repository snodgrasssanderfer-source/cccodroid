package cc.codroid.pad;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * 反着连：手机开着 VPN 时，平板连手机的连接回不来（手机的回包被 VPN 收走了），手机往外连平板却没事。
 * 所以平板也开一个口子、在局域网里广播（_xkpadc._tcp）；手机（外壳 android/java/cc/codroid/XkPad.java）找到后
 * 连过来挂一条控制线。平板要发请求时在控制线上写一个 'c'，手机就再连一条过来（先写 "XKDATA\n"），
 * 接到它自己网关的平板口子上。加密照旧是平板和网关两头的事，这里只搬字节，所以谁连上来都偷看不到、改不了。
 * 控制线一开头平板回 "OK\n"：手机开着 VPN 时，连接可能只是 VPN 在手机本机接下的、根本没到平板（开热点时就这样），
 * 等不到 OK 就知道这条线是假的。之后两边每 15 秒互发一个 'p'，45 秒没动静就当断了。
 */
final class PadHub {
    static final String TAG = "xkpad";
    static final String TYPE = "_xkpadc._tcp";

    private final NsdManager nsd;
    private ServerSocket ss;
    private NsdManager.RegistrationListener reg;
    private volatile Socket ctl;
    private volatile String peer = "";
    private volatile String note = "反连口子还没开";
    private final LinkedBlockingQueue<Socket> data = new LinkedBlockingQueue<>();
    private final Object lk = new Object();

    private final Runnable changed;
    PadHub(Context c, Runnable changed) { nsd = c.getSystemService(NsdManager.class); this.changed = changed; }
    private void say(String n) { note = n; Log.i(TAG, n); changed.run(); }

    synchronized void start() {
        if (ss != null) return;
        try { ss = new ServerSocket(0); }
        catch (IOException e) { say("反连口子开不了：" + e.getMessage()); return; }
        final ServerSocket s = ss;
        new Thread(() -> accept(s), "xkpad-hub").start();
        NsdServiceInfo info = new NsdServiceInfo();
        info.setServiceName("xkpadc");   // 不放主人或设备的名字
        info.setServiceType(TYPE);
        info.setPort(s.getLocalPort());
        reg = new NsdManager.RegistrationListener() {
            @Override public void onServiceRegistered(NsdServiceInfo i) { say("已广播（口子 " + s.getLocalPort() + "），等手机连过来"); }
            @Override public void onRegistrationFailed(NsdServiceInfo i, int code) { say("广播不了，错误码 " + code); }
            @Override public void onServiceUnregistered(NsdServiceInfo i) { }
            @Override public void onUnregistrationFailed(NsdServiceInfo i, int code) { }
        };
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, reg);
    }

    synchronized void stop() {
        if (reg != null) try { nsd.unregisterService(reg); } catch (RuntimeException ignored) {}
        reg = null;
        close(ss); ss = null;
        close(ctl); ctl = null; peer = "";
        for (Socket s; (s = data.poll()) != null; ) close(s);
    }

    boolean ready() { return ctl != null; }
    String peer() { return peer; }
    String note() { return note; }

    /** 等手机连过来，最多等 ms 毫秒 */
    boolean await(long ms) throws InterruptedException {
        long until = System.currentTimeMillis() + ms;
        synchronized (lk) { while (ctl == null && System.currentTimeMillis() < until) lk.wait(Math.max(1, until - System.currentTimeMillis())); }
        return ctl != null;
    }

    /** 要一条到手机网关的连接（同一时间只要一条，免得拿错） */
    synchronized Socket dial() throws IOException, InterruptedException {
        Socket c = ctl;
        if (c == null) throw new IOException("手机还没连过来");
        for (Socket s; (s = data.poll()) != null; ) close(s);   // 上次等超时后才到的，丢掉
        synchronized (c) { OutputStream o = c.getOutputStream(); o.write('c'); o.flush(); }
        Socket s = data.poll(5, TimeUnit.SECONDS);
        if (s == null) throw new IOException("手机 5 秒没连回来");
        return s;
    }

    private void accept(ServerSocket s) {
        while (!s.isClosed()) {
            final Socket c;
            try { c = s.accept(); } catch (IOException e) { return; }
            new Thread(() -> hello(c), "xkpad-hub-in").start();
        }
    }

    private void hello(Socket s) {
        try {
            s.setSoTimeout(5000);
            String line = line(s.getInputStream());
            if ("XKREV".equals(line)) { synchronized (s) { s.getOutputStream().write("OK\n".getBytes(java.nio.charset.StandardCharsets.US_ASCII)); s.getOutputStream().flush(); } control(s); }
            else if ("XKDATA".equals(line)) { s.setSoTimeout(0); s.setTcpNoDelay(true); data.offer(s); }
            else close(s);
        } catch (IOException e) { Log.i(TAG, "反连进来的连接断了：" + e.getMessage()); close(s); }
    }

    private void control(Socket s) throws IOException {
        Socket old = ctl;
        synchronized (lk) { ctl = s; peer = s.getInetAddress().getHostAddress(); lk.notifyAll(); }
        if (old != null) close(old);
        say("手机 " + peer + " 连过来了");
        s.setSoTimeout(45_000);
        InputStream in = s.getInputStream();
        try {
            // 手机每 15 秒发 'p'，回它一个 'p'，它也就知道平板还在
            while (in.read() >= 0) synchronized (s) { s.getOutputStream().write('p'); s.getOutputStream().flush(); }
        } catch (SocketTimeoutException e) {
            say("手机 45 秒没动静，当断了，等它重连");
        } finally {
            synchronized (lk) { if (ctl == s) { ctl = null; peer = ""; } }
            close(s);
        }
    }

    private static String line(InputStream in) throws IOException {
        StringBuilder b = new StringBuilder();
        for (int c; (c = in.read()) >= 0 && c != '\n'; ) { if (b.length() > 32) throw new IOException("开头不对"); b.append((char) c); }
        return b.toString().trim();
    }

    private static void close(java.io.Closeable c) { if (c != null) try { c.close(); } catch (IOException ignored) {} }
}
