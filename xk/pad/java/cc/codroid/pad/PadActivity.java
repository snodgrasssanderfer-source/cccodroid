package cc.codroid.pad;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.SurfaceTexture;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.widget.FrameLayout;
import android.widget.LinearLayout;

import org.json.JSONObject;

/**
 * 小克 · 平板的唯一一页：一边是手机画面（串流，点了才开），一边是聊天页（assets/pad.html，WebView）。
 * 横着放左右分，竖着放上下分。网页只管画；找手机、配对、加密都在 PadLink，网页经 window.Pad 调它。
 */
public class PadActivity extends Activity implements PadLink.Listener, PadStream.Listener {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private PadLink link;
    private PadStream stream;
    private WebView web;
    private LinearLayout root;
    private FrameLayout screenBox;
    private TextureView screen;
    private Surface surface;
    private int vw, vh;   // 手机画面的宽高（服务端报的）

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        root = new LinearLayout(this);
        root.setBackgroundColor(Color.rgb(255, 247, 238));
        screenBox = new FrameLayout(this);
        screenBox.setBackgroundColor(Color.BLACK);
        screen = new TextureView(this);
        screen.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture st, int w, int h) { surface = new Surface(st); }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture st, int w, int h) { fitScreen(); }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture st) { stopStream(); surface = null; return true; }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture st) { }
        });
        screenBox.addView(screen, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        screenBox.setVisibility(View.GONE);   // 没开串流时整块收起，聊天页占满
        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        web.addJavascriptInterface(new Bridge(), "Pad");
        web.loadUrl("file:///android_asset/pad.html");
        root.addView(screenBox);
        root.addView(web);
        layout(getResources().getConfiguration());
        setContentView(root);
        link = new PadLink(this, this);
        link.start();
    }

    @Override public void onConfigurationChanged(Configuration c) { super.onConfigurationChanged(c); layout(c); }

    /** 横着：画面在左（占 3/5），聊天在右；竖着：画面在上，聊天在下各一半 */
    private void layout(Configuration c) {
        boolean land = c.orientation == Configuration.ORIENTATION_LANDSCAPE;
        root.setOrientation(land ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        screenBox.setLayoutParams(new LinearLayout.LayoutParams(land ? 0 : -1, land ? -1 : 0, 3));
        web.setLayoutParams(new LinearLayout.LayoutParams(land ? 0 : -1, land ? -1 : 0, land ? 2 : 3));
        ui.post(this::fitScreen);
    }

    /** 画面按手机的长宽比缩放、居中，不拉伸 */
    private void fitScreen() {
        if (vw <= 0 || vh <= 0 || screenBox.getWidth() == 0) return;
        float k = Math.min(screenBox.getWidth() / (float) vw, screenBox.getHeight() / (float) vh);
        screen.setLayoutParams(new FrameLayout.LayoutParams((int) (vw * k), (int) (vh * k), Gravity.CENTER));
    }

    private void js(String fn, String json) { ui.post(() -> web.evaluateJavascript("window." + fn + "&&window." + fn + "(" + json + ")", null)); }

    // ── PadLink ──
    @Override public void onState(JSONObject st) { js("padState", st.toString()); if (!"connected".equals(st.optString("phase"))) ui.post(this::stopStream); }
    @Override public void onEvent(JSONObject ev) { js("padEvent", ev.toString()); }

    // ── PadStream ──
    @Override public void onSize(int w, int h) { vw = w; vh = h; ui.post(this::fitScreen); }
    @Override public void onEnd(String why) {
        ui.post(() -> { stream = null; screenBox.setVisibility(View.GONE); });
        js("padStream", JSONObject.quote(why == null ? "" : why));
    }

    private void startStream() {
        if (stream != null) return;
        screenBox.setVisibility(View.VISIBLE);
        // 画面区刚显示出来，TextureView 的 surface 要等一下才有
        ui.postDelayed(() -> {
            if (surface == null) { onEnd("画面区还没准备好，再点一次"); return; }
            stream = new PadStream(link, surface, this);
            stream.start();
            js("padStream", "\"on\"");
        }, 200);
    }
    private void stopStream() { PadStream s = stream; stream = null; if (s != null) s.close(); }

    @Override protected void onDestroy() { stopStream(); link.stop(); super.onDestroy(); }

    /** 网页（pad.html）能调的：看状态、配对、忘掉手机、加密请求、开关串流 */
    final class Bridge {
        @JavascriptInterface public String state() { return link.state().toString(); }
        @JavascriptInterface public void pair() { link.pair(); }
        @JavascriptInterface public void forget() { link.forget(); }
        @JavascriptInterface public void stream(boolean on) { ui.post(() -> { if (on) startStream(); else stopStream(); }); }
        /** 异步：结果回 window.padReply(id, {s, b} 或 {error}) */
        @JavascriptInterface public void call(int id, String method, String path, String body) {
            new Thread(() -> {
                JSONObject r;
                try { r = link.call(method, path, body == null || body.isEmpty() ? null : new JSONObject(body)); }
                catch (Exception e) { r = new JSONObject(); try { r.put("error", "连不上手机：" + e.getMessage()); } catch (Exception ignored) {} }
                final JSONObject out = r;
                ui.post(() -> web.evaluateJavascript("window.padReply&&window.padReply(" + id + "," + out + ")", null));
            }, "xkpad_call").start();
        }
    }
}
