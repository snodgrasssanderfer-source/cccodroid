package cc.codroid;

import android.content.Context;
import android.util.Log;

import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

import rikka.shizuku.Shizuku;

/**
 * 平板串流（第三步 3b）的手机一侧：网关说「开始串流」（事件 stream_start，gateway/gw/xk-pad.mjs）时，
 * 经 Shizuku 以 shell 身份起易控的服务端（xk/pad/server，GPL-3.0，随包带在 assets/xk-stream-server.jar，单独一个程序）。
 * 服务端只听本机；平板经网关加密中转，不直连它。起不来就把原因报给网关，平板上看得到。
 * 要 shell 身份是因为录屏（含声音 REMOTE_SUBMIX）、注入按键要它；这样不用每次弹「允许录屏」。
 */
final class XkStream {
    static final String TAG = "cccodroid";
    private static final String ASSET = "xk-stream-server.jar";
    private static volatile java.lang.Process proc;

    private static volatile String lastSid = "";

    static void start(Context c, JSONObject ev) {
        Context ctx = c.getApplicationContext();
        String sid = ev.optString("sid");
        // 事件流断线重连时会补发错过的事件：同一次串流只起一回
        synchronized (XkStream.class) { if (sid.equals(lastSid)) return; lastSid = sid; }
        new Thread(() -> {
            try { run(ctx, ev.getJSONObject("opts")); }
            catch (Exception e) { Log.w(TAG, "串流服务端起不来", e); report(sid, e.getMessage()); }
        }, "xk-stream").start();
    }

    private static void run(Context ctx, JSONObject opts) throws Exception {
        if (!Priv.running()) throw new IllegalStateException("Shizuku 没在运行：串流要它以 shell 身份录屏。到小克的设置 → 设备里打开");
        if (!Priv.granted()) throw new IllegalStateException("小克还没拿到 Shizuku 授权");
        // 上一次的还在就停掉：服务端一次只服务一个平板，断开后自己会退，这里只防残留
        java.lang.Process old = proc;
        if (old != null) old.destroy();
        int vc = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionCode;
        String jar = "/data/local/tmp/xk-stream-server-" + vc + ".jar";
        // shell 读不了小克的私有目录：和易控一样放到 /data/local/tmp（按版本号命名，换版本时旧的一起清掉）
        java.lang.Process put = newProcess(new String[]{"sh", "-c", "[ -s " + jar + " ] && exit 0; rm -f /data/local/tmp/xk-stream-server-*.jar; cat > " + jar + ".tmp && mv " + jar + ".tmp " + jar}, null, "/");
        try (InputStream in = ctx.getAssets().open(ASSET); OutputStream o = put.getOutputStream()) {
            byte[] buf = new byte[65536];
            for (int n; (n = in.read(buf)) > 0; ) o.write(buf, 0, n);
        } catch (java.io.IOException e) {
            // 已经有这一版的 jar 时 shell 直接退出，写入会断管：不算错
            if (put.waitFor() != 0) throw e;
        }
        if (put.waitFor() != 0) throw new IllegalStateException("服务端放不到 /data/local/tmp（退出码 " + put.exitValue() + "）");
        StringBuilder args = new StringBuilder();
        for (Iterator<String> it = opts.keys(); it.hasNext(); ) {
            String k = it.next();
            args.append(' ').append(k).append('=').append(opts.get(k));
        }
        proc = newProcess(new String[]{"sh", "-c", "exec app_process -Djava.class.path=" + jar + " / com.shiyunjin.easycontrolnext.server.Server" + args}, null, "/");
        Log.i(TAG, "串流服务端已起：" + args);
        // 服务端的输出只进日志（出错时排查用），它自己在平板断开后退出
        java.lang.Process p = proc;
        new Thread(() -> {
            try (java.io.BufferedReader r = new java.io.BufferedReader(new java.io.InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8))) {
                for (String l; (l = r.readLine()) != null; ) Log.w(TAG, "串流服务端：" + l);
            } catch (Exception ignored) {}
        }, "xk-stream-log").start();
    }

    /** Shizuku.newProcess 在 13.x 里是 private：和 Priv 一样反射拿出来用（rish 走的也是这条路） */
    private static java.lang.Process newProcess(String[] argv, String[] envp, String dir) throws Exception {
        Method m = Shizuku.class.getDeclaredMethod("newProcess", String[].class, String[].class, String.class);
        m.setAccessible(true);
        return (java.lang.Process) m.invoke(null, argv, envp, dir);
    }

    private static void report(String sid, String error) {
        try {
            byte[] body = new JSONObject().put("sid", sid).put("error", error == null ? "起不来" : error).toString().getBytes(StandardCharsets.UTF_8);
            HttpURLConnection c = Env.gateway("PUT", "/api/xk/pad/stream", body);
            c.setDoOutput(true);
            c.setRequestProperty("content-type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body); }
            c.getResponseCode();
            c.disconnect();
        } catch (Exception e) { Log.w(TAG, "串流：报不了错给网关", e); }
    }
}
