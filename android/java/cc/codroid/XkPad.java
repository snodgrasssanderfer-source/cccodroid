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
 */
final class XkPad {
    static final String TAG = "cccodroid";
    static final String TYPE = "_xkpad._tcp";
    private static volatile boolean started;

    static void start(Context c) {
        if (started) return;
        started = true;
        Context ctx = c.getApplicationContext();
        new Thread(() -> {
            // 网关刚起来时可能还没就绪：隔几秒问一次端口，问到为止
            for (int i = 0; ; i++) {
                try { register(ctx, port()); return; }
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
}
