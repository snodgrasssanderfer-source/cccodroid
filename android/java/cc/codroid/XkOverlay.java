package cc.codroid;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.Log;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * 小克的悬浮窗（#32，设计稿 xk/design/presence.md 第一节）：盖在别的 App 上面的小圆片 + 顶上一行字幕。
 * 主人离开 App 也看得到她在做什么；网关重启时倒数、重启好了说一声（浮层在外壳里，网关重启时它不跟着没）。
 * 「谁、什么状态、说什么」由网关（gateway/gw/xk-overlay.mjs）整理好推过来，这里只管画。
 * App 在前台时收起（聊天页上本来就看得到）。
 */
final class XkOverlay {
    static final String TAG = "cccodroid";
    private static volatile XkOverlay self;
    static XkOverlay get(Context c) {
        if (self == null) synchronized (XkOverlay.class) { if (self == null) self = new XkOverlay(c.getApplicationContext()); }
        return self;
    }

    private final Context ctx;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final WindowManager wm;
    private final SharedPreferences sp;
    private final float dp;
    private final Map<String, Bitmap> art = new HashMap<>();   // "xiaoke/bubble_idle" → 图；网关重启时取不到，所以先全取好

    // 网关推来的状态（主线程读写）
    private boolean enabled, permitted, asked;
    private String role = "xiaoke", state = "idle", line = "";
    private long lineAt;
    private boolean dot;                     // 她说完一段、主人还没回来看：小圆片上一个小点
    // 重启倒计时：0 不在倒数；>0 数到那个时刻；之后等 pid 变
    private long countTo, doneAt;
    private String countText = "";
    private int oldPid;
    private boolean waitingPid;

    private FrameLayout bubble;
    private ImageView face;
    private View dotView;
    private LinearLayout strip;
    private TextView stripText;
    private ProgressBar stripBar;
    private Thread loop;

    private XkOverlay(Context c) {
        ctx = c;
        wm = c.getSystemService(WindowManager.class);
        sp = c.getSharedPreferences("xk-overlay", Context.MODE_PRIVATE);
        dp = c.getResources().getDisplayMetrics().density;
    }

    void start() {
        if (loop != null && loop.isAlive()) return;
        loop = new Thread(this::events, "xk-overlay");
        loop.setDaemon(true);
        loop.start();
        ui.post(tick);
    }

    // ── 每秒一次：前台 / 后台、权限、倒计时 ──
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            boolean can = Settings.canDrawOverlays(ctx);
            if (can != permitted) { permitted = can; report(); }
            // 主人在「我的」里打开了，但还没给权限：App 在前台时带他去系统设置（只带一次，不反复弹）
            if (enabled && !can && !asked && MainActivity.visible) {
                asked = true;
                try {
                    ctx.startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + ctx.getPackageName())).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                } catch (RuntimeException e) { Log.w(TAG, "悬浮窗：打不开权限设置页", e); }
            }
            boolean show = enabled && can && !MainActivity.visible;
            if (show && bubble == null) attach();
            else if (!show && bubble != null) detach();
            if (bubble != null) render();
            ui.postDelayed(this, 1000);
        }
    };

    private void attach() {
        bubble = new FrameLayout(ctx);
        int size = (int) (56 * dp);
        GradientDrawable ring = new GradientDrawable();
        ring.setShape(GradientDrawable.OVAL);
        bubble.setBackground(ring);
        bubble.setElevation(6 * dp);
        bubble.setOutlineProvider(ViewOutlineProvider.BACKGROUND);
        face = new ImageView(ctx);
        face.setScaleType(ImageView.ScaleType.CENTER_CROP);
        face.setClipToOutline(true);
        face.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View v, Outline o) { o.setOval(0, 0, v.getWidth(), v.getHeight()); }
        });
        int pad = (int) (3 * dp);
        FrameLayout.LayoutParams fl = new FrameLayout.LayoutParams(size - 2 * pad, size - 2 * pad, Gravity.CENTER);
        bubble.addView(face, fl);
        dotView = new View(ctx);
        GradientDrawable d = new GradientDrawable();
        d.setShape(GradientDrawable.OVAL);
        d.setColor(0xFFE5484D);
        d.setStroke((int) (1.5f * dp), Color.WHITE);
        dotView.setBackground(d);
        int ds = (int) (12 * dp);
        bubble.addView(dotView, new FrameLayout.LayoutParams(ds, ds, Gravity.TOP | Gravity.END));

        WindowManager.LayoutParams lp = params(size, size, WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = sp.getInt("x", 100000);   // 第一次：右边贴边（下面按屏宽收回来）
        lp.y = sp.getInt("y", (int) (160 * dp));
        clampToEdge(lp);
        bubble.setOnTouchListener(new Drag(lp));

        strip = new LinearLayout(ctx);
        strip.setOrientation(LinearLayout.VERTICAL);
        int sp8 = (int) (8 * dp);
        strip.setPadding((int) (12 * dp), sp8, (int) (12 * dp), sp8);
        stripText = new TextView(ctx);
        stripText.setTextColor(Color.WHITE);
        stripText.setTextSize(14);
        stripText.setMaxLines(2);
        stripText.setEllipsize(TextUtils.TruncateAt.END);
        strip.addView(stripText);
        stripBar = new ProgressBar(ctx, null, android.R.attr.progressBarStyleHorizontal);
        stripBar.setMax(1000);
        stripBar.setVisibility(View.GONE);
        strip.addView(stripBar, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, (int) (4 * dp)));
        // 字幕点击穿透：不挡主人，也不挡她以后操作屏幕
        WindowManager.LayoutParams slp = params(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE);
        slp.gravity = Gravity.TOP;
        slp.y = (int) (36 * dp);
        slp.horizontalMargin = 0.04f;
        try {
            wm.addView(strip, slp);
            wm.addView(bubble, lp);
        } catch (RuntimeException e) {
            // 权限刚被收回之类：说清楚，下一秒再试
            Log.w(TAG, "悬浮窗：加不上浮层", e);
            detach();
        }
    }

    private void detach() {
        for (View v : new View[] { bubble, strip }) if (v != null && v.isAttachedToWindow()) try { wm.removeView(v); } catch (RuntimeException ignored) {}
        bubble = null; strip = null;
    }

    private static WindowManager.LayoutParams params(int w, int h, int flags) {
        return new WindowManager.LayoutParams(w, h, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                flags | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, PixelFormat.TRANSLUCENT);
    }

    private int screenW() { return ctx.getResources().getDisplayMetrics().widthPixels; }
    private void clampToEdge(WindowManager.LayoutParams lp) {
        int w = screenW(), size = (int) (56 * dp);
        lp.x = lp.x + size / 2 < w / 2 ? 0 : w - size;   // 贴到近的那条边
        lp.y = Math.max(0, Math.min(lp.y, ctx.getResources().getDisplayMetrics().heightPixels - size));
    }

    /** 拖动：松手贴边、记住位置；没怎么动就算点了一下 → 打开 App。长按 3 秒留给以后「主人接管」（陪玩那一步） */
    private final class Drag implements View.OnTouchListener {
        final WindowManager.LayoutParams lp;
        float sx, sy; int ox, oy; boolean moved;
        Drag(WindowManager.LayoutParams lp) { this.lp = lp; }
        @Override public boolean onTouch(View v, MotionEvent e) {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN: sx = e.getRawX(); sy = e.getRawY(); ox = lp.x; oy = lp.y; moved = false; return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - sx, dy = e.getRawY() - sy;
                    if (Math.abs(dx) + Math.abs(dy) > 8 * dp) moved = true;
                    if (moved) { lp.x = ox + (int) dx; lp.y = oy + (int) dy; update(v, lp); }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (moved) { clampToEdge(lp); update(v, lp); sp.edit().putInt("x", lp.x).putInt("y", lp.y).apply(); }
                    else open();
                    return true;
                default: return false;
            }
        }
    }
    private void update(View v, WindowManager.LayoutParams lp) { try { wm.updateViewLayout(v, lp); } catch (RuntimeException ignored) {} }

    private void open() {
        dot = false;
        Intent i = ctx.getPackageManager().getLaunchIntentForPackage(ctx.getPackageName());
        if (i != null) ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED));
    }

    // ── 画 ──
    private static int color(String role) {
        return "hachimi".equals(role) ? 0xFF8A63D2 : "deepseek".equals(role) ? 0xFF3F74C8 : 0xFFF08A3C;
    }
    private static String dir(String role) { return "deepseek".equals(role) ? "xiaoyu" : role; }

    private void render() {
        long now = System.currentTimeMillis();
        String img = "bubble_" + state, text = line;
        Float progress = null;
        if (countTo > 0) {
            img = "restart";
            long left = (countTo - now + 999) / 1000;
            text = left > 0 ? countText + "  " + left : "重启中…";
            if (left <= 0 && !waitingPid) waitPid();
        } else if (doneAt > 0) {
            img = "restart_done";
            text = "重启好了";
            if (now - doneAt > 4000) doneAt = 0;
        } else if (sayUntil > now) {
            text = say; progress = sayProgress;
        }
        Bitmap b = art.get(dir(role) + "/" + img);
        if (b == null) b = art.get(dir(role) + "/bubble_idle");
        face.setImageBitmap(b);
        GradientDrawable ring = (GradientDrawable) bubble.getBackground();
        ring.setColor(Color.WHITE);
        ring.setStroke((int) (2.5f * dp), color(role));
        dotView.setVisibility(dot ? View.VISIBLE : View.GONE);
        // 字幕：有话就显示；她闲下来以后 8 秒收起
        boolean fresh = countTo > 0 || doneAt > 0 || sayUntil > now || ("busy".equals(state) || "talk".equals(state)) || now - lineAt < 8000;
        boolean showStrip = fresh && text != null && !text.isEmpty();
        strip.setVisibility(showStrip ? View.VISIBLE : View.GONE);
        if (showStrip) {
            GradientDrawable bg = new GradientDrawable();
            bg.setCornerRadius(14 * dp);
            bg.setColor((color(role) & 0x00FFFFFF) | 0xE6000000);
            strip.setBackground(bg);
            stripText.setText(text);
            stripBar.setVisibility(progress != null ? View.VISIBLE : View.GONE);
            if (progress != null) stripBar.setProgress((int) (progress * 1000));
        }
    }

    // overlay_say：一句话（可带进度），显示 6 秒
    private String say = "";
    private Float sayProgress;
    private long sayUntil;

    // ── 网关事件流（同 Notify 的写法）──
    private void events() {
        String lastId = null;
        while (true) {
            HttpURLConnection c = null;
            try {
                c = Env.gateway("/api/events");
                c.setConnectTimeout(3000);
                c.setReadTimeout(45_000);
                if (lastId != null) c.setRequestProperty("Last-Event-ID", lastId);
                if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
                snapshot();
                StringBuilder data = new StringBuilder();
                for (String l; (l = r.readLine()) != null; ) {
                    if (l.isEmpty()) { if (data.length() > 0) { onEvent(data.toString()); data.setLength(0); } }
                    else if (l.startsWith("data:")) { if (data.length() > 0) data.append('\n'); data.append(l.substring(l.startsWith("data: ") ? 6 : 5)); }
                    else if (l.startsWith("id:")) lastId = l.substring(3).trim();
                }
            } catch (Exception e) {
                // 网关还没起来 / 正在重启：等着重连（重启倒计时就是靠这段断开显示「重启中」）
            } finally { if (c != null) c.disconnect(); }
            try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
        }
    }

    /** 连上时拿一次全貌和图（图只取一次：网关重启那几秒取不到） */
    private void snapshot() {
        try {
            JSONObject o = getJson("/api/xk/overlay");
            ui.post(() -> { enabled = o.optBoolean("enabled"); apply(o); });
            if (art.isEmpty()) loadArt();
            report();
        } catch (Exception e) { Log.w(TAG, "悬浮窗：取状态失败", e); }
    }

    private void loadArt() {
        Map<String, Bitmap> got = new HashMap<>();
        for (String r : new String[] { "xiaoke", "hachimi", "xiaoyu" })
            for (String n : new String[] { "bubble_idle", "bubble_busy", "bubble_talk", "bubble_rest", "bubble_sleep", "restart", "restart_done" }) {
                String p = "/xk-art/overlay/" + r + "/" + n + ".webp";
                HttpURLConnection c = null;
                try {
                    c = Env.gateway(p);
                    if (c.getResponseCode() != 200) throw new java.io.IOException("HTTP " + c.getResponseCode());
                    try (InputStream in = c.getInputStream()) {
                        Bitmap b = BitmapFactory.decodeStream(in);
                        if (b == null) throw new java.io.IOException("解不开");
                        got.put(r + "/" + n, b);
                    }
                } catch (Exception e) { Log.w(TAG, "悬浮窗：取图失败 " + p + "：" + e.getMessage()); }
                finally { if (c != null) c.disconnect(); }
            }
        ui.post(() -> art.putAll(got));
    }

    private void onEvent(String json) {
        try {
            JSONObject ev = new JSONObject(json);
            if (!"xk".equals(ev.optString("type"))) return;
            String op = ev.optString("op");
            ui.post(() -> {
                if ("overlay".equals(op)) apply(ev);
                else if ("overlay_config".equals(op)) { boolean was = enabled; enabled = ev.optBoolean("enabled"); if (enabled && !was) asked = false; }
                else if ("overlay_say".equals(op)) {
                    say = ev.optString("text"); sayUntil = System.currentTimeMillis() + 6000;
                    sayProgress = ev.isNull("progress") ? null : (float) ev.optDouble("progress");
                } else if ("overlay_countdown".equals(op)) {
                    countText = ev.optString("text"); oldPid = ev.optInt("pid");
                    countTo = System.currentTimeMillis() + ev.optLong("seconds") * 1000; doneAt = 0; waitingPid = false;
                }
                if (bubble != null) render();
            });
        } catch (Exception e) { Log.w(TAG, "悬浮窗：事件解析失败", e); }
    }

    private void apply(JSONObject o) {
        String nl = o.optString("line");
        if (!nl.equals(line)) lineAt = System.currentTimeMillis();
        // 她说完一段（talk → 闲下来）而主人不在 App 里：点上小点，点开 App 才消
        if ("talk".equals(state) && !"talk".equals(o.optString("state")) && !MainActivity.visible) dot = true;
        role = o.optString("role", role); state = o.optString("state", state); line = nl;
    }

    /** 倒数完：等网关换了个进程（/api/status 的 pid 变了）才算重启好了；2 分钟还没回来就照实说 */
    private void waitPid() {
        waitingPid = true;
        new Thread(() -> {
            long until = System.currentTimeMillis() + 120_000;
            while (System.currentTimeMillis() < until) {
                try {
                    int pid = getJson("/api/status").optInt("pid");
                    if (pid != 0 && pid != oldPid) { ui.post(() -> { countTo = 0; doneAt = System.currentTimeMillis(); }); return; }
                } catch (Exception ignored) { /* 还没起来 */ }
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
            ui.post(() -> { countTo = 0; say = "网关 2 分钟了还没重启好，打开 App 看看"; sayProgress = null; sayUntil = System.currentTimeMillis() + 60_000; });
        }, "xk-overlay-pid").start();
    }

    /** 权限有没有给：报给网关，「我的」里的开关据此说清楚 */
    private void report() {
        boolean p = permitted;
        new Thread(() -> {
            try {
                byte[] body = new JSONObject().put("permitted", p).toString().getBytes(StandardCharsets.UTF_8);
                HttpURLConnection c = Env.gateway("PUT", "/api/xk/overlay/config", body);
                c.setDoOutput(true);
                c.setRequestProperty("content-type", "application/json");
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
                c.getResponseCode();
                c.disconnect();
            } catch (Exception e) { /* 网关没起来：连上后 snapshot 会再报一次 */ }
        }, "xk-overlay-report").start();
    }

    private static JSONObject getJson(String path) throws Exception {
        HttpURLConnection c = Env.gateway(path);
        try {
            c.setConnectTimeout(3000); c.setReadTimeout(5000);
            if (c.getResponseCode() != 200) throw new java.io.IOException(path + " → HTTP " + c.getResponseCode());
            try (InputStream in = c.getInputStream()) { return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8)); }
        } finally { c.disconnect(); }
    }
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toByteArray();
    }
}
