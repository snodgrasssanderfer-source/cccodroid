package cc.codroid.pad;

import android.content.Context;
import android.content.SharedPreferences;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaPlayer;
import android.media.MediaRecorder;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.util.Log;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * 语音（设计稿第五节）：直连主人电脑上的语音服务（xk/voice/server.py），不经手机。
 *   念：她们在群里说的话按句送去念，拿回 WAV 排队放（取下一句和放这一句同时进行）。
 *   听：按住麦克风录 16kHz 单声道，松手送去转文字，交给聊天页发进群。
 * 电脑在家里 Wi‑Fi 里报 _xkvoice._tcp，配对码主人填一次（请求头 x-xk-code）。
 */
final class PadVoice {
    static final String TAG = "xkpad";
    static final String TYPE = "_xkvoice._tcp";
    interface Out { void onVoice(JSONObject st); void onHeard(String text, String error); }

    private final Context ctx;
    private final SharedPreferences sp;
    private final NsdManager nsd;
    private final Out out;
    private volatile String host = "", error = "";
    private volatile int port;
    private volatile JSONObject health;
    private NsdManager.DiscoveryListener discovery;

    PadVoice(Context c, Out out) {
        ctx = c.getApplicationContext();
        sp = ctx.getSharedPreferences("voice", Context.MODE_PRIVATE);
        nsd = ctx.getSystemService(NsdManager.class);
        this.out = out;
        new Thread(this::fetchLoop, "xkvoice-fetch").start();
        new Thread(this::playLoop, "xkvoice-play").start();
    }

    JSONObject state() {
        try {
            return new JSONObject().put("found", !host.isEmpty()).put("host", host.isEmpty() ? "" : host + ":" + port)
                    .put("ok", health != null).put("voices", health == null ? new org.json.JSONArray() : health.optJSONArray("voices"))
                    .put("on", sp.getBoolean("on", true)).put("hasCode", !code().isEmpty()).put("error", error);
        } catch (Exception e) { throw new IllegalStateException(e); }
    }
    private void changed() { out.onVoice(state()); }
    private String code() { return sp.getString("code", ""); }

    void setOn(boolean on) { sp.edit().putBoolean("on", on).apply(); if (!on) stopTalking(); changed(); }
    void setCode(String c) { sp.edit().putString("code", c.trim().toUpperCase(java.util.Locale.ROOT)).apply(); health = null; check(); }

    // ── 找电脑：在家里 Wi‑Fi 里找 _xkvoice._tcp，找到就用配对码问一声 ──
    synchronized void find() {
        if (discovery != null) return;
        error = ""; changed();
        discovery = new NsdManager.DiscoveryListener() {
            @Override public void onStartDiscoveryFailed(String t, int code) { error = "找电脑开不了，错误码 " + code; synchronized (PadVoice.this) { discovery = null; } changed(); }
            @Override public void onStopDiscoveryFailed(String t, int code) { }
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo s2, int code) { error = "找到电脑了，但问不到地址（错误码 " + code + "）"; changed(); }
                    @Override public void onServiceResolved(NsdServiceInfo s2) {
                        host = s2.getHost().getHostAddress(); port = s2.getPort();
                        stopFind();
                        check();
                    }
                });
            }
        };
        nsd.discoverServices(TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
    }
    private synchronized void stopFind() {
        if (discovery != null) try { nsd.stopServiceDiscovery(discovery); } catch (RuntimeException ignored) {}
        discovery = null;
    }

    /** 用配对码问一下电脑：通了就记下哪几个人挑好了音色 */
    void check() {
        if (host.isEmpty()) { find(); return; }
        new Thread(() -> {
            try {
                if (code().isEmpty()) { health = null; error = "找到电脑了，填一下电脑上语音服务窗口里的配对码"; }
                else { health = new JSONObject(new String(http("GET", "/health", null, null, 5000), StandardCharsets.UTF_8)); error = ""; }
            } catch (IOException e) {
                health = null; error = e.getMessage();
                if (e instanceof java.net.ConnectException || e instanceof java.net.SocketTimeoutException) { host = ""; find(); }
            } catch (Exception e) { health = null; error = "电脑回的看不懂：" + e.getMessage(); }
            changed();
        }, "xkvoice-check").start();
    }

    private byte[] http(String method, String path, byte[] body, String type, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL("http://" + host + ":" + port + path).openConnection();
        try {
            c.setConnectTimeout(3000); c.setReadTimeout(timeout);
            c.setRequestMethod(method);
            c.setRequestProperty("x-xk-code", code());
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("content-type", type);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
            }
            int st = c.getResponseCode();
            InputStream in = st < 400 ? c.getInputStream() : c.getErrorStream();
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            if (in != null) try (InputStream i2 = in) { byte[] buf = new byte[16384]; for (int n; (n = i2.read(buf)) > 0; ) b.write(buf, 0, n); }
            if (st >= 400) {
                String msg;
                try { msg = new JSONObject(b.toString("UTF-8")).optString("error", "HTTP " + st); } catch (Exception e) { msg = "HTTP " + st; }
                throw new IOException(msg);
            }
            return b.toByteArray();
        } finally { c.disconnect(); }
    }

    // ── 念：按句排队，取和放分两条线 ──
    private static final class Line { final String role, text; final long gen; Line(String r, String t, long g) { role = r; text = t; gen = g; } }
    private static final class Clip { final File f; final long gen; Clip(File f, long g) { this.f = f; this.gen = g; } }
    private final LinkedBlockingQueue<Line> lines = new LinkedBlockingQueue<>();
    private final LinkedBlockingQueue<Clip> clips = new LinkedBlockingQueue<>();
    private volatile long gen;   // 主人按住说话时加一：排着的、正放的都作废
    private volatile MediaPlayer playing;
    private int seq;

    /** 群里她说了一段：开着「念出来」、电脑通了、她挑好了音色才念 */
    void say(String role, String text) {
        if (!sp.getBoolean("on", true) || health == null) return;
        org.json.JSONArray vs = health.optJSONArray("voices");
        boolean has = false;
        for (int i = 0; vs != null && i < vs.length(); i++) if (role.equals(vs.optString(i))) has = true;
        if (!has) return;
        for (String s : sentences(text)) lines.add(new Line(role, s, gen));
    }

    /** 去掉代码块、链接、Markdown 记号，按句号问号叹号换行切开；太短的并到上一句 */
    static java.util.List<String> sentences(String text) {
        String t = text.replaceAll("(?s)```.*?```", "").replaceAll("`[^`]*`", "")
                .replaceAll("!?\\[([^\\]]*)\\]\\([^)]*\\)", "$1").replaceAll("https?://\\S+", "")
                .replaceAll("(?m)^\\s*([-*+]|\\d+[.)、])\\s+", "").replaceAll("[*_#>|~]+", "");
        java.util.List<String> out = new java.util.ArrayList<>();
        StringBuilder cur = new StringBuilder();
        for (int i = 0; i < t.length(); i++) {
            char ch = t.charAt(i);
            if (ch == '\n') { flush(out, cur); continue; }
            cur.append(ch);
            if ("。！？!?；;…".indexOf(ch) >= 0 && cur.toString().trim().length() >= 6) flush(out, cur);
        }
        flush(out, cur);
        return out;
    }
    private static void flush(java.util.List<String> out, StringBuilder cur) {
        String s = cur.toString().trim();
        cur.setLength(0);
        if (s.replaceAll("[\\p{P}\\s]", "").isEmpty()) return;
        if (!out.isEmpty() && s.length() < 6) {
            String prev = out.get(out.size() - 1);
            out.set(out.size() - 1, prev + ("，。！？!?；;…：:".indexOf(prev.charAt(prev.length() - 1)) >= 0 ? "" : "，") + s);
        }
        else out.add(s);
    }

    private void fetchLoop() {
        while (true) {
            Line l;
            try { l = lines.take(); } catch (InterruptedException e) { return; }
            if (l.gen != gen) continue;
            try {
                byte[] wav = http("POST", "/tts", new JSONObject().put("role", l.role).put("text", l.text).toString().getBytes(StandardCharsets.UTF_8), "application/json", 60_000);
                File f = new File(ctx.getCacheDir(), "tts-" + (seq++ % 8) + ".wav");
                try (FileOutputStream o = new FileOutputStream(f)) { o.write(wav); }
                clips.add(new Clip(f, l.gen));
            } catch (Exception e) {
                Log.w(TAG, "念不了：" + e.getMessage());
                error = "念不了：" + e.getMessage(); changed();
            }
        }
    }

    private void playLoop() {
        while (true) {
            Clip c;
            try { c = clips.take(); } catch (InterruptedException e) { return; }
            if (c.gen != gen) continue;
            final Object done = new Object();
            MediaPlayer mp = new MediaPlayer();
            try {
                mp.setDataSource(c.f.getPath());
                mp.setOnCompletionListener(m -> { synchronized (done) { done.notifyAll(); } });
                mp.setOnErrorListener((m, w, x) -> { synchronized (done) { done.notifyAll(); } return true; });
                mp.prepare();
                playing = mp;
                synchronized (done) { mp.start(); done.wait(120_000); }
            } catch (Exception e) {
                Log.w(TAG, "放不了：" + e.getMessage());
            } finally { playing = null; mp.release(); }
        }
    }

    /** 停掉正在念的和排着的 */
    void stopTalking() {
        gen++;
        lines.clear(); clips.clear();
        MediaPlayer mp = playing;
        if (mp != null) try { mp.stop(); } catch (IllegalStateException ignored) {}
    }

    // ── 听：按住录、松手送去转文字 ──
    private volatile AudioRecord rec;
    private volatile ByteArrayOutputStream pcm;

    /** 按下：先停掉她正在念的（免得录进去），开始录。要先有录音权限 */
    void listenStart() {
        stopTalking();
        int rate = 16000, min = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        AudioRecord r;
        try { r = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, rate)); }
        catch (SecurityException e) { out.onHeard("", "没有录音权限"); return; }
        if (r.getState() != AudioRecord.STATE_INITIALIZED) { r.release(); out.onHeard("", "麦克风打不开（别的 App 在用？）"); return; }
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        rec = r; pcm = b;
        r.startRecording();
        new Thread(() -> {
            byte[] buf = new byte[3200];
            while (rec == r) { int n = r.read(buf, 0, buf.length); if (n > 0) synchronized (b) { b.write(buf, 0, n); } }
        }, "xkvoice-rec").start();
    }

    /** 松手：停录，太短就算了，不然送去转文字 */
    void listenStop() {
        AudioRecord r = rec; ByteArrayOutputStream b = pcm;
        rec = null;
        if (r == null) return;
        try { r.stop(); } catch (IllegalStateException ignored) {}
        r.release();
        byte[] data;
        synchronized (b) { data = b.toByteArray(); }
        if (data.length < 16000 * 2 / 2) { out.onHeard("", "太短了，按住多说一会儿"); return; }
        new Thread(() -> {
            try {
                String t = new JSONObject(new String(http("POST", "/asr", wav(data, 16000), "audio/wav", 30_000), StandardCharsets.UTF_8)).optString("text");
                out.onHeard(t, t.isEmpty() ? "没听清" : null);
            } catch (Exception e) { out.onHeard("", "转不了文字：" + e.getMessage()); }
        }, "xkvoice-asr").start();
    }

    /** 16 位单声道 PCM 加上 WAV 头 */
    static byte[] wav(byte[] pcm, int rate) {
        java.nio.ByteBuffer h = java.nio.ByteBuffer.allocate(44).order(java.nio.ByteOrder.LITTLE_ENDIAN);
        h.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length).put("WAVE".getBytes(StandardCharsets.US_ASCII))
                .put("fmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16).putShort((short) 1).putShort((short) 1)
                .putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16)
                .put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length);
        byte[] out = new byte[44 + pcm.length];
        System.arraycopy(h.array(), 0, out, 0, 44);
        System.arraycopy(pcm, 0, out, 44, pcm.length);
        return out;
    }
}
