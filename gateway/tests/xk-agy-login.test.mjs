// 哈基米登录：从 agy 打到伪终端里的输出认出登录链接（实测 1.4.12 的样子：链接按终端宽度折成好几行）
import test from "node:test";
import assert from "node:assert/strict";
const { agyLoginUrl } = await import("../gw/xk-agy.mjs");

const URL = "https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=1-abc.apps.googleusercontent.com&code_challenge=E8U&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&response_type=code&scope=openid&state=UqjF";

test("折行的链接拼回整条；后面的提示文字不拼进去", () => {
  const out = "\x1b[1mSigning in...\x1b[0mYour browser should open automatically. If not:\r\n " + URL.slice(0, 120) + "\r\n " + URL.slice(120, 200) + "\r\n " + URL.slice(200) + "   \r\n Copy and paste the URL or click on the link below:\r\n";
  assert.equal(agyLoginUrl(out), URL);
});

test("终端超链接（OSC 8）优先，不用拼", () => {
  assert.equal(agyLoginUrl(`\x1b]8;;${URL}\x07Click here to authenticate\x1b]8;;\x07`), URL);
});

test("链接还没打完整（没有 state 参数）就先不给", () => {
  assert.equal(agyLoginUrl(" " + URL.slice(0, 120) + "\r\n"), null);
  assert.equal(agyLoginUrl("Select login method:\r\n > 1. Google OAuth\r\n"), null);
});
