package cc.codroid.pad;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInstaller;
import android.os.Build;
import android.util.Base64;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.security.MessageDigest;

/**
 * 平板 App 自己更新：问手机网关最新版（gateway/gw/xk-padupd.mjs，它去我们的 Release 下好、核过 sha256），
 * 比自己新就在聊天页顶上提示；主人点了，分块拿过来写进系统安装器的会话，再核一遍 sha256，交给系统装（会弹确认）。
 * 系统只认同一把签名钥匙，别人塞的包装不上。
 */
final class PadUpdate {
    static final String TAG = "xkpad";
    private static final String ACTION = "cc.codroid.pad.INSTALLED";
    interface Out { void onUpdate(JSONObject st); }

    private final Context ctx;
    private final PadLink link;
    private final Out out;
    private volatile long checked;
    private volatile boolean busy;

    PadUpdate(Context c, PadLink link, Out out) {
        ctx = c.getApplicationContext(); this.link = link; this.out = out;
        BroadcastReceiver r = new BroadcastReceiver() {
            @Override public void onReceive(Context c2, Intent i) { installed(i); }
        };
        IntentFilter f = new IntentFilter(ACTION);
        if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(r, f, Context.RECEIVER_NOT_EXPORTED);
        else ctx.registerReceiver(r, f);
    }

    /** 连上手机时调：6 小时内问过就不问；手机还在下，过 20 秒再问（最多等两分钟） */
    void check() {
        if (System.currentTimeMillis() - checked < 6 * 3600_000L) return;
        checked = System.currentTimeMillis();
        new Thread(() -> {
            try {
                for (int i = 0; i < 6; i++) {
                    JSONObject r = link.call("GET", "/pad/update", null);
                    if (r.optInt("s") != 200) { Log.w(TAG, "问不了新版：" + r.optString("error")); return; }
                    JSONObject b = r.getJSONObject("b");
                    String v = b.optString("version");
                    if (!v.isEmpty() && newer(v, mine())) { say("new", v, 0, null); return; }
                    if (!b.optBoolean("checking")) { if (!b.optString("error").isEmpty()) Log.w(TAG, "手机那边：" + b.optString("error")); return; }
                    Thread.sleep(20_000);
                }
            } catch (Exception e) { checked = 0; Log.w(TAG, "问新版断了：" + e.getMessage()); }
        }, "xkpad-upd-check").start();
    }

    /** 主人点了「更新」 */
    void install() {
        if (busy) return;
        busy = true;
        new Thread(() -> {
            PackageInstaller.Session s = null;
            String v = "";
            try {
                JSONObject b = link.call("GET", "/pad/update", null).getJSONObject("b");
                v = b.getString("version");
                long total = b.getLong("size");
                String sha = b.getString("sha256");
                PackageInstaller pi = ctx.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                p.setAppPackageName(ctx.getPackageName());
                int sid = pi.createSession(p);
                s = pi.openSession(sid);
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (OutputStream o = s.openWrite("pad.apk", 0, total)) {
                    for (long off = 0; off < total; ) {
                        JSONObject c = link.call("GET", "/pad/update/chunk", new JSONObject().put("v", v).put("off", off));
                        if (c.optInt("s") != 200) throw new java.io.IOException(c.optString("error", "手机没给这一块"));
                        byte[] d = Base64.decode(c.getJSONObject("b").getString("data"), Base64.DEFAULT);
                        if (d.length == 0) throw new java.io.IOException("手机给的块是空的");
                        o.write(d); md.update(d); off += d.length;
                        say("downloading", v, (int) (off * 100 / total), null);
                    }
                    s.fsync(o);
                }
                StringBuilder h = new StringBuilder();
                for (byte x : md.digest()) h.append(String.format("%02x", x));
                if (!h.toString().equals(sha)) throw new java.io.IOException("拿到的包和手机说的 sha256 对不上，没装");
                Intent i = new Intent(ACTION).setPackage(ctx.getPackageName());
                PendingIntent done = PendingIntent.getBroadcast(ctx, sid, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                say("installing", v, 100, null);
                s.commit(done.getIntentSender());
                s.close(); s = null;
            } catch (Exception e) {
                if (s != null) s.abandon();
                say("error", v, 0, "更新没成：" + e.getMessage());
            } finally { busy = false; }
        }, "xkpad-upd").start();
    }

    /** 系统安装器回话：要主人确认就弹确认页；装好了这个进程会被换掉，不用管 */
    private void installed(Intent i) {
        int st = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (st == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
            if (confirm != null) { confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); ctx.startActivity(confirm); }
        } else if (st != PackageInstaller.STATUS_SUCCESS) {
            say("error", "", 0, "系统没装上：" + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
        }
    }

    private void say(String state, String v, int pct, String err) {
        try { out.onUpdate(new JSONObject().put("state", state).put("version", v).put("pct", pct).put("error", err == null ? "" : err)); }
        catch (Exception ignored) {}
    }

    private String mine() {
        try { return ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).versionName; }
        catch (Exception e) { return "0"; }
    }

    /** 按数字一段段比（0.3.10 比 0.3.9 新） */
    static boolean newer(String a, String b) {
        String[] x = a.split("[^0-9]+"), y = b.split("[^0-9]+");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            long p = i < x.length && !x[i].isEmpty() ? Long.parseLong(x[i]) : 0, q = i < y.length && !y[i].isEmpty() ? Long.parseLong(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }
}
