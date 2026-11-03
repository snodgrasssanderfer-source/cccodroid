package cc.codroid.pad;

import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.spec.PKCS8EncodedKeySpec;

/** 给 xk-pad-java.test.mjs 用：一条命令做一步，结果打到标准输出（一行一个值） */
public class PadCryptoCheck {
    public static void main(String[] a) throws Exception {
        switch (a[0]) {
            case "gen": { KeyPair kp = PadCrypto.newKeyPair(); System.out.println(PadCrypto.pub(kp)); System.out.println(PadCrypto.b64(kp.getPrivate().getEncoded())); break; }
            case "derive": {
                PadCrypto.Derived d = PadCrypto.derive(KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(PadCrypto.unb64(a[1]))), a[2], a[3]);
                System.out.println(PadCrypto.b64(d.key)); System.out.println(d.sas); break;
            }
            case "seal": { String[] e = PadCrypto.seal(PadCrypto.unb64(a[1]), a[2], a[3]); System.out.println(e[0]); System.out.println(e[1]); break; }
            case "open": System.out.println(PadCrypto.open(PadCrypto.unb64(a[1]), a[2], a[3], a[4])); break;
            case "stream": {   // 串流方向 1（平板 → 手机）：用子密钥把两段话各加密成一块，整串 base64 打出来
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                PadStream.SealStream s = new PadStream.SealStream(bo, PadStream.subKey(PadCrypto.unb64(a[1]), PadCrypto.unb64(a[2]), a[3], 1), (byte) 1);
                s.write(a[4].getBytes("UTF-8")); s.write(a[5].getBytes("UTF-8"));
                System.out.println(PadCrypto.b64(bo.toByteArray())); break;
            }
            case "unstream": {   // 方向 0（手机 → 平板）：解开网关加的一串块
                java.io.InputStream in = new PadStream.OpenStream(new java.io.ByteArrayInputStream(PadCrypto.unb64(a[4])), PadStream.subKey(PadCrypto.unb64(a[1]), PadCrypto.unb64(a[2]), a[3], 0), (byte) 0);
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[256]; for (int n; (n = in.read(buf)) > 0; ) bo.write(buf, 0, n);
                System.out.println(bo.toString("UTF-8")); break;
            }
            default: throw new IllegalArgumentException(a[0]);
        }
    }
}
