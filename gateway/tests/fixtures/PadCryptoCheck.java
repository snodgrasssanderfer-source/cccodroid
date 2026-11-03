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
            default: throw new IllegalArgumentException(a[0]);
        }
    }
}
