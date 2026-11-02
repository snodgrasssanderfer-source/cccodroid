package cc.codroid;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** 小克在外壳里的几处差异：显示名、App 更新源、通知图标。集中在这里，上游原文件只各改一行调用。 */
final class Xk {
    static final String NAME = "小克";
    // 更新说明目录（assets/ 下）。上游的 whatsnew/ 是上游各版的说明，版本号和我们的撞名，不能弹
    static final String WHATSNEW = "xk-whatsnew";
    /** 包名固定 cc.codroid（工具包按它改写过路径），这里和 Env 里的令牌路径一样直接写死 */
    static final File HOME = new File("/data/data/cc.codroid/files/home");
    static final String DEFAULT_FEED = "https://api.github.com/repos/snodgrasssanderfer-source/cccodroid/releases?per_page=30";

    // 只换作为产品名出现的 cccodroid；路径（/sdcard/cccodroid）、链接（greyoak111/cccodroid）、cccodroid-xxx 这类标识照旧，否则会指错地方
    private static final Pattern BRAND = Pattern.compile("(?<![/\\w.-])cccodroid(?![/\\w.-])");

    /** 状态栏的小橙花（res/drawable-<密度>/ic_stat_xk.png，白色剪影）。res 只编译不出 R 类，按名字找；没打进包就用上游原来那个 */
    static int icon(android.content.Context c, int fallback) {
        int id = c.getResources().getIdentifier("ic_stat_xk", "drawable", c.getPackageName());
        return id != 0 ? id : fallback;
    }

    static String brand(String s) { return s == null || s.indexOf("cccodroid") < 0 ? s : BRAND.matcher(s).replaceAll(NAME); }

    /** App 更新的发布列表（GitHub releases API 的形状）。设置页写 home/.config/xiaoke/update-feed 可改。
     *  上游的 APK 签名不同，这里不能再指向上游：装不上，只会一直提示有新版 */
    static String feed() {
        File f = new File(HOME, ".config/xiaoke/update-feed");
        if (!f.isFile()) return DEFAULT_FEED;
        try {
            String u = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8).trim();
            return u.isEmpty() ? DEFAULT_FEED : u;
        } catch (java.io.IOException e) {
            throw new IllegalStateException("读不了更新源配置 " + f + "：" + e.getMessage(), e);
        }
    }

    /** 发布列表对应的 owner/repo，拼 Release 下载地址用 */
    static String repo() {
        Matcher m = Pattern.compile("api\\.github\\.com/repos/([^/]+/[^/?]+)/releases").matcher(feed());
        return m.find() ? m.group(1) : "snodgrasssanderfer-source/cccodroid";
    }
}
