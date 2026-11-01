// 小克：网关里我们自己加的全部功能从这里进。server.mjs 只多了一行 import 和 ROUTES 里的 routeXk（排第一，要先看 /api/chat）。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

export const XK_HOME = path.join(CFG.home, ".config", "xiaoke");
fs.mkdirSync(XK_HOME, { recursive: true });

// 各模块往这里挂：handlers(req, res, u, p) 不认领就返回 NEXT
const ROUTES = [];
export const addRoute = (fn) => ROUTES.push(fn);

export async function json(req) {
  const t = await readBody(req);
  try { return t ? JSON.parse(t) : {}; } catch (e) { throw Object.assign(new Error("请求不是 JSON：" + e.message), { status: 400 }); }
}

// ── App 更新源（外壳 Xk.java 读同一个文件）──
const FEED = path.join(XK_HOME, "update-feed");
const DEFAULT_FEED = "https://api.github.com/repos/snodgrasssanderfer-source/xiaoke-ccc/releases?per_page=30";
addRoute(async (req, res, u, p) => {
  if (p !== "/api/xk/update-feed") return NEXT;
  if (req.method === "GET") {
    const cur = fs.existsSync(FEED) ? fs.readFileSync(FEED, "utf8").trim() : "";
    return sendJson(res, 200, { feed: cur || DEFAULT_FEED, default: DEFAULT_FEED });
  }
  if (req.method === "PUT") {
    const { feed } = await json(req);
    const v = String(feed || "").trim();
    if (v && !/^https:\/\//.test(v)) return sendJson(res, 400, { error: "更新源要以 https:// 开头" });
    if (v) fs.writeFileSync(FEED, v + "\n"); else fs.rmSync(FEED, { force: true });
    return sendJson(res, 200, { ok: true, feed: v || DEFAULT_FEED });
  }
  return NEXT;
});

export async function routeXk(req, res, u, p) {
  if (!p.startsWith("/api/xk/") && p !== "/api/chat") return NEXT;
  try {
    for (const r of ROUTES) if ((await r(req, res, u, p)) !== NEXT) return;
  } catch (e) {
    if (!res.headersSent) return sendJson(res, e.status || 500, { error: e.message });
    throw e;
  }
  return NEXT;
}
