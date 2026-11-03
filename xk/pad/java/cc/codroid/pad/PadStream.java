package cc.codroid.pad;

import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Pair;
import android.view.Surface;

import com.shiyunjin.easycontrolnext.app.client.decode.AudioDecode;
import com.shiyunjin.easycontrolnext.app.client.decode.DecodecTools;
import com.shiyunjin.easycontrolnext.app.client.decode.VideoDecode;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 平板上看手机画面（第三步 3b）。读法照易控 ClientPlayer（GPL-3.0，见 xk/pad/NOTICE.md）：
 *   main 连接：1 字节有没有声音 →（有）1 字节是不是 Opus → 循环 [1 字节类型 1 声音 / 2 剪贴板 / 3 尺寸变了][内容]；
 *   video 连接：1 字节是不是 H.265 → 宽、高 → csd0（H.264 还有 csd1）→ 循环 [4 字节长度][一帧]。
 * 不一样的只有连接：不直连手机上的服务端，而是开到手机网关的升级连接（gateway/gw/xk-pad.mjs streamUpgrade），
 * 双向逐块 AES-GCM，每条连接每个方向一把子密钥、计数 nonce。客户端每 5 秒在 main 上发一个保活字节（易控服务端 20 秒没收到就退）。
 */
final class PadStream {
    static final String TAG = "xkpad";
    interface Listener { void onSize(int w, int h); void onEnd(String why); }

    private final PadLink link;
    private final Surface surface;
    private final Listener out;
    private volatile boolean closed;
    private Socket mainSock, videoSock;
    private final HandlerThread play = new HandlerThread("xkpad_play", Thread.MAX_PRIORITY);
    private Thread mainIn, videoIn, alive;

    PadStream(PadLink link, Surface surface, Listener out) { this.link = link; this.surface = surface; this.out = out; }

    /** 开始：让手机起服务端 → 先连 main 再连 video（服务端按这个顺序 accept） */
    void start() {
        new Thread(() -> {
            try {
                JSONObject r = link.call("POST", "/pad/stream/start",
                        new JSONObject().put("h265", DecodecTools.isSupportH265()).put("opus", DecodecTools.isSupportOpus()));
                if (r.optInt("s") != 200) throw new IOException(r.optString("error", "手机没答应开串流"));
                String sid = r.getJSONObject("b").getString("sid");
                Chan main = open("main", sid), video = open("video", sid);
                mainSock = main.sock; videoSock = video.sock;
                play.start();
                Handler h = new Handler(play.getLooper());
                mainIn = new Thread(() -> mainLoop(new DataInputStream(main.in), h), "xkpad_main");
                videoIn = new Thread(() -> videoLoop(new DataInputStream(video.in), h), "xkpad_video");
                alive = new Thread(() -> keepAlive(main.out), "xkpad_alive");
                mainIn.start(); videoIn.start(); alive.start();
            } catch (Exception e) { end(e.getMessage()); }
        }, "xkpad_stream").start();
    }

    void close() { end(null); }
    private void end(String why) {
        if (closed) return;
        closed = true;
        for (Thread t : new Thread[] { mainIn, videoIn, alive }) if (t != null) t.interrupt();
        for (Socket s : new Socket[] { mainSock, videoSock }) if (s != null) try { s.close(); } catch (IOException ignored) {}
        play.quitSafely();
        out.onEnd(why);
    }

    // ── 照易控 ClientPlayer.mainStreamIn / videoStreamIn ──
    private void mainLoop(DataInputStream in, Handler h) {
        AudioDecode audio = null;
        try {
            boolean opus = true;
            if (in.readByte() == 1) opus = in.readByte() == 1;
            while (!closed) {
                switch (in.readByte()) {
                    case 1: {
                        ByteBuffer f = frame(in);
                        if (audio != null) audio.decodeIn(f); else audio = new AudioDecode(opus, f, h);
                        break;
                    }
                    case 2: frame(in); break;   // 剪贴板：服务端这边没开（listenClip=0），收到也不管
                    case 3: { int w = in.readInt(), hh = in.readInt(); out.onSize(w, hh); break; }
                    default: throw new IOException("main 上来了认不得的类型");
                }
            }
        } catch (Exception e) { if (!closed) end("声音和控制断了：" + e.getMessage()); }
        finally { if (audio != null) audio.release(); }
    }

    private void videoLoop(DataInputStream in, Handler h) {
        VideoDecode video = null;
        try {
            boolean h265 = in.readByte() == 1;
            int w = in.readInt(), hh = in.readInt();
            out.onSize(w, hh);
            ByteBuffer csd0 = frame(in), csd1 = h265 ? null : frame(in);
            video = new VideoDecode(new Pair<>(w, hh), surface, csd0, csd1, h);
            while (!closed) video.decodeIn(frame(in));
        } catch (Exception e) { if (!closed) end("画面断了：" + e.getMessage()); }
        finally { if (video != null) video.release(); }
    }

    private static ByteBuffer frame(DataInputStream in) throws IOException {
        byte[] b = new byte[in.readInt()];
        in.readFully(b);
        return ByteBuffer.wrap(b);
    }

    private void keepAlive(OutputStream o) {
        try { while (!closed) { o.write(4); o.flush(); Thread.sleep(5000); } }
        catch (InterruptedException ignored) {}
        catch (IOException e) { if (!closed) end("保活发不出去：" + e.getMessage()); }
    }

    // ── 到手机网关的加密升级连接 ──
    private static final class Chan { Socket sock; InputStream in; OutputStream out; }

    private Chan open(String ch, String sid) throws Exception {
        byte[] salt = new byte[16];
        new SecureRandom().nextBytes(salt);
        String hello = link.hello(new JSONObject().put("ch", ch).put("sid", sid).put("salt", PadCrypto.b64(salt)));
        Socket s = new Socket(link.host(), link.port());
        s.setTcpNoDelay(true);
        OutputStream o = s.getOutputStream();
        o.write(("GET /pad/stream HTTP/1.1\r\nhost: " + link.host() + "\r\nupgrade: xkpad\r\nconnection: Upgrade\r\nx-pad: " + hello + "\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        o.flush();
        InputStream raw = s.getInputStream();
        // 读响应头到空行；不是 101 就把手机说的原因带回来
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int a = 0, b = 0, c = 0, d;
        while ((d = raw.read()) >= 0) {
            head.write(d);
            if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
            a = b; b = c; c = d;
        }
        String h = head.toString("UTF-8");
        if (!h.startsWith("HTTP/1.1 101")) {
            ByteArrayOutputStream rest = new ByteArrayOutputStream();
            byte[] buf = new byte[1024];
            for (int n; (n = raw.read(buf)) > 0; ) rest.write(buf, 0, n);
            s.close();
            throw new IOException(rest.toString("UTF-8").isEmpty() ? h.split("\r\n")[0] : rest.toString("UTF-8"));
        }
        Chan r = new Chan();
        r.sock = s;
        r.in = new OpenStream(raw, subKey(link.key(), salt, ch, 0), (byte) 0);
        r.out = new SealStream(o, subKey(link.key(), salt, ch, 1), (byte) 1);
        return r;
    }

    /** 和网关 streamKey 一样：HKDF(配对密钥, 盐, "xkpad v1 stream <ch> <dir>") */
    static byte[] subKey(byte[] key, byte[] salt, String ch, int dir) throws Exception {
        return PadCrypto.hkdf(key, salt, "xkpad v1 stream " + ch + " " + dir, 32);
    }
    static byte[] nonce(byte dir, long n) {
        byte[] b = new byte[12];
        b[0] = dir;
        for (int i = 0; i < 8; i++) b[4 + i] = (byte) (n >>> (56 - 8 * i));
        return b;
    }

    /** 手机 → 平板：一块一块解开（4 字节长度 + 密文和校验），对外是普通的字节流 */
    static final class OpenStream extends InputStream {
        private final DataInputStream in; private final SecretKeySpec key; private final byte dir;
        private long n; private byte[] cur = new byte[0]; private int pos;
        OpenStream(InputStream in, byte[] key, byte dir) { this.in = new DataInputStream(in); this.key = new SecretKeySpec(key, "AES"); this.dir = dir; }
        private boolean fill() throws IOException {
            while (pos >= cur.length) {
                int len;
                try { len = in.readInt(); } catch (java.io.EOFException e) { return false; }
                if (len < 16 || len > (16 << 20)) throw new IOException("块长度不对：" + len);
                byte[] ct = new byte[len];
                in.readFully(ct);
                try {
                    Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                    c.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, nonce(dir, n++)));
                    cur = c.doFinal(ct); pos = 0;
                } catch (Exception e) { throw new IOException("解不开（被改过或顺序不对）"); }
            }
            return true;
        }
        @Override public int read() throws IOException { return fill() ? cur[pos++] & 0xff : -1; }
        @Override public int read(byte[] b, int off, int len) throws IOException {
            if (!fill()) return -1;
            int k = Math.min(len, cur.length - pos);
            System.arraycopy(cur, pos, b, off, k); pos += k;
            return k;
        }
    }

    /** 平板 → 手机：每次 write 加密成一块 */
    static final class SealStream extends OutputStream {
        private final OutputStream out; private final SecretKeySpec key; private final byte dir; private long n;
        SealStream(OutputStream out, byte[] key, byte dir) { this.out = out; this.key = new SecretKeySpec(key, "AES"); this.dir = dir; }
        @Override public void write(int b) throws IOException { write(new byte[] { (byte) b }, 0, 1); }
        @Override public synchronized void write(byte[] b, int off, int len) throws IOException {
            try {
                Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
                c.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, nonce(dir, n++)));
                byte[] ct = c.doFinal(b, off, len);
                out.write(new byte[] { (byte) (ct.length >>> 24), (byte) (ct.length >>> 16), (byte) (ct.length >>> 8), (byte) ct.length });
                out.write(ct);
                out.flush();
            } catch (IOException e) { throw e; } catch (Exception e) { throw new IOException(e); }
        }
    }
}
