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
public class PadActivity extends Activity implements PadLink.Listener, PadStream.Listener, PadUpdate.Out, PadVoice.Out {
    private final Handler ui = new Handler(Looper.getMainLooper());
    private PadLink link;
    private PadUpdate upd;
    private PadVoice voice;
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
        setContentView(root);
        // 平板转屏、让开键盘或系统栏时大小会变：每次都按新大小重排
        root.addOnLayoutChangeListener((v, l, t, r, bt, ol, ot, orr, ob) -> { if (r - l != orr - ol || bt - t != ob - ot) ui.post(this::arrange); });
        // 安卓 15 起（targetSdk 35）窗口铺到状态栏和导航栏底下：不让开的话，右上角「看手机画面」被电量图标盖住、输入框被键盘盖住
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            root.setOnApplyWindowInsetsListener((v, in) -> {
                android.graphics.Insets bars = in.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets ime = in.getInsets(android.view.WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, ime.bottom));
                return android.view.WindowInsets.CONSUMED;
            });
            // 底色是浅的：状态栏、导航栏的图标用深色
            int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(light, light);
        }
        link = new PadLink(this, this);
        upd = new PadUpdate(this, link, this);
        voice = new PadVoice(this, this);
        link.relay(voice::relay);
        voice.check();
        link.start();
    }

    @Override public void onConfigurationChanged(Configuration c) { super.onConfigurationChanged(c); layout(c); }

    private void layout(Configuration c) { ui.post(this::arrange); }

    /**
     * 画面那一块跟着手机画面的比例走，不再按权重写死（#90：平板横、手机竖时左右一大片黑边）。
     * 左右并排和上下叠两种都算一遍，哪种画面大用哪种（手机转横屏时自然变成画面在上、聊天在下）；
     * 聊天页至少留 1/3，画面算出来超了才在剩下的地方等比缩小、留一点黑边。
     */
    private void arrange() {
        int w = root.getWidth() - root.getPaddingLeft() - root.getPaddingRight();
        int h = root.getHeight() - root.getPaddingTop() - root.getPaddingBottom();
        if (screenBox.getVisibility() != View.VISIBLE || w <= 0 || h <= 0) {
            web.setLayoutParams(new LinearLayout.LayoutParams(-1, -1));
            return;
        }
        boolean land = w >= h;
        int pw = vw > 0 ? vw : 9, ph = vh > 0 ? vh : 20;   // 还没拿到尺寸时先按手机竖屏猜
        float side = Math.min(w * 2f / 3 / pw, (float) h / ph), stack = Math.min((float) w / pw, h * 2f / 3 / ph);
        boolean beside = side > stack || (side == stack && land);
        root.setOrientation(beside ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        if (beside) {
            screenBox.setLayoutParams(new LinearLayout.LayoutParams(Math.round(pw * side), -1));
            web.setLayoutParams(new LinearLayout.LayoutParams(0, -1, 1));
        } else {
            screenBox.setLayoutParams(new LinearLayout.LayoutParams(-1, Math.round(ph * stack)));
            web.setLayoutParams(new LinearLayout.LayoutParams(-1, 0, 1));
        }
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
    @Override public void onState(JSONObject st) {
        js("padState", st.toString());
        if ("connected".equals(st.optString("phase"))) upd.check();
        else ui.post(this::stopStream);
    }
    @Override public void onUpdate(JSONObject st) { js("padUpdate", st.toString()); }
    @Override public void onVoice(JSONObject st) { js("padVoice", st.toString()); }
    @Override public void onHeard(String text, String error) {
        try { js("padHeard", new JSONObject().put("text", text).put("error", error == null ? "" : error).toString()); } catch (Exception ignored) {}
    }
    @Override public void onEvent(JSONObject ev) { js("padEvent", ev.toString()); }

    // ── PadStream ──
    @Override public void onSize(int w, int h) { vw = w; vh = h; ui.post(this::arrange); }
    @Override public void onEnd(String why) {
        ui.post(() -> { stream = null; screenBox.setVisibility(View.GONE); arrange(); });
        js("padStream", JSONObject.quote(why == null ? "" : why));
    }

    private void startStream() {
        if (stream != null) return;
        screenBox.setVisibility(View.VISIBLE);
        arrange();
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
        @JavascriptInterface public void update() { upd.install(); }
        @JavascriptInterface public String voiceState() { return voice.state().toString(); }
        @JavascriptInterface public void voiceOn(boolean on) { voice.setOn(on); }
        @JavascriptInterface public void voiceCode(String code) { voice.setCode(code); }
        @JavascriptInterface public void voiceFind() { voice.check(); }
        @JavascriptInterface public void say(String role, String text) { voice.say(role, text); }
        /** 按住说话：第一次先要录音权限（要到了再按一次） */
        @JavascriptInterface public void listen(boolean down) {
            if (!down) { voice.listenStop(); return; }
            if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                ui.post(() -> requestPermissions(new String[] { android.Manifest.permission.RECORD_AUDIO }, 1));
                onHeard("", "允许录音后再按住说一次");
                return;
            }
            voice.listenStart();
        }
        @JavascriptInterface public void manual(String host, int port) { link.manual(host, port); }
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
