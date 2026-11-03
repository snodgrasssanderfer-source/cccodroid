package cc.codroid.pad;

import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.ECGenParameterSpec;
import java.security.spec.X509EncodedKeySpec;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.KeyAgreement;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 和手机网关（gateway/gw/xk-pad.mjs）对得上的那套算法，只用 Java 自带的库（桌面 JVM 上也能跑，
 * gateway/tests/xk-pad-java.test.mjs 拿它和网关对一遍）：
 *   P-256 ECDH → HKDF-SHA256（salt = 手机公钥 ‖ 平板公钥）→ 32 字节通信密钥 + 6 位比对数；AES-256-GCM，AAD = 配对号。
 */
final class PadCrypto {
    private static final SecureRandom RNG = new SecureRandom();
    private static final Base64.Encoder B64 = Base64.getEncoder();
    private static final Base64.Decoder D64 = Base64.getDecoder();

    static KeyPair newKeyPair() throws Exception {
        KeyPairGenerator g = KeyPairGenerator.getInstance("EC");
        g.initialize(new ECGenParameterSpec("secp256r1"), RNG);
        return g.generateKeyPair();
    }

    /** 公钥的 SPKI DER，base64（和网关 export({format:"der",type:"spki"}) 一样） */
    static String pub(KeyPair kp) { return B64.encodeToString(kp.getPublic().getEncoded()); }

    /** 通信密钥（32 字节）和给人比对的 6 位数 */
    static final class Derived { final byte[] key; final String sas; Derived(byte[] k, String s) { key = k; sas = s; } }

    static Derived derive(PrivateKey mine, String phonePub, String padPub) throws Exception {
        PublicKey phone = KeyFactory.getInstance("EC").generatePublic(new X509EncodedKeySpec(D64.decode(phonePub)));
        KeyAgreement ka = KeyAgreement.getInstance("ECDH");
        ka.init(mine);
        ka.doPhase(phone, true);
        byte[] shared = ka.generateSecret();
        byte[] a = D64.decode(phonePub), b = D64.decode(padPub), salt = new byte[a.length + b.length];
        System.arraycopy(a, 0, salt, 0, a.length);
        System.arraycopy(b, 0, salt, a.length, b.length);
        byte[] key = hkdf(shared, salt, "xkpad v1 key", 32);
        byte[] s = hkdf(shared, salt, "xkpad v1 sas", 4);
        long v = ((s[0] & 0xffL) << 24) | ((s[1] & 0xffL) << 16) | ((s[2] & 0xffL) << 8) | (s[3] & 0xffL);
        return new Derived(key, String.format(java.util.Locale.ROOT, "%06d", v % 1000000L));
    }

    /** RFC 5869，最多 32 字节（一轮就够） */
    static byte[] hkdf(byte[] ikm, byte[] salt, String info, int len) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(salt, "HmacSHA256"));
        byte[] prk = mac.doFinal(ikm);
        mac.init(new SecretKeySpec(prk, "HmacSHA256"));
        mac.update(info.getBytes(StandardCharsets.UTF_8));
        mac.update((byte) 1);
        byte[] okm = mac.doFinal(), out = new byte[len];
        System.arraycopy(okm, 0, out, 0, len);
        return out;
    }

    /** 加密一段 JSON：{n: 12 字节随机数, c: 密文 ‖ 16 字节校验}，都是 base64 */
    static String[] seal(byte[] key, String json, String aad) throws Exception {
        byte[] n = new byte[12];
        RNG.nextBytes(n);
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, n));
        c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        return new String[] { B64.encodeToString(n), B64.encodeToString(c.doFinal(json.getBytes(StandardCharsets.UTF_8))) };
    }

    static String open(byte[] key, String n, String ct, String aad) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, D64.decode(n)));
        c.updateAAD(aad.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(D64.decode(ct)), StandardCharsets.UTF_8);
    }

    static String b64(byte[] b) { return B64.encodeToString(b); }
    static byte[] unb64(String s) { return D64.decode(s); }
}
