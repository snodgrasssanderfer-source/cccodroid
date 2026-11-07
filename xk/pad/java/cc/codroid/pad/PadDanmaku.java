package cc.codroid.pad;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Handler;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.TextView;

/**
 * 弹幕（主人 11-07：照 B 站直播间加个弹幕模式）：QQ 群里的话从右往左飘过手机画面。
 * 只占画面上面四成，分几条轨道；一条轨道上一句的尾巴离开右边才放下一句，轨道全满就丢掉（不堆积、不遮整屏）。
 * 画在 Java 里，压在 TextureView 上面：全屏时网页整块藏起来，也照样有弹幕。
 */
final class PadDanmaku {
    private static final int MAX_LANES = 10;
    private static final long CROSS_MS = 9000;   // 一句从右边飘到左边大约这么久（跟 B 站差不多）
    private final Context ctx;
    private final FrameLayout box;
    private final Handler ui;
    private final SharedPreferences sp;
    private final long[] laneFree = new long[MAX_LANES];
    private boolean on;

    PadDanmaku(Context ctx, FrameLayout box, Handler ui) {
        this.ctx = ctx; this.box = box; this.ui = ui;
        sp = ctx.getSharedPreferences("danmaku", Context.MODE_PRIVATE);
        on = sp.getBoolean("on", true);
    }

    boolean on() { return on; }
    void setOn(boolean v) {
        on = v;
        sp.edit().putBoolean("on", v).apply();
        if (!v) ui.post(this::clear);
    }

    /** who 为空就只显示内容；color 是文字颜色 */
    void add(String who, String text, int color) {
        if (!on || TextUtils.isEmpty(text)) return;
        final String line = (TextUtils.isEmpty(who) ? "" : who + "：") + (text.length() > 60 ? text.substring(0, 60) + "…" : text);
        ui.post(() -> shoot(line, color));
    }

    private void shoot(String line, int color) {
        int w = box.getWidth(), h = box.getHeight();
        if (!on || w <= 0 || h <= 0 || box.getVisibility() != View.VISIBLE) return;
        float px = Math.max(26f, Math.min(h / 22f, 48f));
        int laneH = Math.round(px * 1.45f);
        int lanes = Math.max(1, Math.min(MAX_LANES, (int) (h * 0.4f / laneH)));
        long now = SystemClock.uptimeMillis();
        int lane = -1;
        for (int i = 0; i < lanes; i++) if (laneFree[i] <= now) { lane = i; break; }
        if (lane < 0) return;   // 轨道都满：这句不飘了（互动区里照样有）

        TextView t = new TextView(ctx);
        t.setText(line);
        t.setSingleLine(true);
        t.setTextColor(color);
        t.setTextSize(TypedValue.COMPLEX_UNIT_PX, px);
        t.setShadowLayer(px / 8f, 0, 0, 0xE0000000);
        t.setIncludeFontPadding(false);
        t.setContentDescription("danmaku");
        t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        t.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
        int tw = t.getMeasuredWidth();
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
        lp.topMargin = Math.round(px * 0.6f) + lane * laneH;
        // 压在画面上、「退出全屏」下面：插在 TextureView（第 0 个）后面
        box.addView(t, Math.min(1, box.getChildCount()), lp);
        float speed = (w + tw) / (float) CROSS_MS;   // 每毫秒多少像素：长句飘得稍快，过屏时间一样
        t.setTranslationX(w);
        t.animate().translationX(-tw).setDuration(CROSS_MS).setInterpolator(new LinearInterpolator())
                .withEndAction(() -> box.removeView(t)).start();
        laneFree[lane] = now + (long) ((tw + px * 2) / speed);
    }

    private void clear() {
        for (int i = box.getChildCount() - 1; i >= 0; i--) {
            View v = box.getChildAt(i);
            if ("danmaku".contentEquals(String.valueOf(v.getContentDescription()))) { v.animate().cancel(); box.removeViewAt(i); }
        }
        java.util.Arrays.fill(laneFree, 0);
    }

    static int colorFor(boolean mine, boolean owner) { return mine ? Color.rgb(255, 178, 122) : owner ? Color.rgb(251, 114, 153) : Color.WHITE; }
}
