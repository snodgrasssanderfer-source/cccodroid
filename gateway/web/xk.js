// 小克：界面上我们自己加的部分。上游 app.js 是一个闭包，这里只通过 window.__cc（上游自己导出的）、window.Theme、window.CCApp、DOM 和 /api/xk/* 跟它打交道。
// 结构：底部五栏（聊天是上游原有的聊天区，角色 / 记忆 / 日记 / 我的是我们的页）；当前角色的整套配色写进上游的变量表，换人时从头像处圆形铺开。
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const art = (p) => "/xk-art/" + p + ".webp";
  const LS = { get(k, d) { try { const v = localStorage.getItem("xk." + k); return v == null ? d : JSON.parse(v); } catch { return d; } }, set(k, v) { try { localStorage.setItem("xk." + k, JSON.stringify(v)); } catch {} } };
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || "HTTP " + r.status);
    return j;
  }
  const root = document.documentElement;
  root.classList.add("xk");
  const P = { sound: LS.get("sound", true) };
  // 动效只有一个开关：上游的「界面动效」（html[data-motion]，跟随系统 / 开 / 关），「我的 → 动效」写的也是它（#16）
  const moving = () => root.dataset.motion !== "off" && !matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ── 三位住客 ──
  const ROLE = {
    xiaoke: { name: "小克", sub: "Claude", mark: "icon/flower_open", s: { idle: "01_idle", thinking: "02_thinking", working: "03_working", happy: "04_flustered", sleeping: "09_sleeping", wave: "12_wave", memory: "11_memory", diary: "10_diary" } },
    hachimi: { name: "哈基米", sub: "Gemini", mark: "icon/mark_paw", s: { idle: "01_idle", thinking: "02_thinking", working: "03_working", happy: "04_happy", sleeping: "07_sleeping", wave: "08_wave" } },
    deepseek: { name: "小鱼", sub: "DeepSeek", dir: "xiaoyu", mark: "icon/mark_bowl", s: { idle: "01_idle", thinking: "02_thinking", working: "03_working", happy: "04_happy", sleeping: "07_sleeping", wave: "08_wave" } },
  };
  const sprite = (id, st) => { const r = ROLE[id] || ROLE.xiaoke; return art((r.dir || id) + "/" + (r.s[st] || r.s.idle)); };
  const rname = (id) => (ROLE[id] || {}).name || id || "—";

  // ── 音效：Web Audio 现场合成，很轻、很短；「我的」里能关 ──
  const SFX = (() => {
    let ctx, out, noise;
    const init = () => {
      if (ctx) return true;
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return false; }
      out = ctx.createGain(); out.gain.value = .5; out.connect(ctx.destination);
      noise = ctx.createBuffer(1, ctx.sampleRate * .5, ctx.sampleRate);
      const d = noise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      return true;
    };
    const env = (g, t, a, peak, dec) => { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(.0001, t + a + dec); };
    const tone = (type, f0, f1, peak, dec, delay = 0) => {
      const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(f0, t); if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dec);
      env(g, t, .004, peak, dec); o.connect(g).connect(out); o.start(t); o.stop(t + dec + .05);
    };
    const hiss = (ft, f0, f1, q, peak, a, dec, delay = 0) => {
      const t = ctx.currentTime + delay, s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noise; f.type = ft; f.Q.value = q; f.frequency.setValueAtTime(f0, t); if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + a + dec);
      env(g, t, a, peak, dec); s.connect(f).connect(g).connect(out); s.start(t); s.stop(t + a + dec + .05);
    };
    const lib = {
      tap: () => { hiss("bandpass", 2600, 0, 1.4, .18, .002, .035); tone("sine", 1500, 0, .025, .03); },
      tab: () => hiss("bandpass", 900, 2600, .9, .12, .03, .14),
      send: () => { tone("sine", 480, 900, .14, .11); hiss("highpass", 3000, 0, .7, .05, .002, .03); },
      receive: () => { tone("sine", 1318, 0, .05, .7); tone("sine", 1975, 0, .03, .5, .05); },
      done: () => { tone("triangle", 880, 660, .05, .06); hiss("bandpass", 4000, 0, 2, .05, .001, .02, .01); },
      toggle: () => { hiss("bandpass", 3200, 0, 3, .16, .001, .015); tone("sine", 160, 90, .08, .05); },
      sheet: () => hiss("lowpass", 1600, 400, .6, .1, .04, .22),
      sleep: () => { tone("sine", 392, 262, .07, .9); tone("sine", 196, 0, .04, .9, .1); },
      error: () => { tone("sine", 190, 150, .16, .14); hiss("bandpass", 900, 0, 4, .05, .001, .03); },
      bloom: () => { tone("sine", 196, 0, .05, .9); [784, 988, 1175, 1568].forEach((f, i) => tone("sine", f, 0, .028, .5, i * .07)); hiss("lowpass", 600, 3000, .5, .04, .2, .5); },
      petal: () => [1568, 1760, 2093].forEach((f, i) => tone("sine", f, 0, .025, .6, i * .12)),
    };
    return { play(k) { if (!P.sound || document.hidden || !init()) return; if (ctx.state === "suspended") ctx.resume(); try { lib[k](); } catch {} } };
  })();

  // ── 配色：每个角色一整套，浅、深各一；写成上游的变量表 ──
  const PAL = {
    xiaoke: {
      light: { bg: "#fff7ee", bg2: "#fffdf9", bg3: "#f6ede3", bg4: "#efe3d6", line: "#ecdccb", fg: "#2a211b", fg2: "#6e5a4a", fg3: "#a08c7a", acc: "#b8541a", soft: "#fbe4d2", on: "#ffffff" },
      dark: { bg: "#1d1713", bg2: "#271f19", bg3: "#2e251e", bg4: "#3a2f26", line: "#3b3028", fg: "#f2e7db", fg2: "#c3b09e", fg3: "#8c7a6a", acc: "#f39a58", soft: "#45301f", on: "#1d1713" },
    },
    hachimi: {
      light: { bg: "#f7f3fd", bg2: "#fdfbff", bg3: "#efe8fa", bg4: "#e6ddf5", line: "#e2d8f2", fg: "#251f33", fg2: "#5f5375", fg3: "#9a8fb0", acc: "#6d45bb", soft: "#ece4fa", on: "#ffffff" },
      dark: { bg: "#18151f", bg2: "#211c2b", bg3: "#2a2336", bg4: "#352c44", line: "#372e46", fg: "#ece6f7", fg2: "#b9abd2", fg3: "#85789e", acc: "#b496ef", soft: "#352a4a", on: "#18151f" },
    },
    deepseek: {
      light: { bg: "#f2f8fc", bg2: "#fbfdff", bg3: "#e6f1f8", bg4: "#dae9f3", line: "#d5e5f0", fg: "#182635", fg2: "#4c6175", fg3: "#8aa0b3", acc: "#2f5fae", soft: "#dcebfa", on: "#ffffff" },
      dark: { bg: "#121a22", bg2: "#18232e", bg3: "#1f2c39", bg4: "#283848", line: "#2a3a4a", fg: "#e3eef7", fg2: "#a6bccf", fg3: "#72889c", acc: "#7ea8ee", soft: "#22324a", on: "#121a22" },
    },
  };
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, p) => "#" + rgb(a).map((v, i) => Math.round(v * p + rgb(b)[i] * (1 - p)).toString(16).padStart(2, "0")).join("");
  const VARS = (T) => ({
    "--bg": T.bg, "--bg2": T.bg2, "--bg3": T.bg3, "--bg4": T.bg4, "--line": T.line, "--fg": T.fg, "--fg2": T.fg2, "--fg3": T.fg3, "--strong": T.fg,
    "--accent": T.acc, "--accent-btn": T.acc, "--accent-dim": mix(T.acc, T.bg, .45), "--on-accent": T.on, "--active-bg": T.soft,
    "--bar-bg": T.bg, "--bar-bg2": T.bg, "--code-bg": T.bg3, "--think-bg": T.bg3, "--more-bg": T.bg3, "--more-line": T.line,
    "--user-bg": T.soft, "--user-line": T.soft, "--sys-bg": T.bg3, "--sys-line": T.bg3, "--tool-bg": T.bg3, "--tool-line": T.bg3, "--tool-sep": T.bg4, "--cmd-bg": T.bg3,
    "--panel": T.bg2, "--input-bg": T.bg2,
  });
  // 颜色变量注册成 <color>，换人时（不支持圆形铺开的环境）逐帧渐变过去
  const COLOR_VARS = Object.keys(VARS(PAL.xiaoke.light)).filter((k) => k !== "--strong");
  try { for (const name of COLOR_VARS) CSS.registerProperty({ name, syntax: "<color>", inherits: true, initialValue: "#000000" }); } catch {}
  (function writePalette() {
    const el = document.createElement("style"); el.id = "xk-pal";
    let css = `html.xk{transition:${COLOR_VARS.map((v) => v + " .7s cubic-bezier(.2,.8,.2,1)").join(",")}}\n`;
    // 三个属性的选择器压过上游各外观（两个属性）和自定强调色那段
    for (const id in PAL) for (const m of ["light", "dark"]) css += `html[data-xk-role="${id}"][data-theme="${m}"][data-skin]{${Object.entries(VARS(PAL[id][m])).map(([k, v]) => k + ":" + v).join(";")}}\n`;
    el.textContent = css; document.head.appendChild(el);
  })();

  // 外壳（状态栏、导航栏、对话框、内置浏览器）按「拾色」那条路接我们的配色：8 种颜色 bg card field line fg dim hint accent
  const shell = window.CCApp || null;
  if (shell && typeof shell.skinPref === "function") { const raw = shell.skinPref; shell.skinPref = () => raw("shise"); }
  function paintShell() {
    if (!shell) return;
    const id = root.dataset.xkRole || "xiaoke", pal = (T) => [T.bg, T.bg2, T.bg4, T.line, T.fg, T.fg2, T.fg3, T.acc].join(",");
    try { if (typeof shell.skinPal === "function") shell.skinPal(pal(PAL[id].light), pal(PAL[id].dark)); } catch {}
    try { if (typeof shell.skinPref === "function") shell.skinPref("shise"); } catch {}
    try { if (typeof shell.setBars === "function") shell.setBars(root.dataset.theme === "dark"); } catch {}
    const meta = $('meta[name="theme-color"]'); if (meta) meta.content = PAL[id][root.dataset.theme === "dark" ? "dark" : "light"].bg;
  }
  // 角色配色盖住了外观风格：存的是别的风格就改回原生，只留深浅
  if (window.Theme && Theme.skin !== "native") { try { Theme.set(String(Theme.pref).replace(/^(qs|zy|gc|ss)-/, "")); } catch {} }
  new MutationObserver(paintShell).observe(root, { attributes: true, attributeFilter: ["data-theme"] });

  /** 换成某个角色的配色；anim 时从头像处圆形铺开 */
  function applyRole(id, anim) {
    if (!ROLE[id]) id = "xiaoke";
    if (root.dataset.xkRole === id) return;
    const set = () => { root.dataset.xkRole = id; LS.set("role", id); paintHead(); paintShell(); };
    const pop = () => { const b = $("#xk-face img"); if (b) { b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop"); } };
    if (!anim || !root.dataset.xkRole || !document.startViewTransition || !moving() || document.hidden) { set(); pop(); return; }
    const f = ($("#xk-face") || document.body).getBoundingClientRect(), x = f.left + f.width / 2, y = f.top + f.height / 2;
    root.classList.add("xk-vt");
    const vt = document.startViewTransition(set);
    vt.ready.then(() => {
      const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
      root.animate({ clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] }, { duration: 820, easing: "cubic-bezier(.65,0,.35,1)", pseudoElement: "::view-transition-new(root)" });
      SFX.play("bloom");
    }).catch(() => {});
    vt.finished.finally(() => { root.classList.remove("xk-vt"); pop(); });
  }

  // ── 产品名：上游界面框架里写「cccodroid」的地方显示成「小克」，路径和链接里的不动（和外壳 Xk.brand 同一条规则）。
  //    只认下面这几块界面框架；消息、记忆、日记、文件、帮助正文、开源声明这些内容一律不碰（#13：以前整页替换，把「基于 cccodroid 修改」也改了）
  const BRAND = /(?<![\/\w.-])cccodroid(?![\/\w.-])/g;
  const UI_SCOPE = "#set-ov, #toast, #topbar, .drawer-head, #side-title, .acct-row, #pages .page-head, .wn-head, #notice-pop .wn-head";
  const CONTENT = "#chat, .msg, .xk-page, #xk-sheet, #help-body, #viewer, #files, #term, input, textarea, [contenteditable], code, pre";
  const inUi = (el) => el && el.closest && el.closest(UI_SCOPE) && !el.closest(CONTENT);
  // 只在真的换了时才写回：写回本身会再触发观察器，路径里的 cccodroid 换不掉，每次都写就成了死循环
  const fix = (n) => { if (n.nodeValue.includes("cccodroid") && inUi(n.parentElement)) { const v = n.nodeValue.replace(BRAND, "小克"); if (v !== n.nodeValue) n.nodeValue = v; } };
  function brand(r) {
    const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fix(n);
  }
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") fix(m.target);
      else for (const n of m.addedNodes) n.nodeType === 1 ? brand(n) : n.nodeType === 3 && fix(n);
    }
    const t = document.title.replace(BRAND, "小克");
    if (t !== document.title) document.title = t;
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  brand(document.body);
  document.title = "小克";

  // ── 提示、底部面板、花瓣 ──
  const toastEl = document.createElement("div"); toastEl.id = "xk-toast"; toastEl.setAttribute("role", "status"); document.body.appendChild(toastEl);
  function toast(title, text, img, err) {
    toastEl.innerHTML = `<img src="${img || art(ROLE[root.dataset.xkRole || "xiaoke"].mark)}" alt=""><div><b>${esc(title)}</b>${esc(text || "")}</div>`;
    toastEl.classList.add("on"); if (err) SFX.play("error");
    clearTimeout(toast.h); toast.h = setTimeout(() => toastEl.classList.remove("on"), err ? 5000 : 3400);
  }
  // 出错、断线、搜不到：用正在聊的那位那一套（第 2 版 state/<人>/）
  const stateArt = (k, id) => { const r = id || root.dataset.xkRole || "xiaoke"; return art("state/" + (ROLE[r]?.dir || r) + "/" + k); };
  const fail = (e) => toast("没成功", e.message || String(e), stateArt("error"), true);
  const veil = document.createElement("div"); veil.id = "xk-veil";
  const sheet = document.createElement("div"); sheet.id = "xk-sheet"; sheet.setAttribute("role", "dialog"); sheet.setAttribute("aria-modal", "true");
  document.body.append(veil, sheet);
  function openSheet(html, bind) { sheet.innerHTML = '<div class="grab"></div>' + html; bind?.(sheet); veil.classList.add("on"); sheet.classList.add("on"); SFX.play("sheet"); }
  function closeSheet() { veil.classList.remove("on"); sheet.classList.remove("on"); }
  veil.onclick = closeSheet;
  function petals() {
    if (!moving()) return;
    SFX.play("petal");
    for (let i = 0; i < 14; i++) {
      const p = document.createElement("img"); p.className = "xk-petal"; p.src = art("deco/petal_" + (1 + (i % 5))); p.alt = "";
      p.style.left = Math.random() * 100 + "vw"; p.style.setProperty("--d", 2.6 + Math.random() * 1.8 + "s"); p.style.setProperty("--dx", (Math.random() * 160 - 80) + "px");
      p.style.setProperty("--r", (Math.random() * 720 - 360) + "deg"); p.style.animationDelay = Math.random() * .6 + "s";
      document.body.appendChild(p); p.addEventListener("animationend", () => p.remove());
    }
  }

  const ICON = {
    chat: '<path d="M5 18.5 4 21l3.2-1.4A8.5 8.5 0 1 0 5 18.5Z"/>',
    roles: '<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2a4.4 4.4 0 0 1 5 4.3"/>',
    mem: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M10 7.5h4M10 16.5h4"/>',
    diary: '<path d="M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v15H7a2 2 0 0 1-2-2V4.5a1 1 0 0 1 1-1Z"/><path d="M5 18a2 2 0 0 1 2-2h11.5"/><path d="M13 3.5v6l2-1.4 2 1.4v-6"/>',
    me: '<path d="M12 3.5c1.6 2 4.2 2.4 6 1.6.6 3.6-.3 7.4-2.4 10.1L12 20l-3.6-4.8C6.3 12.5 5.4 8.7 6 5.1c1.8.8 4.4.4 6-1.6Z"/>',
    go: '<path d="m9 6 6 6-6 6"/>', back: '<path d="m15 6-6 6 6 6"/>', swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
    export: '<path d="M12 15.5V4"/><path d="m7.5 9 4.5-4.5L16.5 9"/><path d="M5 14.5v4A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-4"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;

  // ── 角色数据 ──
  let ROLES = null;   // /api/xk/roles：{ roles:[{id,name,imported,personaChars,postHistoryChars,cooldown}], active, order }
  async function loadRoles() { ROLES = await api("/api/xk/roles"); return ROLES; }
  const R = (id) => (ROLES && ROLES.roles.find((r) => r.id === id)) || null;
  const asleep = (id) => !!(R(id) && R(id).cooldown);
  let cur = { role: null, origin: null, sid: undefined };

  // ── 顶栏：头像（点开看她的卡）、名字、新对话 ──
  function mountHead() {
    if ($("#xk-face")) return true;
    const tb = $("#title-block"); if (!tb) return false;
    const face = document.createElement("button"); face.id = "xk-face"; face.setAttribute("aria-label", "当前角色");
    face.innerHTML = '<img alt="">'; face.onclick = () => { SFX.play("tap"); roleSheet(cur.role || "xiaoke"); };
    tb.before(face);
    const nm = document.createElement("div"); nm.id = "xk-name"; tb.prepend(nm);
    const nb = document.createElement("button"); nb.id = "xk-new"; nb.className = "icon-btn"; nb.setAttribute("aria-label", "新对话");
    nb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>'; nb.onclick = () => { SFX.play("tap"); $("#btn-new")?.click(); };
    ($("#btn-more") || tb).before(nb);
    paintHead(); return true;
  }
  let faceState = "idle";
  /** 顶栏小字：只有额度用完被迫换人才写「替谁接班」；主人手动换的（origin.manual）不算接班 */
  function paintHead() {
    const id = root.dataset.xkRole || "xiaoke", f = $("#xk-face"); if (!f) return;
    f.style.backgroundImage = `url("${sprite(id, asleep(id) ? "sleeping" : faceState)}")`;
    f.querySelector("img").src = art(ROLE[id].mark);
    $("#xk-name").innerHTML = `${esc(rname(id))}<small>${esc(ROLE[id].sub)}${cur.origin && !cur.origin.manual ? " · 替" + esc(rname(cur.origin.from)) + "接班" : ""}</small>`;
    const inp = $("#input"); if (inp && !inp.dataset.xkPh) inp.placeholder = `和${rname(id)}说说话…`;
  }
  function face(st, ms) { faceState = st; paintHead(); clearTimeout(face.h); if (ms) face.h = setTimeout(() => { faceState = "idle"; paintHead(); }, ms); }

  /** 当前会话是谁：会话换了、接班了、手动换人了，配色跟着换 */
  async function syncRole(force) {
    const cc = window.__cc; if (!cc) return;
    const sid = cc.view.sessionId || null;
    if (!force && sid === cur.sid) return;
    cur.sid = sid;
    if (!ROLES) await loadRoles();
    const r = await api("/api/xk/session-role" + (sid ? "?sid=" + encodeURIComponent(sid) : ""));
    cur.role = r.role || r.active || "xiaoke"; cur.origin = r.origin || null;
    applyRole(cur.role, true); paintHead();
  }
  setInterval(() => syncRole().catch(() => {}), 1000);

  /** 手动换角色：网关给 resume 就打开她最近那段接着聊（交回原角色时是被替班前那段，#1），没有才开新会话；
   *  第一条消息带上刚才那段对话（网关 /api/xk/switch） */
  async function switchRole(id) {
    const cc = window.__cc, from = cc.view.sessionId || null;
    const r = await api("/api/xk/switch", { method: "POST", body: { to: id, fromSessionId: from } });
    cur.sid = undefined; cur.role = id; cur.origin = null;
    if (r.resume) cc.openSession(r.resume);
    else { cc.newConversation(); cc.view.projectId = r.projectId; }
    await loadRoles();
    applyRole(id, true);
    toast(r.resume ? `换回${rname(id)}了` : `换成${rname(id)}了`, r.resume ? "接着你们上回那段，下一条会带上刚才聊的" : from ? "下一条消息会带上刚才的对话" : "", sprite(id, "wave"));
    return r;
  }

  // ── 她在干什么：输入框上方探出小人；思考过程跑着时展开 ──
  const peekEl = document.createElement("div"); peekEl.id = "xk-peek"; peekEl.innerHTML = '<img alt=""><span></span>';
  function peek(st) {
    if (!st) { peekEl.classList.remove("on"); return; }
    if (!peekEl.isConnected) { const c = $("#composer"); if (!c) return; c.prepend(peekEl); }
    peekEl.querySelector("img").src = sprite(root.dataset.xkRole || "xiaoke", st);
    peekEl.querySelector("span").textContent = { thinking: "?", working: "…", sleeping: "Zzz" }[st] || "";
    peekEl.classList.add("on");
  }
  // 跑着时新长出来的思考块直接展开（上游默认收着）；这一轮结束再收成一行，点一下还能看
  let live = 0;
  new MutationObserver((ms) => {
    if (!live) return;
    for (const m of ms) for (const n of m.addedNodes) if (n.nodeType === 1) {
      const t = n.matches?.("details.think") ? [n] : n.querySelectorAll?.("details.think") || [];
      for (const d of t) if (!d.dataset.xk) { d.dataset.xk = "1"; d.open = true; }
    }
  }).observe(document.body, { childList: true, subtree: true });
  // 干活过程收起来（主人 11-06 定的）：一轮跑完，最后一段正文之前的东西（工具组、思考、夹在工具中间的碎话）
  // 收进一个折叠块，只露最后那段。跑着的时候不动（气泡里还有 .live-tail）；历史页翻出来的同样处理。
  // 没动过工具的回复、最后停在工具或报错上的回复，原样不动
  function mkWork(b, before, steps) {
    const d = document.createElement("details");
    d.className = "xk-work";
    d.innerHTML = `<summary><span class="chev">▶</span>干活过程<span class="n">${steps ? steps + " 步" : ""}</span></summary>`;
    d.append(...before);
    b.prepend(d);
    return d;
  }
  function foldWork(b) {
    // 还在跑的、还不能折的都不打记号，下次变动再看（刚起的气泡只有三个点，那时连 .live-tail 都还没有）
    if (b.dataset.xkf || b.querySelector(":scope > .live-tail")) return;
    const kids = [...b.children];
    const lastTxt = kids.length && kids[kids.length - 1].classList.contains("txt") ? kids[kids.length - 1] : null;
    if (!lastTxt || b.querySelector(":scope > .err-box")) return;
    const before = kids.slice(0, -1);
    const steps = before.reduce((n, el) => n + el.querySelectorAll(".tool").length, 0);
    if (!steps) return;
    b.dataset.xkf = "1";
    mkWork(b, before, steps);
    const said = lastTxt.dataset.uuid && RECAST.get(window.__cc?.view.sessionId)?.[lastTxt.dataset.uuid];
    if (said) sayAgain(b, said);
  }
  // 重说（网关 xk-recast.mjs，先只给小克）：干活那一轮的最后一段换成重说过的，原话收进「干活过程」最底下
  const RECAST = new Map();   // 会话号 → { 原话那条的 uuid: 重说的话 }
  function sayAgain(b, text) {
    if (!b || b.dataset.xkr) return;
    const last = b.lastElementChild;
    if (!last || !last.classList.contains("txt")) return;
    const d = b.querySelector(":scope > details.xk-work") || mkWork(b, [], 0);
    b.dataset.xkr = "1";
    last.classList.remove("xk-recasting");
    const h = document.createElement("div"); h.className = "xk-raw-h"; h.textContent = "原话";
    d.append(h, last);
    const el = document.createElement("div");
    el.className = "txt md xk-said";
    el.innerHTML = window.__cc?.md ? window.__cc.md(text) : esc(text).replace(/\n/g, "<br>");
    b.append(el);
  }
  const runBubble = (runId) => [...document.querySelectorAll(`#chat .msg.bot[data-run="${CSS.escape(String(runId))}"] > .bubble`)].pop();
  function onRecast(ev) {
    const m = RECAST.get(ev.sessionId);
    if (ev.phase === "done" && m) m[ev.uuid] = ev.text;
    const b = runBubble(ev.runId); if (!b) return;
    const last = b.lastElementChild;
    if (ev.phase === "start") last?.classList.contains("txt") && !b.dataset.xkr && last.classList.add("xk-recasting");
    else if (ev.phase === "fail") last?.classList.remove("xk-recasting");
    else if (ev.phase === "done") sayAgain(b, ev.text);
  }
  let recastSid = "";
  function loadRecast() {
    const sid = window.__cc?.view.sessionId;
    if (!sid || RECAST.has(sid) || recastSid === sid) return;
    recastSid = sid;
    api("/api/xk/recast?sid=" + encodeURIComponent(sid)).then((r) => {
      RECAST.set(sid, r.items || {});
      if (!Object.keys(r.items || {}).length) return;
      document.querySelectorAll("#chat .msg.bot > .bubble[data-xkf]:not([data-xkr])").forEach((b) => {
        const u = b.lastElementChild?.dataset.uuid, t = u && r.items[u];
        if (t) sayAgain(b, t);
      });
    }).catch(() => { recastSid = ""; });
  }
  let foldQ = 0;
  const foldAll = () => { foldQ = 0; loadRecast(); document.querySelectorAll("#chat .msg.bot:not(.welcome) > .bubble:not([data-xkf])").forEach(foldWork); };
  new MutationObserver(() => { if (!foldQ) foldQ = requestAnimationFrame(foldAll); }).observe($("#chat") || document.body, { childList: true, subtree: true });
  const PRAISE = /可爱|厉害|好看|真棒|聪明|喜欢你|好乖/;
  const runs = new Map();   // run 号 → { praise, said }
  function mine(ev) { const cc = window.__cc; return cc && ((ev.runId && cc.view.runIds && cc.view.runIds.has(ev.runId)) || (ev.sessionId && ev.sessionId === cc.view.sessionId)); }
  function onRun(ev) {
    if (ev.type === "run_start") {
      runs.set(ev.runId, { praise: PRAISE.test(ev.text || ""), said: false });
      setTimeout(() => { if (!mine(ev)) return; live++; if (ev.auto !== "idle") SFX.play("send"); peek("thinking"); }, 60);
      return;
    }
    const st = runs.get(ev.runId); if (!st || !mine(ev)) return;
    if (ev.type === "tool_use") peek("working");
    else if (ev.type === "thinking_delta" || ev.type === "thinking") peek("thinking");
    else if ((ev.type === "delta" || ev.type === "assistant_text") && !st.said) {
      st.said = true; peek(null); SFX.play("receive");
      if (st.praise) { face("happy", 2400); petals(); }
    } else if (ev.type === "run_end") {
      runs.delete(ev.runId); live = Math.max(0, live - 1); peek(null); SFX.play("done");
      loadBoard().then(() => { if ($("#xk-p-roles.on")) paintBoard(); }).catch(() => {});   // 她这一轮可能贴了便条
      if (!live) document.querySelectorAll("#chat details.think[data-xk]").forEach((d) => { d.open = false; });
    }
  }

  // ── 网关事件：接班提示、出错、运行状态 ──
  const follow = new Map();   // run 号 → 新会话一拿到会话号就打开（只在主人正看着被接班的那个会话时）
  (function listen() {
    const es = new EventSource("/api/events");
    // 断了 4 秒还没连回来才说（EventSource 自己会重连，短暂抖一下不吵人）；一次断线只说一次
    let offT = 0, offSaid = false;
    // 断线时图也是网关给的：先取到内存里留着
    const OFF = {};
    for (const r of Object.keys(ROLE)) fetch(stateArt("offline", r)).then((x) => x.blob()).then((bl) => { OFF[r] = URL.createObjectURL(bl); }).catch(() => {});
    es.onerror = () => { if (!offT) offT = setTimeout(() => { offT = 0; if (es.readyState !== 1 && !offSaid) { offSaid = true; toast("连不上了", "小屋的网关没应答，正在重连", OFF[root.dataset.xkRole] || OFF.xiaoke, true); } }, 4000); };
    es.onopen = () => { clearTimeout(offT); offT = 0; if (offSaid) { offSaid = false; toast("连上了", "", sprite(root.dataset.xkRole, "wave")); } };
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "xk") {
        if (ev.op === "handover") {
          if (ev.compacted) {
            // #79 她自己选了压缩：不换人、不换会话，只提示一声
            toast(`${rname(ev.to)}压缩了这段对话`, ev.reason || "", sprite(ev.to, "wave"));
            return;
          }
          if (ev.rollover) {
            // #72 上下文到 20% 自己换新对话：不换人，只换这段；界面跟到新会话
            toast(`${rname(ev.to)}换了新对话`, ev.reason, sprite(ev.to, "wave"));
            const now0 = window.__cc && window.__cc.view.sessionId;
            if (!ev.fromSession || ev.fromSession === now0) follow.set(ev.runId, true);
            return;
          }
          // 接班四张、回来三张（第 2 版美术）；没画到的组合用接班那位挥手
          const HO = { "xiaoke>hachimi": 1, "hachimi>deepseek": 2, "xiaoke>deepseek": 3, "deepseek>xiaoke": 4 };
          const pic = ev.back ? art("group/back_" + (ROLE[ev.to].dir || ev.to)) : HO[ev.from + ">" + ev.to] ? art("group/handover_" + HO[ev.from + ">" + ev.to]) : sprite(ev.to, "wave");
          SFX.play("sleep"); peek("sleeping");
          toast(ev.back ? `${rname(ev.to)}回来了` : `${rname(ev.to)}来接班`, ev.reason, pic);
          const now = window.__cc && window.__cc.view.sessionId;
          if (!ev.fromSession || ev.fromSession === now) follow.set(ev.runId, true);
          loadRoles().then(() => { paintHead(); if ($("#xk-p-roles.on")) renderRoles(); }).catch(() => {});
        } else if (ev.op === "handover_none") { peek("sleeping"); toast(`${rname(ev.from)}睡着了`, ev.reason, sprite(ev.from, "sleeping"), true); }
        else if (ev.op === "room") roomMsg(ev.msg);
        else if (ev.op === "recast") onRecast(ev);
        else if (ev.op === "room_mode") roomModePaint(ev.mode);
        else if (ev.op === "room_typing") roomTyping(ev.role, ev.on);
        else if (ev.op === "memory_failed") toast(`${rname(ev.role)}整理记忆没成功`, ev.error, null, true);
        else if (ev.op === "pad_pending" || ev.op === "pad_paired") {
          if (meSub?.dataset.k === "pad") SUB.pad(meSub.querySelector(".xk-subb")).catch(() => {});
          else if (ev.op === "pad_pending") toast("平板想配对", `「${ev.name}」：到「我的 → 平板」核对 6 位数`, art("pad/pair"));
        }
        // 主人从系统设置给完悬浮窗权限回来：开着的「通知」页跟着刷新
        else if (ev.op === "overlay_config" && meSub?.dataset.k === "notify") SUB.notify(meSub.querySelector(".xk-subb")).catch(() => {});
        else if (ev.op === "diary") toast("日记", ev.text, art("xiaoke/10_diary"), !!ev.error);
        else if (ev.op === "board") {
          if (ev.error) toast("留言板", ev.error, stateArt("error"), true);
          else if (ev.note && ev.note.from !== "owner") toast(`${noteWho(ev.note.from)}留了张便条`, ev.note.text.slice(0, 60), art("group/noteboard"));
          loadBoard().then(() => { if ($("#xk-p-roles.on")) paintBoard(); }).catch(() => {});
        }
        return;
      }
      if (ev.runId && ev.sessionId && follow.get(ev.runId)) {
        follow.delete(ev.runId);
        window.__cc.openSession(ev.sessionId);
        setTimeout(() => { peek(null); syncRole(true).catch(() => {}); }, 300);
      }
      try { onRun(ev); } catch (e) { console.error("[xk] run", e); }
    };
  })();

  // ── 底部五栏与四页 ──
  const TABS = [["chat", "聊天"], ["roles", "角色"], ["mem", "记忆"], ["diary", "日记"], ["me", "我的"]];
  const PAGES = { roles: ["角色", "同住一屋，各有各的脾气"], mem: ["记忆", "她们各记各的，互相看不到"], diary: ["日记", "每晚十点后，她们各写一篇"], me: ["我的", "把小屋收拾成喜欢的样子"] };
  let tab = 0;
  const tabsEl = document.createElement("nav"); tabsEl.id = "xk-tabs"; tabsEl.setAttribute("aria-label", "主导航");
  tabsEl.innerHTML = '<span class="xk-pill"></span>' + TABS.map(([k, l], i) => `<button class="xk-tab${i ? "" : " on"}" data-i="${i}" aria-label="${l}">${svg(k)}${l}</button>`).join("");
  document.body.appendChild(tabsEl);
  for (const k in PAGES) {
    const p = document.createElement("section"); p.className = "xk-page"; p.id = "xk-p-" + k; p.setAttribute("aria-label", PAGES[k][0]);
    p.innerHTML = `<div class="xk-ph"><h1>${PAGES[k][0]}</h1><p>${PAGES[k][1]}</p></div><div class="xk-pb"></div>`;
    document.body.appendChild(p);
    // 日记页右上角：把这一天导出成图片（纸纹、日期、签名一起带上）
    if (k === "diary") {
      const ex = document.createElement("button");
      ex.id = "xk-diary-export"; ex.className = "xk-ph-act"; ex.disabled = true;
      ex.setAttribute("aria-label", "把这篇日记导出成图片"); ex.innerHTML = svg("export");
      ex.onclick = () => exportSheet();
      p.querySelector(".xk-ph").appendChild(ex);
    }
  }
  const body = (k) => $(`#xk-p-${k} .xk-pb`);
  function movePill() {
    const bs = [...tabsEl.querySelectorAll(".xk-tab")], b = bs[tab], pill = tabsEl.querySelector(".xk-pill");
    bs.forEach((x, i) => x.classList.toggle("on", i === tab));
    if (!b.offsetWidth) return;
    const w = Math.min(b.offsetWidth - 10, 64);
    pill.style.width = w + "px"; pill.style.transform = `translateX(${b.offsetLeft + (b.offsetWidth - w) / 2}px)`;
    root.style.setProperty("--xk-tabs-real", tabsEl.offsetHeight + "px");
  }
  function go(i) {
    if (i === tab) { if (i) body(TABS[i][0]).scrollTo({ top: 0, behavior: "smooth" }); return; }
    const dir = i > tab ? 1 : -1, from = TABS[tab][0], to = TABS[i][0];
    if (from !== "chat") { const el = $("#xk-p-" + from); el.style.setProperty("--xk-from", -dir * 24 + "px"); el.classList.remove("on"); }
    if (to !== "chat") { const el = $("#xk-p-" + to); el.style.setProperty("--xk-from", dir * 24 + "px"); void el.offsetWidth; el.classList.add("on"); RENDER[to]().catch(fail); }
    tab = i; movePill(); SFX.play("tab");
  }
  tabsEl.onclick = (e) => { const b = e.target.closest(".xk-tab"); if (b) go(+b.dataset.i); };
  addEventListener("resize", movePill);
  // 上游的整页、设置、终端、文件这些盖上来时，底栏让开
  const COVER = "#pages:not(.hidden), #set-ov:not(.hidden), #term:not(.hidden), #files:not(.hidden), #viewer:not(.hidden), #git:not(.hidden), #drawer:not(.hidden)";
  // 上游整页（定时任务、项目、脉络……）盖住聊天顶栏（主人 11-02 定的）：以前顶栏还在，小克名字下挂着各页的统计（走查 18 条）。
  //    整页提到顶栏上面，标题行前加一个返回；没有标题行的页（脉络）补一行
  function pageBack() {
    const pane = document.querySelector("#pages:not(.hidden) .tab-pane:not(.hidden)");
    if (!pane || pane.querySelector(".xk-pback")) return;
    const b = document.createElement("button"); b.className = "xk-pback icon-btn"; b.setAttribute("aria-label", "返回"); b.innerHTML = svg("back");
    b.onclick = () => window.__ccBack();
    const head = pane.querySelector(".page-head");
    if (head) head.prepend(b); else { const bar = document.createElement("div"); bar.className = "page-head xk-pbar"; bar.innerHTML = `<h2>${{ "tab-lineage": "脉络", "tab-bookmarks": "书签", "tab-changelog": "更新记录" }[pane.id] || ""}</h2>`; bar.prepend(b); pane.prepend(bar); }
  }
  setInterval(() => {
    const c = !!document.querySelector(COVER);
    if (root.classList.contains("xk-cover") !== c) {
      root.classList.toggle("xk-cover", c);
      // 脉络第一次打开时上游提一句「点右上怎么看」，离开了还挂着就收掉
      const t = $("#toast"); if (!c && t && /脉络/.test(t.textContent)) t.classList.add("hidden");
    }
    pageBack();
  }, 300);

  // 分段选择：三位住客
  function seg(cur0, onPick) {
    const ids = (ROLES ? ROLES.order : Object.keys(ROLE)).filter((id) => ROLE[id]);
    const el = document.createElement("div"); el.className = "xk-seg";
    el.innerHTML = '<span class="xk-knob"></span>' + ids.map((id) => `<button data-id="${id}" class="${id === cur0 ? "on" : ""}">${rname(id)}</button>`).join("");
    const place = () => { const b = el.querySelector("button.on"), k = el.querySelector(".xk-knob"); if (!b) return; k.style.width = b.offsetWidth + "px"; k.style.transform = `translateX(${b.offsetLeft}px)`; };
    requestAnimationFrame(place);
    el.onclick = (e) => { const b = e.target.closest("button"); if (!b || b.classList.contains("on")) return; el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); place(); SFX.play("tap"); onPick(b.dataset.id); };
    return el;
  }

  // ── 留言板（#7，主人 11-02 定的）：角色页三张卡下面一块；三个人下班前留的、主人贴的都在这；有新的角色栏标个点 ──
  const NOTE_C = (id) => (id === "owner" ? "var(--fg3)" : rc(id));
  const noteWho = (id) => (id === "owner" ? "主人" : rname(id));
  const noteWhen = (t) => { const d = new Date(t); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
  let notes = [], boardAll = false;
  async function loadBoard() { notes = (await api("/api/xk/board")).notes || []; boardDot(); return notes; }
  // 角色栏上的点：有我还没看过的、她们留的便条
  function boardDot() {
    const seen = LS.get("boardSeen", 0), on = notes.some((n) => n.from !== "owner" && n.at > seen);
    tabsEl.querySelector('.xk-tab[data-i="1"]')?.classList.toggle("dot", on);
  }
  function boardHtml() {
    if (!notes.length) return `<div class="xk-empty" style="padding:6px 0 4px"><img src="${art("group/noteboard")}" alt="">还没有便条<br>她们下班前会在这里留话；你也可以贴一张给她们</div>`;
    const show = boardAll ? notes : notes.slice(0, 6);
    return `<div class="xk-notes">${show.map((n, i) => `<button class="xk-note xk-press" data-id="${n.id}" style="--c:${NOTE_C(n.from)};--r:${[-1.6, 1.2, -.6, 1.8, -1.2, .8][i % 6]}deg">
        <small>${noteWho(n.from)} → ${n.to ? noteWho(n.to) : "大家"}${n.auto ? " · 摘的" : ""}</small><span>${esc(n.text)}</span><em>${noteWhen(n.at)}${n.readBy.length ? " · " + n.readBy.map(rname).join("、") + "看过" : ""}</em></button>`).join("")}</div>` +
      (notes.length > 6 ? `<button class="xk-mini xk-press" id="xk-b-all" style="margin-top:10px">${boardAll ? "收起" : `全部 ${notes.length} 张`}</button>` : "");
  }
  function paintBoard() {
    const box = $("#xk-board"); if (!box) return;
    box.innerHTML = boardHtml();
    box.querySelectorAll(".xk-note").forEach((x) => x.onclick = () => noteSheet(notes.find((n) => n.id === x.dataset.id)));
    const all = $("#xk-b-all", box); if (all) all.onclick = () => { boardAll = !boardAll; SFX.play("tap"); paintBoard(); };
    if (notes.length) { LS.set("boardSeen", notes[0].at); boardDot(); }
  }
  function noteSheet(n) {
    if (!n) return;
    openSheet(`<h2>${noteWho(n.from)}留给${n.to ? noteWho(n.to) : "大家"}</h2><p class="sub">${noteWhen(n.at)}${n.auto ? " · 她额度用完时从对话里摘的" : ""}${n.readBy.length ? " · " + n.readBy.map(rname).join("、") + "看过" : " · 还没人看过"}</p>
      <div class="xk-note-full" style="--c:${NOTE_C(n.from)}">${esc(n.text)}</div><button class="xk-wide xk-press xk-danger" id="xk-b-del">撕掉这张</button>`,
      (s) => { $("#xk-b-del", s).onclick = async () => { try { await api("/api/xk/board/" + n.id, { method: "DELETE" }); SFX.play("toggle"); closeSheet(); await loadBoard(); paintBoard(); } catch (e) { fail(e); } }; });
  }
  function postSheet() {
    let to = "";
    openSheet(`<h2>贴一张便条</h2><p class="sub">她们下一条消息前会看到（只带一次）；三个人都能翻到</p>
      <div class="xk-chips" id="xk-b-to">${[["", "大家"], ...(ROLES ? ROLES.order : Object.keys(ROLE)).map((id) => [id, rname(id)])].map(([k, l]) => `<button class="xk-mini xk-press${k === to ? " on" : ""}" data-k="${k}">${l}</button>`).join("")}</div>
      <textarea id="xk-b-text" rows="4" placeholder="比如：明天早上八点提醒我带伞" style="width:100%;box-sizing:border-box;margin-top:10px;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);padding:10px;font:15px/1.6 var(--font-ui)"></textarea>
      <button class="xk-wide xk-press" id="xk-b-post">贴上</button>`,
      (s) => {
        $("#xk-b-to", s).onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; to = b.dataset.k; s.querySelectorAll("#xk-b-to [data-k]").forEach((x) => x.classList.toggle("on", x === b)); SFX.play("tap"); };
        $("#xk-b-post", s).onclick = async () => {
          const text = $("#xk-b-text", s).value.trim(); if (!text) return $("#xk-b-text", s).focus();
          try { await api("/api/xk/board", { method: "POST", body: { text, to } }); SFX.play("send"); closeSheet(); await loadBoard(); paintBoard(); } catch (e) { fail(e); }
        };
      });
  }

  // ── 角色页 ──
  function roleState(id) { return asleep(id) ? "睡着了" : id === cur.role ? "在聊" : "休息"; }   // 主人 11-02 定的（#33）：没在聊的叫「休息」，「睡着了」只留给额度用完
  async function renderRoles() {
    await loadRoles();
    const b = body("roles"), order = ROLES.order.filter((id) => ROLE[id]);
    b.innerHTML = `<div class="xk-cards">${order.map((id) => `<button class="xk-card xk-press${id === cur.role ? " on" : ""}" data-id="${id}" style="--c:var(--xk-c-${id === "deepseek" ? "xiaoyu" : id});--s:var(--xk-s-${id === "deepseek" ? "xiaoyu" : id})"><img src="${sprite(id, asleep(id) ? "sleeping" : "idle")}" alt=""><b>${rname(id)}</b><span class="xk-tag">${roleState(id)}</span></button>`).join("")}</div>
      <button class="xk-wide xk-press" id="xk-room-go" style="margin-top:12px">进群，三个人一起聊</button>
      <div class="xk-block"><h2 class="xk-bh">留言板<button class="xk-mini xk-press" id="xk-b-new">贴一张</button></h2><div id="xk-board"></div></div>
      <div class="xk-block"><h2>替班顺序</h2><div class="xk-order">${order.map((id, i) => `${i ? `<button class="xk-swap xk-press" data-i="${i}" aria-label="交换顺序">${svg("swap")}</button>` : ""}<div class="o"><i style="background-image:url('${sprite(id, "idle")}')"></i><span>${rname(id)}</span></div>`).join("")}</div>
        <p class="xk-hint">谁的额度用完，就由下一位接班，只带上刚才那段对话；额度恢复后交还。点中间的箭头换顺序。</p></div>
      <div class="xk-block"><h2>导入人设与世界书</h2><p class="xk-hint" style="margin:0 0 10px">一次可以选好几个文件，txt、md、SillyTavern 的 JSON 都行。按文件名猜它是谁的人设、还是世界书，导入前可以改。世界书三个人共用，每一轮都会读到。</p>
        <label class="xk-mini xk-press">选文件导入<input type="file" multiple id="xk-imp"></label></div>`;
    b.querySelectorAll(".xk-card").forEach((c) => c.onclick = () => { SFX.play("tap"); roleSheet(c.dataset.id); });
    b.querySelectorAll(".xk-swap").forEach((x) => x.onclick = async () => {
      const i = +x.dataset.i, o = order.slice(); [o[i - 1], o[i]] = [o[i], o[i - 1]];
      try { await api("/api/xk/order", { method: "PUT", body: { order: o } }); SFX.play("toggle"); renderRoles(); } catch (e) { fail(e); }
    });
    $("#xk-b-new", b).onclick = () => { SFX.play("tap"); postSheet(); };
    $("#xk-room-go", b).onclick = () => openRoom();
    paintBoard(); loadBoard().then(paintBoard).catch(fail);
    $("#xk-imp", b).onchange = (e) => { const fs = [...e.target.files]; e.target.value = ""; if (fs.length) importSheet(fs).catch(fail); };
  }
  // ── 批量导入：每个文件猜一个去处（世界书 / 谁的人设），主人可以改，再一起导入 ──
  const TARGETS = [["wb", "世界书"], ["xiaoke", "小克"], ["hachimi", "哈基米"], ["deepseek", "小鱼"], ["", "不导入"]];
  function guessTarget(name, text) {
    const n = name.toLowerCase();
    if (/世界书|world|lore|设定集/.test(n)) return "wb";
    if (/小克|xiaoke|claude/.test(n)) return "xiaoke";
    if (/哈基米|hachimi|gemini/.test(n)) return "hachimi";
    if (/小鱼|deepseek|xiaoyu|鲸/.test(n)) return "deepseek";
    if (/【[^】]*】\s*system_prompt|^\s*system_prompt/m.test(text)) return cur.role || "xiaoke";
    return "wb";
  }
  async function importSheet(files) {
    const items = await Promise.all(files.map(async (f) => { const text = await f.text(); return { name: f.name, text, to: guessTarget(f.name, text) }; }));
    const rows = () => items.map((it, i) => `<div class="xk-row stack"><span class="k">${esc(it.name)}<small>${it.text.length} 字</small></span>
      <span class="xk-chips">${TARGETS.map(([v, l]) => `<button class="xk-mini xk-press${it.to === v ? " on" : ""}" data-i="${i}" data-v="${v}">${l}</button>`).join("")}</span></div>`).join("");
    openSheet(`<h2>导入这些文件</h2><p class="sub">去处是按文件名猜的，点一下能改。世界书会整份换成这次选成「世界书」的文件（按顺序拼在一起）；同一个人选了好几份人设，用最后一份。新开的会话才会用上。</p><div class="xk-list" id="xk-imp-l">${rows()}</div><button class="xk-wide xk-press" id="xk-imp-go">导入</button>`, (s) => {
      $("#xk-imp-l", s).onclick = (e) => { const b = e.target.closest("[data-i]"); if (!b) return; items[+b.dataset.i].to = b.dataset.v; SFX.play("tap"); $("#xk-imp-l", s).innerHTML = rows(); };
      $("#xk-imp-go", s).onclick = async () => {
        const done = [];
        try {
          const wb = items.filter((x) => x.to === "wb");
          if (wb.length) { const r = await api("/api/xk/worldbook", { method: "PUT", body: { files: wb.map(({ name, text }) => ({ name, text })) } }); done.push(`世界书 ${r.files} 个文件，${r.chars} 字`); }
          for (const id of ["xiaoke", "hachimi", "deepseek"]) {
            const it = items.filter((x) => x.to === id).pop(); if (!it) continue;
            const r = await api(`/api/xk/roles/${id}/persona`, { method: "PUT", body: { text: it.text } });
            done.push(`${rname(id)}的人设 ${r.personaChars} 字`);
          }
          closeSheet();
          if (done.length) { toast("导入好了", done.join("；"), sprite(cur.role || "xiaoke", "happy")); SFX.play("done"); renderRoles().catch(() => {}); }
        } catch (err) { fail(new Error((done.length ? "已导入：" + done.join("；") + "。" : "") + err.message)); }
      };
    });
  }
  async function roleSheet(id) {
    if (!ROLES) await loadRoles().catch(() => null);
    const r = R(id) || {}, z = asleep(id);
    const cd = z ? `额度大约 ${new Date(r.cooldown.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 恢复` : "";
    const [mem, dia] = await Promise.all([api("/api/xk/memory?role=" + id).catch(() => ({ items: [] })), api("/api/xk/diary?role=" + id).catch(() => ({ days: [] }))]);
    openSheet(`<div style="display:flex;gap:14px;align-items:center"><img src="${sprite(id, z ? "sleeping" : "wave")}" alt="" style="width:96px;height:96px;object-fit:contain"><div><h2>${rname(id)}</h2><p class="sub" style="margin:0">${ROLE[id].sub} · ${roleState(id)}${cd ? " · " + cd : ""}</p></div></div>
      <div class="xk-facts"><div><b>${r.imported ? r.personaChars + " 字" : "还没导入"}</b>人设</div><div><b>共用</b>世界书</div><div><b>${mem.items.length} 条</b>记忆</div><div><b>${dia.days.length} 篇</b>日记</div></div>
      <div class="xk-list" style="margin-top:12px"><label class="xk-row xk-press" style="cursor:pointer"><span class="k">导入人设<small>.txt，「【一】system_prompt」那样分三段；没有标记就整篇当人设</small></span>${svg("go")}<input type="file" id="xk-pf" hidden></label>
      ${id === "hachimi" ? `<div id="xk-agy"><div class="xk-row"><span class="k">Google 账号（Antigravity）<small>查询中…</small></span></div></div>` : ""}</div>
      <button class="xk-wide xk-press" id="xk-talk"${z ? " disabled" : ""}>${z ? "她睡着了" : id === cur.role ? "回去聊天" : `换${rname(id)}来聊`}</button>`, (s) => {
      $("#xk-talk", s).onclick = () => { closeSheet(); go(0); if (id !== cur.role) setTimeout(() => switchRole(id).catch(fail), 380); };
      $("#xk-pf", s).onchange = async (e) => {
        const f = e.target.files[0]; if (!f) return;
        try { const x = await api(`/api/xk/roles/${id}/persona`, { method: "PUT", body: { text: await f.text() } }); toast(`${rname(id)}的人设导入好了`, `人设 ${x.personaChars} 字，post_history ${x.postHistoryChars} 字。新开的会话才会用上`, sprite(id, "happy")); closeSheet(); }
        catch (err) { fail(err); }
      };
      if (id === "hachimi") agyPanel($("#xk-agy", s));
    });
  }

  // ── 哈基米的 Google 登录：网关在伪终端里跑 agy、选 Google 登录、交出登录链接；主人授权后把授权码贴回来 ──
  const openUrl = (u) => { try { if (window.CCApp && typeof CCApp.openUrl === "function") return CCApp.openUrl(u); } catch {} window.open(u, "_blank", "noopener"); };
  async function agyPanel(box, fresh) {
    const row = (k, sub, right = "") => `<div class="xk-row"><span class="k">${k}${sub ? `<small>${sub}</small>` : ""}</span>${right}</div>`;
    let a;
    try { a = await api("/api/xk/agy" + (fresh ? "?fresh=1" : "")); } catch (e) { box.innerHTML = row("Google 账号（Antigravity）", esc(e.message)); return; }
    if (!box.isConnected) return;
    if (!a.installed) {
      box.innerHTML = row("Antigravity 还没装", "哈基米靠它用你的 Google 账号说话。从官方渠道下载，按官方清单核对 sha512", '<button class="xk-mini xk-press" data-a="install">下载安装</button>');
    } else if (a.auth) {
      const opts = [{ id: "", label: "跟随 agy 的默认" }, ...a.models];
      // 登录是好的，但 Google 要求先验证账号（#2）：验证链接交给系统浏览器，验证完点「验证好了」，下一条消息再试
      const v = a.verify;
      box.innerHTML = (v ? row("Google 要求先验证这个账号", "验证之前哈基米用不了 Gemini，也不会替班。验证完回来点「验证好了」",
        (v.url ? '<button class="xk-mini xk-press" data-a="verify">去验证</button><button class="xk-mini xk-press" data-a="copy">复制链接</button>' : "") + '<button class="xk-mini xk-press" data-a="verified">验证好了</button>') : "") +
        row("Google 账号", `已登录 · agy ${esc(a.version)}`, '<button class="xk-mini xk-press" data-a="relogin">重新登录</button>') +
        `<div class="xk-row stack"><span class="k">哈基米用的模型<small>换了从下一条消息起生效</small></span><span class="xk-chips">${opts.map((m) => `<button class="xk-mini xk-press${(a.model || "") === m.id ? " on" : ""}" data-m="${esc(m.id)}">${esc(m.label)}</button>`).join("")}</span></div>`;
      box.dataset.url = (v && v.url) || "";
    } else {
      const L = a.login || {};
      if (L.stage === "url" || L.stage === "verifying") {
        box.innerHTML = row("① 打开登录页，用 Google 账号授权", "授权完页面上会给一串授权码", '<button class="xk-mini xk-press" data-a="open">打开登录页</button><button class="xk-mini xk-press" data-a="copy">复制链接</button>') +
          `<div class="xk-row stack"><span class="k">② 把授权码贴到这里</span><span class="xk-chips"><input id="xk-agy-code" placeholder="授权码" autocomplete="off" style="flex:1;min-width:140px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);padding:8px 10px;font:14px var(--mono, monospace)"><button class="xk-mini xk-press" data-a="code">${L.stage === "verifying" ? "确认中…" : "提交"}</button></span></div>`;
      } else {
        box.innerHTML = row("Google 账号", L.stage === "failed" ? "没登上：" + esc(L.error) : L.stage === "starting" || L.stage === "choosing" ? "正在准备登录页…" : a.auth === false ? "还没登录" : "查不到登录状态，可能是网络问题",
          `<button class="xk-mini xk-press" data-a="login">${L.stage === "failed" ? "再试一次" : "登录 Google"}</button>`);
      }
      // 登录进行中：盯着进度，拿到链接、登上了都会刷新这块
      if (["starting", "choosing", "verifying"].includes(L.stage)) setTimeout(() => agyPanel(box), 1500);
      box.dataset.url = L.url || "";
    }
    box.onclick = async (e) => {
      const b = e.target.closest("[data-a],[data-m]"); if (!b) return;
      SFX.play("tap");
      try {
        if (b.dataset.m != null) { await api("/api/xk/agy/model", { method: "PUT", body: { model: b.dataset.m } }); toast("换好了", "哈基米下一条消息起用 " + (b.dataset.m || "agy 的默认模型"), sprite("hachimi", "happy")); return agyPanel(box); }
        const act = b.dataset.a;
        if (act === "install") { b.textContent = "下载中…"; b.disabled = true; const x = await api("/api/xk/agy/install", { method: "POST" }); toast(`agy ${x.version} 装好了`, "接着登录 Google 账号"); return agyPanel(box, true); }
        if (act === "login" || act === "relogin") { b.textContent = "准备中…"; b.disabled = true; await api("/api/xk/agy/login", { method: "POST" }); return agyPanel(box); }
        if (act === "open" || act === "verify") return openUrl(box.dataset.url);
        if (act === "verified") { await api("/api/xk/agy/verified", { method: "POST" }); toast("好，再试试", "给哈基米发一条消息；还不行会再提示", sprite("hachimi", "happy")); return agyPanel(box); }
        if (act === "copy") { try { await navigator.clipboard.writeText(box.dataset.url); toast("链接复制好了", "到浏览器里粘贴打开"); } catch { window.prompt?.("复制这个链接", box.dataset.url); } return; }
        if (act === "code") { const code = $("#xk-agy-code", box).value.trim(); if (!code) return; await api("/api/xk/agy/login/code", { method: "POST", body: { code } }); return agyPanel(box); }
      } catch (err) { fail(err); agyPanel(box); }
    };
    if (a.auth && box.dataset.wasLogin === "1") { toast("哈基米登上了", "Google 账号已连好", sprite("hachimi", "happy")); SFX.play("done"); }
    box.dataset.wasLogin = a.auth ? "0" : (a.login && a.login.stage !== "idle" ? "1" : box.dataset.wasLogin || "0");
  }

  // ── 模型和人设绑定：输入栏里选了另一个角色那家的模型，就换成那个角色 ──
  // 已有会话：网关拦下这次换型号，回一个 xkSwitch（原会话不动），这里开新会话落到那个角色、记着刚选的型号；
  // 新会话（还没会话号）：上游拿 ?provider= 问一遍，这里看到就直接换人，选的型号由上游自己记着
  const roleOfProv = (pid) => ROLES && pid ? (ROLES.roles.find((r) => r.provider === pid) || {}).id || null : null;
  let binding = false;
  const rawFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const res = await rawFetch(input, init);
    try {
      const url = typeof input === "string" ? input : input.url || "";
      if (!binding && url.startsWith("/api/session-model")) {
        if (String(init?.method || "GET").toUpperCase() === "POST") {
          const j = await res.clone().json();
          if (j.xkSwitch) bindTo(j.xkSwitch.to, { provider: j.xkSwitch.provider, model: j.xkSwitch.model });
        } else {
          const q = new URL(url, location.origin).searchParams, to = !q.get("id") && roleOfProv(q.get("provider"));
          if (to && cur.role && to !== cur.role) bindTo(to, null);
        }
      }
    } catch {}
    return res;
  };
  async function bindTo(to, pick) {
    binding = true;
    try {
      const r = await switchRole(to);
      // 刚选的型号带过去：新会话的第一条消息会把它钉上（回到原来那段时不钉，那段有它自己的型号）
      if (!r.resume && pick && pick.provider) window.__cc.state.pendingModel = { provider: pick.provider, ...(pick.model != null ? { model: pick.model } : {}) };
    } catch (e) { fail(e); } finally { setTimeout(() => { binding = false; }, 800); }
  }

  // ── 记忆页 ──
  const KIND = { fact: "事实", event: "事件", plan: "计划", opinion: "看法" };
  const CH = { app: "App", "qq-private": "QQ 私聊", "qq-group": "QQ 群" };
  let memRole = null, memItems = [];
  async function renderMem() {
    if (!ROLES) await loadRoles();
    memRole = memRole || cur.role || "xiaoke";
    const b = body("mem");
    b.innerHTML = `<div class="xk-tools"></div><div id="xk-ml"></div>`;
    const tools = $(".xk-tools", b);
    tools.append(seg(memRole, (id) => { memRole = id; loadMem(); }));
    tools.insertAdjacentHTML("beforeend", `<label class="xk-search">${svg("search")}<input id="xk-mq" placeholder="搜记忆" aria-label="搜记忆"></label>`);
    $("#xk-mq", b).oninput = drawMem;
    await loadMem();
  }
  async function loadMem() { memItems = (await api("/api/xk/memory?role=" + memRole)).items || []; drawMem(); }
  // 本地日期 YYYY-MM-DD（x 天前）：toISOString 是 UTC，每天 0–8 点会错一天（#16）
  const localDay = (x = 0) => { const d = new Date(Date.now() - x * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  function memGroup(d) {
    const day = localDay;
    return d === day(0) ? "今天" : d === day(1) ? "昨天" : d >= day(7) ? "这一周" : d.slice(0, 7).replace("-", " 年 ") + " 月";
  }
  function drawMem() {
    const box = $("#xk-ml"); if (!box) return;
    const q = ($("#xk-mq")?.value || "").trim();
    const list = memItems.filter((m) => !q || m.text.includes(q) || (m.who || "").includes(q)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (!list.length) { box.innerHTML = `<div class="xk-empty"><img src="${q ? stateArt("search_empty", memRole) : art(memRole === "xiaoke" ? "xiaoke/11_memory" : "deco/empty_memory")}" alt="">${q ? "没找到相关的记忆" : `${rname(memRole)}还没有记忆<br>聊过的事停下 10 分钟后，她会自己整理进来`}</div>`; return; }
    let html = "", last = "";
    for (const m of list) {
      const g = memGroup(m.date || ""); if (g !== last) { html += `<div class="xk-gt">${g}</div>`; last = g; }
      html += `<div class="xk-mem${m.past ? " past" : ""}" data-id="${esc(m.id)}"><button><span class="meta">${esc(m.date)} · ${KIND[m.kind] || esc(m.kind)} · ${esc(m.who)} · ${CH[m.channel] || esc(m.channel)}${m.past ? " · 已过去" : ""}</span><span class="txt">${esc(m.text)}</span></button>
        <div class="acts"><div><button class="xk-mini xk-press" data-a="edit">改</button><button class="xk-mini xk-press" data-a="past">${m.past ? "改回还成立" : "标成已过去"}</button><button class="xk-mini danger xk-press" data-a="del">忘掉</button></div></div></div>`;
    }
    box.innerHTML = html;
    box.querySelectorAll(".xk-mem").forEach((el) => {
      const m = memItems.find((x) => x.id === el.dataset.id);
      el.firstElementChild.onclick = () => { el.classList.toggle("open"); SFX.play("tap"); };
      el.querySelectorAll("[data-a]").forEach((b) => b.onclick = async () => {
        const url = `/api/xk/memory/${memRole}/${encodeURIComponent(m.id)}`;
        try {
          if (b.dataset.a === "past") { await api(url, { method: "PATCH", body: { past: !m.past, until: m.past ? "" : localDay() } }); m.past = !m.past; SFX.play("toggle"); drawMem(); }
          else if (b.dataset.a === "del") {
            if (b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "再点一次就忘掉"; return; }
            await api(url, { method: "DELETE" }); SFX.play("sheet"); el.classList.add("gone");
            setTimeout(() => { memItems = memItems.filter((x) => x !== m); drawMem(); }, 320);
          } else {
            const acts = el.querySelector(".acts > div");
            acts.innerHTML = `<textarea rows="3" aria-label="内容">${esc(m.text)}</textarea><button class="xk-mini xk-press" data-s="1">保存</button>`;
            acts.querySelector("[data-s]").onclick = async () => {
              const text = acts.querySelector("textarea").value.trim(); if (!text) return;
              try { await api(url, { method: "PATCH", body: { text } }); m.text = text; SFX.play("done"); drawMem(); } catch (e) { fail(e); }
            };
          }
        } catch (e) { fail(e); }
      });
    });
  }

  // ── 日记页 ──
  let diaryRole = null, diaryDay = null, diaryDays = [], diaryFix = null;
  async function renderDiary() {
    if (!ROLES) await loadRoles();
    diaryRole = diaryRole || cur.role || "xiaoke";
    const b = body("diary");
    b.innerHTML = `<div id="xk-dseg"></div><div class="xk-days" id="xk-days"></div><div class="xk-book"><article class="xk-leaf" id="xk-leaf"></article></div>`;
    $("#xk-dseg", b).append(seg(diaryRole, (id) => { diaryRole = id; diaryDay = null; loadDiary(true); }));
    await loadDiary(false);
  }
  async function loadDiary(flip) {
    const r = await api("/api/xk/diary?role=" + diaryRole);
    diaryDays = (r.days || []).slice().sort();
    if (!diaryDay || !diaryDays.includes(diaryDay)) diaryDay = diaryDays[diaryDays.length - 1] || null;
    const wd = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const days = $("#xk-days");
    days.innerHTML = diaryDays.map((d) => `<button class="xk-day xk-press${d === diaryDay ? " on" : ""}" data-d="${d}">${wd[new Date(d + "T12:00").getDay()]}<b>${+d.slice(8)}</b></button>`).join("");
    days.onclick = (e) => { const b = e.target.closest(".xk-day"); if (!b || b.dataset.d === diaryDay) return; diaryDay = b.dataset.d; days.querySelectorAll(".xk-day").forEach((x) => x.classList.toggle("on", x === b)); SFX.play("tab"); syncDiaryExport(); drawLeaf(true); };
    requestAnimationFrame(() => days.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }));
    // 日记写不写得了按真实状态说（#15）：被挡住就写原因、给去处理的按钮
    let blk = null; try { const h = await api("/api/xk/health"); const r0 = h.roles.find((x) => x.id === diaryRole); blk = r0 && r0.diary; } catch {}
    const leaf = $("#xk-leaf");
    leaf.dataset.r = ROLE[diaryRole].dir || diaryRole;
    leaf.dataset.note = blk ? "现在写不了：" + blk.why : r.pending?.length ? "素材攒着呢，今晚十点后写第一篇" : "每晚十点后，她会根据当天的聊天写一篇";
    diaryFix = blk && blk.fix;
    $("#xk-dwarn")?.remove();
    if (blk && diaryDays.length) days.insertAdjacentHTML("afterend", `<p class="xk-hint xk-warn" id="xk-dwarn">${esc(rname(diaryRole))}今晚写不了：${esc(blk.why)}</p>`);
    syncDiaryExport();
    drawLeaf(flip);
  }
  function syncDiaryExport() { const b = $("#xk-diary-export"); if (b) b.disabled = !diaryDay || exporting || !$("#xk-leaf .body"); }
  async function drawLeaf(flip) {
    const leaf = $("#xk-leaf");
    let html;
    if (!diaryDay) html = `<div class="xk-empty"><img class="xk-cover" src="${art("diary/cover_" + leaf.dataset.r)}" alt="">${rname(diaryRole)}还没写过日记<br>${esc(leaf.dataset.note)}${diaryFix ? '<button class="xk-mini xk-press" id="xk-dfix">去处理</button>' : ""}</div>`;
    else {
      try {
        const t = await api(`/api/xk/diary/${diaryRole}/${diaryDay}`);
        html = `<span class="ribbon"></span><h3>${+diaryDay.slice(5, 7)}月${+diaryDay.slice(8)}日</h3><div class="body">${esc(String(t.text || "").replace(/^#.*\n+/, "").trim())}</div><img class="sign" src="${art(ROLE[diaryRole].mark)}" alt="">`;
      } catch (e) { html = `<div class="xk-empty">${esc(e.message)}</div>`; }
    }
    const put = () => { leaf.innerHTML = html; leaf.classList.toggle("blank", !diaryDay); const f = $("#xk-dfix", leaf); if (f) f.onclick = () => doFix(diaryFix); syncDiaryExport(); };
    if (flip && moving()) { leaf.classList.remove("flip"); void leaf.offsetWidth; leaf.classList.add("flip"); setTimeout(put, 250); }
    else put();
  }

  // 日记导出成图片：照屏幕上的纸纹、日期、横线和签名画一张（不在页面里截屏，长日记也整篇放得下）
  const imgOf = (src) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error("图片没读出来")); i.src = src; });
  function roundPath(c, x, y, w, h) {
    const [tl, tr, br, bl] = [6, 16, 16, 6];
    c.beginPath();
    c.moveTo(x + tl, y);
    c.lineTo(x + w - tr, y); c.arcTo(x + w, y, x + w, y + tr, tr);
    c.lineTo(x + w, y + h - br); c.arcTo(x + w, y + h, x + w - br, y + h, br);
    c.lineTo(x + bl, y + h); c.arcTo(x, y + h, x, y + h - bl, bl);
    c.lineTo(x, y + tl); c.arcTo(x, y, x + tl, y, tl);
    c.closePath();
  }
  // 中文按字断，拉丁词尽量落在空格处
  function wrapLines(c, text, maxW) {
    const out = [];
    for (const para of text.split("\n")) {
      if (!para) { out.push(""); continue; }
      let line = "";
      for (const ch of para) {
        if (!line || c.measureText(line + ch).width <= maxW) { line += ch; continue; }
        const sp = line.lastIndexOf(" ");
        if (sp > 0 && /[A-Za-z0-9,.;:!?'")\]}]/.test(ch)) { out.push(line.slice(0, sp)); line = line.slice(sp + 1) + ch; }
        else if (line.length > 1 && /[，。！？、；：）》】」』”’…—,.!?;:)\]}%]/.test(ch)) {
          // 别让标点落在行首：把上一个字一起挪到下一行
          out.push(line.slice(0, -1)); line = line.slice(-1) + ch;
        } else { out.push(line); line = ch; }
      }
      out.push(line);
    }
    return out;
  }
  const fontOf = (el, sizeFallback) => {
    const s = getComputedStyle(el);
    return `${s.fontStyle || "normal"} ${s.fontWeight || "400"} ${s.fontSize || sizeFallback} ${s.fontFamily || "serif"}`;
  };
  async function diaryCanvas(role, date, text) {
    const leaf = $("#xk-leaf"), bodyEl = leaf?.querySelector(".body"), titleEl = leaf?.querySelector("h3");
    if (!leaf || !bodyEl) throw new Error("日记还没画出来");
    try { await document.fonts.ready; } catch {}
    const cs = getComputedStyle(leaf), root2 = getComputedStyle(document.documentElement);
    const titleFont = titleEl ? fontOf(titleEl, "20px") : "400 20px serif";
    const bodyFont = fontOf(bodyEl, "15.5px");
    try { await Promise.all([document.fonts.load(bodyFont, "你好"), document.fonts.load(titleFont, "日记")]); } catch {}
    const fg = cs.color || "#333";
    const line = root2.getPropertyValue("--line").trim() || "rgba(0,0,0,.12)";
    const bg = root2.getPropertyValue("--bg").trim() || "#f3efe8";
    const bg2 = root2.getPropertyValue("--bg2").trim() || "#fff";
    let paperUrl = (cs.backgroundImage || "").match(/url\(["']?(.*?)["']?\)/)?.[1];
    if (!paperUrl) {
      const dir = ROLE[role]?.dir || role, dark = root.dataset.theme === "dark";
      paperUrl = "/xk-art/" + (role === "xiaoke" ? (dark ? "deco/paper_dark" : "deco/paper_light")
        : `diary/paper_${dir}_${dark ? "dark" : "light"}`) + ".webp";
    }
    const [paper, sign] = await Promise.all([
      imgOf(paperUrl).catch(() => null),
      imgOf(art(ROLE[role]?.mark || ROLE.xiaoke.mark)).catch(() => null),
    ]);

    const W = 440, M = 18;
    const padT = parseFloat(cs.paddingTop) || 22, padR = parseFloat(cs.paddingRight) || 22;
    const padB = parseFloat(cs.paddingBottom) || 26, padL = parseFloat(cs.paddingLeft) || 26;
    const tcs = titleEl ? getComputedStyle(titleEl) : null;
    const titleSize = parseFloat(tcs?.fontSize) || 20, titleLine = titleSize * 1.2, titleGap = 12;
    const bcs = getComputedStyle(bodyEl);
    const bodySize = parseFloat(bcs.fontSize) || 15.5, lineH = parseFloat(bcs.lineHeight) || bodySize * 2.05;
    const bodyText = String(text || "").replace(/^#.*\n+/, "").trim();
    const meter = document.createElement("canvas").getContext("2d");
    meter.font = bodyFont;
    const lines = wrapLines(meter, bodyText, W - padL - padR);
    const bodyStart = padT + titleLine + titleGap;
    const H = Math.max(360, bodyStart + Math.max(lineH, lines.length * lineH) + padB);

    const totalW = W + M * 2, totalH = H + M * 2;
    let scale = Math.min(2.5, 1080 / totalW);
    if (totalH * scale > 10000) scale = 10000 / totalH;
    if (scale < .75) throw new Error("这篇日记太长，一张图放不下");
    const cv = document.createElement("canvas");
    cv.width = Math.round(totalW * scale); cv.height = Math.round(totalH * scale);
    const c = cv.getContext("2d");
    c.scale(scale, scale);

    c.fillStyle = bg; c.fillRect(0, 0, totalW, totalH);
    c.save();
    c.shadowColor = "rgba(0,0,0,.18)"; c.shadowBlur = 18 * scale; c.shadowOffsetY = 5 * scale;
    roundPath(c, M, M, W, H); c.fillStyle = bg2; c.fill();
    c.restore();

    c.save();
    roundPath(c, M, M, W, H); c.clip();
    c.translate(M, M);
    c.fillStyle = bg2; c.fillRect(0, 0, W, H);
    if (paper) {
      const pat = c.createPattern(paper, "repeat");
      if (pat) {
        try { pat.setTransform(new DOMMatrix([256 / paper.width, 0, 0, 256 / paper.height, 0, 0])); } catch {}
        c.fillStyle = pat; c.fillRect(0, 0, W, H);
      }
    }
    const lgrad = c.createLinearGradient(0, 0, 30, 0);
    lgrad.addColorStop(0, "rgba(0,0,0,.14)"); lgrad.addColorStop(1, "rgba(0,0,0,0)");
    c.fillStyle = lgrad; c.fillRect(0, 0, 30, H);
    c.restore();

    c.save();
    c.globalAlpha = .85; c.fillStyle = fg;
    const rx = M + W - 28 - 14, ry = M - 6;
    c.beginPath(); c.moveTo(rx, ry); c.lineTo(rx + 14, ry); c.lineTo(rx + 14, ry + 64);
    c.lineTo(rx + 7, ry + 52.5); c.lineTo(rx, ry + 64); c.closePath(); c.fill();
    c.restore();

    c.save();
    c.textAlign = "left"; c.textBaseline = "middle"; c.fillStyle = fg;
    c.font = titleFont;
    c.fillText(`${+date.slice(5, 7)}月${+date.slice(8)}日`, M + padL, M + padT + titleLine / 2);
    c.font = bodyFont;
    const x0 = M + padL, x1 = M + W - padR, y0 = M + bodyStart;
    c.strokeStyle = line; c.lineWidth = 1;
    for (let i = 1; i <= lines.length; i++) {
      c.beginPath(); c.moveTo(x0, y0 + i * lineH - 1); c.lineTo(x1, y0 + i * lineH - 1); c.stroke();
    }
    lines.forEach((ln, i) => { if (ln) c.fillText(ln, x0, y0 + i * lineH + lineH / 2); });
    c.restore();

    if (sign) c.drawImage(sign, M + W - 18 - 34, M + H - 14 - 34, 34, 34);
    const blob = await new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("图片没生成出来"))), "image/png"));
    return blob;
  }
  function exportSheet() {
    if (!diaryDay) return;
    const d = diaryDay;
    openSheet(`<h2>导出这篇日记</h2><p class="sub">${esc(rname(diaryRole))} · ${+d.slice(5, 7)}月${+d.slice(8)}日 · 纸纹、横线和签名一起做成一张图</p>
      <button class="xk-wide xk-press" id="xk-dl-save">保存图片</button>
      ${shell ? '<button class="xk-wide xk-soft xk-press" id="xk-dl-share">分享图片</button>' : ""}`,
      (s) => {
        $("#xk-dl-save", s).onclick = () => { closeSheet(); drawDiaryImage(false); };
        const sh = $("#xk-dl-share", s); if (sh) sh.onclick = () => { closeSheet(); drawDiaryImage(true); };
      });
  }
  let exporting = false;
  async function drawDiaryImage(share) {
    if (exporting || !diaryDay) return;
    exporting = true; syncDiaryExport();
    toast("正在做图", "纸纹、字和签名一起画，稍等");
    try {
      const role = diaryRole, date = diaryDay;
      const t = await api(`/api/xk/diary/${role}/${date}`);
      const blob = await diaryCanvas(role, date, String(t.text || ""));
      const name = `${rname(role)}的日记 ${date}.png`;
      const r = await fetch(`/api/xk/diary/export?role=${encodeURIComponent(role)}&date=${encodeURIComponent(date)}`,
        { method: "POST", headers: { "content-type": "image/png" }, body: blob });
      let j;
      if (r.status === 404) {
        // 网关还没换上新版（导出接口是后加的）：退回附件上传，先把图存下来
        const u = await fetch("/api/upload?name=" + encodeURIComponent(name), { method: "POST", headers: { "content-type": "image/png" }, body: blob });
        const uj = await u.json().catch(() => ({}));
        if (!u.ok || uj.ok === false) throw new Error(uj.error || uj.message || "HTTP " + u.status);
        j = { path: uj.path, name };
      } else {
        j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || j.error || "HTTP " + r.status);
      }
      if (share) {
        const s = await api("/api/app/share_file", { method: "POST", body: { path: j.path } });
        if (!s.ok) throw new Error(s.message || "分享失败");
        toast("发出去了", j.name);
      } else if (shell && shell.saveAs) {
        shell.saveAs(j.path, j.name, "image/png");
      } else {
        const u = URL.createObjectURL(blob), a = document.createElement("a");
        a.href = u; a.download = j.name; document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(u), 10000);
        toast("图片做好了", j.name);
      }
    } catch (e) { fail(e); }
    exporting = false; syncDiaryExport();
  }

  // ── 群聊导出长图（#66）：还是前端 canvas 自己画，再传给 /api/xk/room/export 落盘 ──
  //    msgs: [{from:"owner"|"system"|角色id, text, at, kind?:"aside"}]，由群页多选那层传进来
  let roomExporting = false;
  function bubblePath(c, x, y, w, h, tl, tr, br, bl) {
    const m = Math.max(0, Math.min(h / 2, w / 2));
    [tl, tr, br, bl] = [tl, tr, br, bl].map((v) => Math.max(0, Math.min(v, m)));
    c.beginPath();
    c.moveTo(x + tl, y);
    c.lineTo(x + w - tr, y); c.arcTo(x + w, y, x + w, y + tr, tr);
    c.lineTo(x + w, y + h - br); c.arcTo(x + w, y + h, x + w - br, y + h, br);
    c.lineTo(x + bl, y + h); c.arcTo(x, y + h, x, y + h - bl, bl);
    c.lineTo(x, y + tl); c.arcTo(x, y, x + tl, y, tl);
    c.closePath();
  }
  const rtd = (t) => { const d = new Date(t), p = (n) => String(n).padStart(2, "0"); return { day: `${d.getMonth() + 1}月${d.getDate()}日`, hm: `${p(d.getHours())}:${p(d.getMinutes())}` }; };
  function roomSpan(list) {
    const ats = list.map((m) => m.at).filter((x) => typeof x === "number");
    if (!ats.length) return "";
    const a = rtd(Math.min(...ats)), b = rtd(Math.max(...ats));
    return a.day === b.day ? `${a.day} ${a.hm} ~ ${b.hm}` : `${a.day} ${a.hm} ~ ${b.day} ${b.hm}`;
  }
  async function roomCanvas(msgs, opts = {}) {
    const hideNames = !!opts.hideNames;
    const fold = opts.fold !== false;
    const list = (msgs || []).filter((m) => m && m.text != null);
    if (!list.length) throw new Error("没有选消息");
    try { await document.fonts.ready; } catch {}
    const root2 = getComputedStyle(document.documentElement);
    const ink = (n, fb) => root2.getPropertyValue(n).trim() || fb;
    const FONT = getComputedStyle(document.body).fontFamily || "sans-serif";
    const bg = ink("--bg", "#f3efe8"), bg2 = ink("--bg2", "#fff"), bg3 = ink("--bg3", "#eee");
    const fg = ink("--fg", "#333"), fg2 = ink("--fg2", "#666"), fg3 = ink("--fg3", "#999");
    const accent = ink("--accent", "#d9692a"), onAccent = ink("--on-accent", "#fff"), line = ink("--line", "rgba(0,0,0,.12)");
    const roleColor = (id) => ink("--xk-c-" + (id === "deepseek" ? "xiaoyu" : id), fg2);
    const bFont = `400 15px ${FONT}`, aFont = `400 13.5px ${FONT}`, nFont = `500 12px ${FONT}`, sFont = `400 12px ${FONT}`, tFont = `700 20px ${FONT}`, tsFont = `400 11px ${FONT}`, noteFont = `400 11px ${FONT}`;
    const W = 440, HEAD = 120, PX = 16, AV = 36, AVGAP = 8, GAP = 10;
    const innerW = W - PX * 2, herMax = innerW - AV - AVGAP, meMax = Math.round(innerW * 0.82);
    const lineH = 15 * 1.55, padY = 8, padX = 12, nameH = hideNames ? 0 : 16, asideH = 13.5 * 1.5;
    const meter = document.createElement("canvas").getContext("2d");

    // 折叠长消息：只露第一段，第一段超过五行就截断（和群页 foldBody 同一套判断）
    const NOTE_H = 15;
    function foldLines(text, maxW) {
      const fp = foldParts(text, fold);
      let lines = wrapLines(meter, fp.folded ? fp.head : String(text ?? ""), maxW), hidden = 0;
      if (fp.folded) {
        hidden = fp.rest.length;
        if (fp.head.length > CLAMP_AT && lines.length > 5) {
          const kept = lines.slice(0, 5);
          hidden += fp.head.length - kept.join("").length;
          lines = kept;
        }
      }
      return { lines, hidden };
    }
    // 先量高度（和日记导出一个路子）
    const layout = [];
    let bodyH = 0;
    for (const m of list) {
      let it;
      if (m.from === "system") {
        meter.font = sFont;
        it = { km: "sys", lines: wrapLines(meter, String(m.text), innerW - 24) };
        it.h = Math.max(20, it.lines.length * 17 + 6);
      } else if (m.from === "owner") {
        meter.font = bFont;
        const fl = foldLines(m.text, meMax - padX * 2);
        it = { km: "me", lines: fl.lines, hidden: fl.hidden };
        it.h = it.lines.length * lineH + padY * 2 + (it.hidden ? NOTE_H : 0);
      } else {
        const aside = m.kind === "aside";
        meter.font = aside ? aFont : bFont;
        const fl = foldLines(m.text, herMax - (aside ? 20 : padX * 2));
        it = { km: aside ? "aside" : "her", lines: fl.lines, hidden: fl.hidden };
        it.bh = it.lines.length * (aside ? asideH : lineH) + (aside ? 4 : padY * 2) + (it.hidden ? NOTE_H : 0);
        it.h = Math.max(AV, nameH + it.bh);
      }
      it.m = m; it.y = bodyH; bodyH += it.h + GAP;
      layout.push(it);
    }
    const contentBottom = HEAD + 14 + bodyH - GAP;
    const totalH = contentBottom + 56;
    let scale = 1080 / W;
    if (totalH * scale > 10000) scale = 10000 / totalH;
    if (scale < .75) throw new Error("选的太多，一张图放不下");

    const cv = document.createElement("canvas");
    cv.width = Math.round(W * scale); cv.height = Math.round(totalH * scale);
    const c = cv.getContext("2d");
    c.scale(scale, scale);
    c.fillStyle = bg; c.fillRect(0, 0, W, totalH);

    // 头部：群头图上叠群名和时间跨度，再一条分隔线
    const head = await imgOf(art("room/room_header")).catch(() => null);
    if (head) {
      const ir = head.width / head.height, hr = W / HEAD;
      let sw = head.width, sh = head.height;
      if (ir > hr) sw = head.height * hr; else sh = head.width / hr;
      c.drawImage(head, (head.width - sw) / 2, (head.height - sh) / 2, sw, sh, 0, 0, W, HEAD);
    } else { c.fillStyle = bg3; c.fillRect(0, 0, W, HEAD); }
    const hg = c.createLinearGradient(0, HEAD - 70, 0, HEAD);
    hg.addColorStop(0, "rgba(0,0,0,0)"); hg.addColorStop(1, "rgba(0,0,0,.42)");
    c.fillStyle = hg; c.fillRect(0, HEAD - 70, W, 70);
    c.textAlign = "center"; c.textBaseline = "middle";
    c.shadowColor = "rgba(0,0,0,.45)"; c.shadowBlur = 6;
    c.fillStyle = "#fff"; c.font = tFont; c.fillText("我们仨", W / 2, HEAD - 40);
    c.font = tsFont; c.fillText(roomSpan(list), W / 2, HEAD - 20);
    c.shadowColor = "transparent"; c.shadowBlur = 0;
    c.fillStyle = line; c.fillRect(0, HEAD, W, 1);
    c.textAlign = "left";

    // 头像先读好，别在循环里一张张等
    const avs = {};
    for (const id of new Set(list.filter((m) => m.from !== "owner" && m.from !== "system").map((m) => m.from)))
      avs[id] = await imgOf(bub(id, "idle")).catch(() => null);

    let y = HEAD + 14;
    for (const it of layout) {
      const m = it.m;
      if (it.km === "sys") {
        c.font = sFont;
        const tw = Math.min(innerW - 24, Math.max(0, ...it.lines.map((l) => c.measureText(l).width)));
        const pw = tw + 24, ph = it.h, x = (W - pw) / 2;
        bubblePath(c, x, y, pw, ph, ph / 2, ph / 2, ph / 2, ph / 2);
        c.fillStyle = bg2; c.fill();
        c.fillStyle = fg3; c.textAlign = "center";
        it.lines.forEach((ln, i) => c.fillText(ln, W / 2, y + ph / 2 + (i - (it.lines.length - 1) / 2) * 17));
        c.textAlign = "left";
      } else if (it.km === "me") {
        c.font = bFont;
        const tw = Math.min(meMax - padX * 2, Math.max(0, ...it.lines.map((l) => c.measureText(l).width)));
        const bw = tw + padX * 2, x = W - PX - bw;
        bubblePath(c, x, y, bw, it.h, 16, 16, 4, 16);
        c.fillStyle = accent; c.fill();
        c.fillStyle = onAccent;
        it.lines.forEach((ln, i) => c.fillText(ln, x + padX, y + padY + lineH / 2 + i * lineH));
        if (it.hidden) { c.font = noteFont; c.globalAlpha = .7; c.fillText(`（后面还有 ${it.hidden} 字，已折叠）`, x + padX, y + padY + it.lines.length * lineH + NOTE_H / 2 + 1); c.globalAlpha = 1; }
      } else {
        const col = roleColor(m.from), av = avs[m.from];
        c.save();
        c.beginPath(); c.arc(PX + AV / 2, y + AV / 2, AV / 2, 0, Math.PI * 2); c.clip();
        if (av) c.drawImage(av, PX, y, AV, AV); else { c.fillStyle = bg2; c.fillRect(PX, y, AV, AV); }
        c.restore();
        c.beginPath(); c.arc(PX + AV / 2, y + AV / 2, AV / 2 - .75, 0, Math.PI * 2); c.strokeStyle = col; c.lineWidth = 1.5; c.stroke();
        c.font = nFont; c.fillStyle = col;
        if (!hideNames) c.fillText(rname(m.from) + (m.kind === "aside" ? "  插了一句" : ""), PX + AV + AVGAP, y + nameH / 2 + 1);
        const bx = PX + AV + AVGAP, by = y + nameH;
        c.font = m.kind === "aside" ? aFont : bFont;
        const mw = herMax - (m.kind === "aside" ? 20 : padX * 2);
        const tw = Math.min(mw, Math.max(0, ...it.lines.map((l) => c.measureText(l).width)));
        if (m.kind === "aside") {
          c.fillStyle = col; c.fillRect(bx, by + 2, 2, Math.max(0, it.bh - 4));
          c.fillStyle = fg2;
          it.lines.forEach((ln, i) => c.fillText(ln, bx + 10, by + 2 + asideH / 2 + i * asideH));
        } else {
          const bw = tw + padX * 2;
          bubblePath(c, bx, by, bw, it.bh, 4, 16, 16, 16);
          c.fillStyle = bg2; c.fill();
          c.fillStyle = col; c.fillRect(bx, by + 6, 3, Math.max(0, it.bh - 12));
          c.fillStyle = fg;
          it.lines.forEach((ln, i) => c.fillText(ln, bx + padX, by + padY + lineH / 2 + i * lineH));
        }
        if (it.hidden) {
          const tx = bx + (m.kind === "aside" ? 10 : padX);
          const ty = by + (m.kind === "aside" ? 2 : padY) + it.lines.length * (m.kind === "aside" ? asideH : lineH) + NOTE_H / 2 + 1;
          c.font = noteFont; c.fillStyle = fg3;
          c.fillText(`（后面还有 ${it.hidden} 字，已折叠）`, tx, ty);
        }
      }
      y += it.h + GAP;
    }

    c.textAlign = "center"; c.fillStyle = fg3; c.font = `400 11px ${FONT}`;
    c.fillText("cc.codroid · 聊天室记录", W / 2, totalH - 26);
    c.textAlign = "left";

    const blob = await new Promise((ok, no) => cv.toBlob((b) => (b ? ok(b) : no(new Error("图片没生成出来"))), "image/png"));
    return blob;
  }
  // 生成前先给主人看一眼：预览 + 「隐藏昵称」开关，确认无误再保存或分享（#66，照着 QQ 的隐藏昵称做）
  async function exportRoomImage(msgs, opts) {
    if (roomExporting) return;
    const list = (msgs || []).filter((m) => m && m.text != null);
    if (!list.length) return toast("没有选消息", "先勾几条再生成");
    const st = { hideNames: !!(opts && typeof opts === "object" && opts.hideNames), fold: !(opts && typeof opts === "object" && opts.fold === false), blob: null, url: "", busy: false };
    const render = async () => {
      if (st.busy) return;
      st.busy = true;
      try {
        st.blob = await roomCanvas(list, { hideNames: st.hideNames, fold: st.fold });
        if (st.url) URL.revokeObjectURL(st.url);
        st.url = URL.createObjectURL(st.blob);
        const img = $("#xk-prev-img", sheet); if (img) img.src = st.url;
      } catch (e) { fail(e); }
      st.busy = false;
    };
    const finish = async (share) => {
      if (st.busy || !st.blob) return;
      const blob = st.blob, name = "聊天室记录.png";
      try {
        const r = await fetch("/api/xk/room/export", { method: "POST", headers: { "content-type": "image/png" }, body: blob });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.message || j.error || "HTTP " + r.status);
        closeSheet();
        if (share) {
          const s = await api("/api/app/share_file", { method: "POST", body: { path: j.path } });
          if (!s.ok) throw new Error(s.message || "分享失败");
          toast("发出去了", j.name || name);
        } else if (shell && shell.saveAs) {
          shell.saveAs(j.path, j.name || name, "image/png");
        } else {
          const u = URL.createObjectURL(blob), a = document.createElement("a");
          a.href = u; a.download = j.name || name; document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(u), 10000);
          toast("图片做好了", j.name || name);
        }
      } catch (e) { fail(e); }
    };
    roomExporting = true;
    openSheet(`<h2>导出群聊记录</h2><p class="sub">共 ${list.length} 条 · 先看一眼，再保存或分享</p>
      <img id="xk-prev-img" alt="预览" style="width:100%;max-height:46vh;object-fit:contain;border-radius:12px;background:var(--bg3)"/>
      <div class="xk-row xk-press" id="xk-prev-hide-row" style="margin-top:8px"><span class="k">隐藏昵称</span><span class="xk-sw" id="xk-prev-hide"></span></div>
      <div class="xk-row xk-press" id="xk-prev-fold-row"><span class="k">折叠长消息</span><span class="xk-sw" id="xk-prev-fold"></span></div>
      <button class="xk-wide xk-press" id="xk-prev-save">保存图片</button>
      ${shell ? '<button class="xk-wide xk-soft xk-press" id="xk-prev-share">分享图片</button>' : ""}`,
      (s) => {
        $("#xk-prev-hide-row", s).onclick = () => { st.hideNames = !st.hideNames; $("#xk-prev-hide", s).classList.toggle("on", st.hideNames); render(); };
        $("#xk-prev-fold-row", s).onclick = () => { st.fold = !st.fold; $("#xk-prev-fold", s).classList.toggle("on", st.fold); render(); };
        $("#xk-prev-save", s).onclick = () => finish(false);
        const sh = $("#xk-prev-share", s); if (sh) sh.onclick = () => finish(true);
      });
    $("#xk-prev-hide", sheet)?.classList.toggle("on", st.hideNames);
    $("#xk-prev-fold", sheet)?.classList.toggle("on", st.fold);
    await render();
    roomExporting = false;
  }

  // ── 我的页（主人 11-02 定的：伴侣设置；上游整套设置和工具收进「开发者」）──
  //    顶上三人健康卡（#15），下面六个分区，点开从右边滑进来一层
  const cc = () => window.__cc;
  const rc = (id) => `var(--xk-c-${id === "deepseek" ? "xiaoyu" : id})`;
  const meRow = (id, k, sub, right) => `<button class="xk-row xk-press" id="${id}"><span class="k">${k}${sub ? `<small>${sub}</small>` : ""}</span>${right ?? svg("go")}</button>`;
  const sw = (on) => `<span class="xk-sw${on ? " on" : ""}"></span>`;
  const SECTS = [["account", "账号与接口", "她们各用各的那家"], ["appearance", "外观", "深浅、动效、音效"], ["notify", "通知", "提醒、悬浮窗"],
    ["usage", "用量", "三个人各花了多少"], ["pad", "平板", "配对平板，在平板上聊天、看画面"], ["about", "关于", "版本、更新、开源声明"], ["developer", "开发者", "cccodroid 原本的设置和工具"]];
  // 各分区的头图：「平板」用第三步那张配对图（没有单独画 me_pad）
  const SECT_ART = (k) => (k === "pad" ? "pad/pair" : "me/me_" + k);
  let meSub = null;

  // 健康卡：都好就一行；有问题按人列出来，每条带一个去处理的按钮
  const LABEL = { talk: "说话、接班", diary: "写日记" };
  function healthItems(h) {
    const items = h.device.map((d) => ({ who: "小屋", c: "var(--fg3)", what: d.id === "frozen" ? "后台" : "Shizuku", ...d }));
    for (const r of h.roles) {
      // 说不了话也就写不了日记，只列前一条
      if (r.talk) items.push({ who: rname(r.id), c: rc(r.id), what: LABEL.talk, ...r.talk });
      else if (r.diary) items.push({ who: rname(r.id), c: rc(r.id), what: LABEL.diary, ...r.diary });
    }
    return items;
  }
  function healthHtml(items) {
    if (!items.length) return `<div class="xk-health ok"><img src="${art("health/ok_all")}" alt=""><div><b>三个人都好</b><p>能说话、能接班，今晚也能写日记</p></div></div>`;
    const pic = (items.find((x) => x.art) || {}).art || "quota_low";
    return `<div class="xk-health"><img src="${art("health/" + pic)}" alt=""><div><b>有 ${items.length} 件事要你看一下</b><p>点右边的按钮去处理</p></div></div>
      <div class="xk-list xk-hlist">${items.map((x, i) => `<div class="xk-row"><i class="xk-dot" style="background:${x.c}"></i><span class="k">${esc(x.who)} · ${esc(x.what)}<small>${esc(x.why)}</small></span>${x.fix ? `<button class="xk-mini xk-press" data-fix="${i}">${{ verify: "去验证", sched: "去打开", provider: "去填", role: "去登录", settings: "去看看" }[x.fix.act] || "去看看"}</button>` : ""}</div>`).join("")}</div>`;
  }
  function doFix(f) {
    const c = cc(); SFX.play("tap");
    if (f.act === "verify") return openUrl(f.url);
    if (f.act === "role") return roleSheet(f.id);
    if (f.act === "sched") return c?.openPage("sched");
    if (f.act === "provider") return c?.openPage("settings", "provider");
    if (f.act === "settings") return c?.openPage("settings", f.cat);
  }

  async function renderMe() {
    const b = body("me");
    if (!b.querySelector(".xk-sects")) b.innerHTML = `<div id="xk-hcard"></div><div class="xk-sects">${SECTS.map(([k, t, s]) => `<button class="xk-sect xk-press" data-k="${k}" style="background-image:url('${art(SECT_ART(k))}')"><b>${t}</b><small>${s}</small></button>`).join("")}</div>
      <div class="xk-list" style="margin-top:10px">${meRow("xk-m-help", "怎么用", "聊天、替班、记忆、日记，一页说清")}</div>`;
    b.querySelector(".xk-sects").onclick = (e) => { const s = e.target.closest(".xk-sect"); if (s) openMeSub(s.dataset.k); };
    $("#xk-m-help", b).onclick = () => openMeSub("help");
    const items = healthItems(await api("/api/xk/health"));
    const box = $("#xk-hcard", b); box.innerHTML = healthHtml(items);
    box.querySelectorAll("[data-fix]").forEach((el) => el.onclick = () => doFix(items[+el.dataset.fix].fix));
  }

  // 分区：一层从右边滑进来的页，顶上是这一区的头图；返回键先关它
  function openMeSub(k) {
    closeMeSub(true);
    const [title, head] = k === "help" ? ["怎么用", "help/help_roles"] : [SECTS.find((s) => s[0] === k)[1], SECT_ART(k)];
    const el = document.createElement("section"); el.className = "xk-sub"; el.dataset.k = k;
    el.innerHTML = `<div class="xk-subh" style="background-image:url('${art(head)}')"><button class="xk-back xk-press" aria-label="返回">${svg("back")}</button><h2>${title}</h2></div><div class="xk-subb"></div>`;
    $("#xk-p-me").appendChild(el); void el.offsetWidth; el.classList.add("on"); SFX.play("sheet");
    $(".xk-back", el).onclick = () => closeMeSub();
    meSub = el; SUB[k](el.querySelector(".xk-subb")).catch(fail);
  }
  function closeMeSub(now) {
    const el = meSub; if (!el) return false; meSub = null;
    if (now || !moving()) el.remove(); else { el.classList.remove("on"); setTimeout(() => el.remove(), 320); }
    renderMe().catch(() => {});
    return true;
  }

  const MODE = { auto: "跟随系统", light: "浅色", dark: "深色" };
  const SUB = {
    async account(b) {
      const h = await api("/api/xk/health");
      b.innerHTML = `<div class="xk-list">${(ROLES ? ROLES.order : Object.keys(ROLE)).map((id) => { const t = (h.roles.find((r) => r.id === id) || {}).talk;
        return `<button class="xk-row xk-press" data-id="${id}"><i class="xk-dot" style="background:${rc(id)}"></i><span class="k">${rname(id)}<small>${esc(roleProv(id))}${t ? " · " + esc(t.why) : " · 能用"}</small></span>${svg("go")}</button>`; }).join("")}</div>
        <p class="xk-hint">模型和人设绑在一起：小克用 Claude，哈基米用 Gemini（Antigravity 登录 Google），小鱼用 DeepSeek。在输入栏换成另一家的型号，就是换人。</p>
        <div class="xk-gt">全局</div><div class="xk-list">${meRow("xk-m-prov", "全局默认接口与账户", "只影响不属于她们三个的会话")}</div>`;
      b.querySelectorAll("[data-id]").forEach((x) => x.onclick = () => { SFX.play("tap"); if (x.dataset.id === "hachimi") roleSheet("hachimi"); else cc()?.openPage("settings", "provider"); });
      $("#xk-m-prov", b).onclick = () => { SFX.play("tap"); cc()?.openPage("settings", "provider"); };
    },
    async appearance(b) {
      const mode = String(window.Theme?.pref || "auto").replace(/^(qs|zy|gc|ss)-/, "");
      b.innerHTML = `<div class="xk-gt">深浅</div><div class="xk-list">${["auto", "light", "dark"].map((k) => `<button class="xk-row xk-press" data-mode="${k}"><span class="k">${MODE[k]}</span>${mode === k ? `<span style="color:var(--accent)">${svg("check")}</span>` : ""}</button>`).join("")}</div>
        <p class="xk-hint">浅色像白天的纸，深色像夜里的台灯；颜色跟着正在聊的人走。</p>
        <div class="xk-gt">手感</div><div class="xk-list">${meRow("xk-m-motion", "动效", "关掉后切换不再滑动、铺开", sw(root.dataset.motion !== "off"))}${meRow("xk-m-sound", "音效", "点按、翻页、发送时的轻响", sw(P.sound))}</div>
        <div class="xk-gt">文字</div><div class="xk-list">${meRow("xk-m-font", "字体、字号、语言", "在完整设置里")}</div>`;
      b.querySelectorAll("[data-mode]").forEach((x) => x.onclick = () => { window.Theme?.set(x.dataset.mode); SFX.play("toggle"); SUB.appearance(b); });
      $("#xk-m-motion", b).onclick = () => { document.querySelector(`#seg-motion [data-mo="${root.dataset.motion === "off" ? "on" : "off"}"]`)?.click(); SFX.play("toggle"); setTimeout(() => SUB.appearance(b), 50); };
      $("#xk-m-sound", b).onclick = () => { P.sound = !P.sound; LS.set("sound", P.sound); SFX.play("toggle"); SUB.appearance(b); };
      $("#xk-m-font", b).onclick = () => { SFX.play("tap"); cc()?.openPage("settings", "general"); };
    },
    async notify(b) {
      let st = null; try { st = await api("/api/app/notify_status"); } catch {}
      if (!st || !st.ok) { b.innerHTML = `<p class="xk-hint">通知只有装在手机上的小克才有。</p>`; return; }
      const off = !st.system ? "系统设置里关掉了小克的通知，下面的开关不起作用。" : (st.ask && !st.chAsk) || (st.done && !st.chDone) ? "系统设置里关掉了其中一类通知。" : "";
      b.innerHTML = `<div class="xk-list">${meRow("xk-n-done", "她们回完话时", "小克在后台时才发", sw(st.done))}${meRow("xk-n-ask", "等你确认时", "命令、计划、选择题；允许要回到小克里点", sw(st.ask))}</div>
        ${off ? `<p class="xk-hint xk-warn">${off}</p>` : ""}<div class="xk-list" style="margin-top:12px">${meRow("xk-n-sys", "系统通知设置", "")}</div>`;
      for (const k of ["done", "ask"]) $("#xk-n-" + k, b).onclick = () => { SFX.play("toggle"); api("/api/app/notify_set", { method: "POST", body: { [k]: !st[k] } }).then(() => SUB.notify(b)).catch(fail); };
      $("#xk-n-sys", b).onclick = () => { SFX.play("tap"); api("/api/app/notify_settings", { method: "POST", body: {} }).catch(fail); };
      // 悬浮窗（#32）：离开 App 也看得到她在做什么、网关重启倒数。权限由外壳在打开时带去系统设置，给没给它报回网关
      const ov = await api("/api/xk/overlay");
      const need = ov.enabled && !ov.permitted;
      b.insertAdjacentHTML("beforeend", `<div class="xk-gt">悬浮窗</div><div class="xk-list">${meRow("xk-n-ov", "离开小克时显示悬浮窗", "小圆片 + 顶上一行字：她在做什么、说到哪；网关重启时倒数", sw(ov.enabled))}${ov.enabled ? meRow("xk-n-ovcmd", "字幕里不写命令内容", "只显示「跑命令」；录屏、投屏时别人看不到她跑了什么", sw(ov.hideCmd)) : ""}</div>
        ${need ? `<img class="xk-ovperm" src="${art("overlay/permission")}" alt=""><p class="xk-hint xk-warn">还差一步：在系统设置里允许小克「显示在其他应用的上层」。打开开关时会自动带你过去；没跳过去的话，到系统设置 → 应用 → 小克里找。</p>` : ""}`);
      $("#xk-n-ov", b).onclick = () => { SFX.play("toggle"); api("/api/xk/overlay/config", { method: "PUT", body: { enabled: !ov.enabled } }).then(() => SUB.notify(b)).catch(fail); };
      if (ov.enabled) $("#xk-n-ovcmd", b).onclick = () => { SFX.play("toggle"); api("/api/xk/overlay/config", { method: "PUT", body: { hideCmd: !ov.hideCmd } }).then(() => SUB.notify(b)).catch(fail); };
    },
    async usage(b) {
      const u = await api("/api/xk/usage");
      const n = (x) => (x >= 1e6 ? (x / 1e6).toFixed(1) + "M" : x >= 1e3 ? Math.round(x / 1e3) + "K" : String(x));
      b.innerHTML = (u.off ? `<p class="xk-hint xk-warn">使用统计关着，下面不会涨。到「完整用量」里打开。</p>` : "") +
        `<div class="xk-ustats">${(ROLES ? ROLES.order : Object.keys(ROLE)).map((id) => { const x = u.roles[id] || {};
          return `<div class="xk-ustat" style="--c:${rc(id)}"><img src="${art(ROLE[id].mark)}" alt=""><b>${rname(id)}</b>${id === "hachimi" ? `<p class="xk-hint">Antigravity 不报用量，额度看 Google 账号那边</p>` : `<dl><dt>今天</dt><dd>${n(x.today || 0)}</dd><dt>7 天</dt><dd>${n(x.week || 0)}</dd><dt>30 天</dt><dd>${n(x.month || 0)}</dd></dl>`}</div>`; }).join("")}</div>
        <p class="xk-hint">单位是 token（输入加输出），按会话归到各人头上。</p>
        <div class="xk-list" style="margin-top:12px">${meRow("xk-u-all", "完整用量与月报", "按小时、按型号")}${meRow("xk-u-quota", "额度与余额", "Claude 订阅的额度、DeepSeek 余额")}</div>`;
      $("#xk-u-all", b).onclick = () => { SFX.play("tap"); cc()?.openPage("usage"); };
      $("#xk-u-quota", b).onclick = () => { SFX.play("tap"); cc()?.openPage("settings", "usage"); };
    },
    // 平板（第三步 3a）：开配对 → 平板发来公钥后两边各显示一个 6 位数，一样就点「一致，配对」（gateway/gw/xk-pad.mjs）
    async pad(b) {
      const st = await api("/api/xk/pad");
      const ago = (t) => !t ? "还没连过" : Date.now() - t < 120000 ? "刚刚连着" : new Date(t).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) + " 连过";
      const pend = st.pairing?.pending || [];
      b.innerHTML = `${pend.map((x) => `<div class="xk-padsas"><small>「${esc(x.name)}」想配对，看平板上的数和这个一样吗</small><b>${esc(x.sas)}</b>
          <div><button class="xk-mini xk-press" data-no="${esc(x.id)}">不一样</button><button class="xk-mini xk-press on" data-ok="${esc(x.id)}">一致，配对</button></div></div>`).join("")}
        ${st.pairing && !pend.length ? `<p class="xk-hint">配对开着（${Math.max(0, Math.round((st.pairing.until - Date.now()) / 1000))} 秒内）：在平板上打开「小克 · 平板」点「配对」。两台要连在同一个网里。</p>` : ""}
        <div class="xk-gt">已配对的平板</div>
        <div class="xk-list">${st.devices.length ? st.devices.map((d) => `<div class="xk-row"><span class="k">${esc(d.name)}<small>${ago(d.lastSeen)}</small></span><button class="xk-mini xk-press danger" data-del="${esc(d.id)}">取消配对</button></div>`).join("") : `<div class="xk-row"><span class="k">还没有<small>平板上装「小克 · 平板」（和小克一起发在 Release 里的 xiaoke-pad.apk）</small></span></div>`}</div>
        <button class="xk-wide xk-press" id="xk-pad-pair" style="margin-top:14px">配对新平板</button>
        ${st.back?.text ? `<p class="xk-hint">手机找平板：${esc(st.back.text)}（${new Date(st.back.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}）</p>` : ""}
        <p class="xk-hint">手机开着 VPN 时，要在 VPN 里打开「绕过局域网」（Hiddify：配置选项 → 绕过局域网），不然平板连不上；小克她们照样走 VPN。</p>
        <p class="xk-hint">平板自动找不到手机时，在平板上手动填：${st.addrs.map((a) => `<b>${esc(a)}:${st.port}</b>`).join("、") || "（手机现在没连局域网）"}。一般用第一个。</p>
        <p class="xk-hint">平板只能看群聊、在群里说话、看手机画面；文件、终端、设置都碰不到。通信用配对时那把密钥加密。看手机画面要开着 Shizuku。</p>`;
      $("#xk-pad-pair", b).onclick = () => { SFX.play("tap"); api("/api/xk/pad/pair", { method: "POST", body: {} }).then(() => SUB.pad(b)).catch(fail); };
      b.querySelectorAll("[data-ok]").forEach((x) => x.onclick = () => { SFX.play("done"); api("/api/xk/pad/confirm", { method: "POST", body: { id: x.dataset.ok } }).then(() => { toast("配好了", "平板上会自己连上来", art("pad/pair")); SUB.pad(b); }).catch(fail); });
      b.querySelectorAll("[data-no]").forEach((x) => x.onclick = () => { SFX.play("tap"); toast("没配对", "数不一样就别配：重新开一次配对，在家里的网上再试", null, true); });
      b.querySelectorAll("[data-del]").forEach((x) => x.onclick = () => { SFX.play("toggle"); api("/api/xk/pad/" + x.dataset.del, { method: "DELETE" }).then(() => SUB.pad(b)).catch(fail); });
    },
    async about(b) {
      let feed = null, ver = ""; try { feed = await api("/api/xk/update-feed"); } catch {}
      let app = null; try { app = ((await api("/api/app/upd_status")).items || []).find((i) => i.id === "app") || null; ver = app?.current || ""; } catch {}
      const fresh = app && app.latest && app.latest !== app.current && app.state !== "uptodate";
      b.innerHTML = (fresh ? `<div class="xk-health xk-press" id="xk-a-new" role="button"><img src="${stateArt("update")}" alt=""><div><b>有新版本 ${esc(app.latest)}</b><p>点这里去更新</p></div></div><div style="height:12px"></div>` : "") + `<div class="xk-list">${meRow("xk-a-ver", "版本", "", `<span class="v">${esc(ver || "—")}</span>`)}${meRow("xk-a-upd", "检查更新", "")}${meRow("xk-a-feed", "更新源", feed ? esc(feed.feed) : "")}</div>
        <div class="xk-gt">开源</div><div class="xk-list">${meRow("xk-a-lic", "源代码", "小克基于 cccodroid（Apache-2.0）修改，开源声明在仓库的 NOTICE")}</div>`;
      $("#xk-a-lic", b).onclick = () => { SFX.play("tap"); openUrl("https://github.com/snodgrasssanderfer-source/cccodroid"); };
      $("#xk-a-upd", b).onclick = () => { SFX.play("tap"); cc()?.openPage("settings", "update"); };
      $("#xk-a-new", b)?.addEventListener("click", () => $("#xk-a-upd", b).click());
      $("#xk-a-feed", b).onclick = () => openSheet(`<h2>更新源</h2><p class="sub">GitHub releases API 形状的地址，留空用默认：${esc(feed?.default || "")}</p><textarea id="xk-feed" rows="2" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);padding:10px;font:14px var(--font-ui)">${esc(feed?.feed || "")}</textarea><button class="xk-wide xk-press" id="xk-feed-save">保存</button>`,
        (s) => { $("#xk-feed-save", s).onclick = async () => { try { const r = await api("/api/xk/update-feed", { method: "PUT", body: { feed: $("#xk-feed", s).value.trim() } }); closeSheet(); toast("保存好了", r.feed); SUB.about(b); } catch (e) { fail(e); } }; });
    },
    // 伴侣版帮助（主人 11-02 定的）：上游原版进「开发者 → 帮助（原版）」
    async help(b) {
      const H = [
        ["chat", "聊天、思考与步骤", "消息发给正在聊的那位。她想事情、动手做事的过程会展开给你看，这一轮结束再收成一行，点一下还能翻开。输入框左边的「+」能附文件、拍照、截屏；输入框下的型号可以换，换成另一家的型号就是换人。顶栏右边开新对话，左上角是对话列表，按三个人分组，长按一段能置顶、重命名、导出、删除。"],
        ["roles", "三位住客与替班", "小克用 Claude，哈基米用 Gemini（在她的卡片里登录 Google），小鱼用 DeepSeek。谁的额度用完了，就按角色页的「替班顺序」由下一位接着聊，接班的人会拿到前面几轮的说明；原来那位额度恢复后自动交回，接着原来那段。你手动换的人不会被自动换回去。下班前她们会在角色页的留言板上留张便条，写清事情办到哪了；你也可以贴一张给她们。"],
        ["memory", "记忆", "三个人各记各的，互相看不到；同一个人不管从哪儿聊都是同一套记忆。聊着聊着她自己会记，闲下来会自动整理。记忆页能看、能改、能标成「已过去」、能让她忘掉。"],
        ["diary", "日记", "每晚十点后，三个人各写一篇，素材是当天的对话。小克的日记走定时任务，要在「开发者 → 定时任务」底部打开「订阅账户」才写得了；哪天写不了，日记页和「我的」顶上的健康卡会说原因。想留一份的话，点日记页右上角，可以连纸纹一起存成图片。"],
        ["developer", "开发者", "cccodroid 原本的完整设置、终端、文件、git、扩展、定时任务、项目、脉络和原版帮助，都收在「我的 → 开发者」。平时用不到，出了问题或者想折腾时再去。"],
      ];
      b.innerHTML = H.map(([k, t, p]) => `<section class="xk-help"><img src="${art("help/help_" + k)}" alt=""><h3>${t}</h3><p>${p}</p></section>`).join("");
    },
    async developer(b) {
      const T = [["settings", "完整设置", "cccodroid 原版的全部设置"], ["term", "终端", ""], ["files", "文件", ""], ["git", "git", "当前会话的目录"], ["ext", "组件、插件与 MCP", ""], ["sched", "定时任务", "她们的日记也在这里"], ["projects", "项目", "三个人各是一个项目"], ["lineage", "脉络", ""], ["help", "帮助（原版）", ""]];
      b.innerHTML = `<p class="xk-hint" style="margin-top:0">平时用不到；出了问题、想折腾的时候来这里。</p><div class="xk-list">${T.map(([k, l, s]) => meRow("xk-d-" + k, l, s)).join("")}</div>`;
      b.querySelectorAll(".xk-row").forEach((x) => x.onclick = () => {
        const k = x.id.slice(5), c = cc(); SFX.play("tap");
        if (k === "term") $("#btn-term")?.click(); else if (k === "files") c?.openFiles();
        // git 要给目录：当前会话在哪跑的就开哪（没有会话时是当前角色的目录）（#16）
        else if (k === "git") api("/api/xk/session-role" + (c?.view.sessionId ? "?sid=" + encodeURIComponent(c.view.sessionId) : "")).then((r) => c?.openGit(r.cwd)).catch(fail);
        else c?.openPage(k);
      });
    },
  };
  const RENDER = { roles: renderRoles, mem: renderMem, diary: renderDiary, me: renderMe };

  // ── 聊天室（#35，设计稿第四节）：像 QQ 群。群里每人在她当前那段对话里接着说（网关 xk-room.mjs），这里只是一页看法 ──
  //    头像用悬浮窗那批小圆片（overlay/<人>/bubble_*），群头像、头图、空状态是第十节那 3 张
  const bub = (id, st) => art("overlay/" + (ROLE[id]?.dir || id) + "/bubble_" + st);
  let roomEl = null, roomLast = -1, roomTo = new Set();
  const roomTalking = new Set();
  // 导出长图（#66）：点右上角进多选，点气泡勾上 / 取消，顶上按人一键选，确定后交给 exportRoomImage 画图
  const roomMsgs = new Map(), roomPick = new Set();
  const PICK_WHO = [["all", "全选"], ["owner", "主人"], ["xiaoke", "小克"], ["hachimi", "哈基米"], ["deepseek", "小鱼"]];
  function roomRow(m) {
    if (m.from === "system") return `<div class="xk-rm-sys" data-n="${m.n}">${esc(m.text)}</div>`;
    if (m.from === "owner") return `<div class="xk-rm-me" data-n="${m.n}"><p>${esc(m.text)}</p></div>`;
    return `<div class="xk-rm-her${m.kind === "aside" ? " aside" : ""}" data-n="${m.n}" style="--c:${rc(m.from)}"><button class="xk-rm-av" data-id="${m.from}"><img src="${bub(m.from, "idle")}" alt=""></button><div><b>${rname(m.from)}${m.kind === "aside" ? "<small>插了一句</small>" : ""}</b>${foldBody(m.text)}</div></div>`;
  }
  // 长篇的干活汇报折起来（主人 11-03 定的）：只露第一段（结果），后面点「展开」才看；她们之间递的仍是全文
  const FOLD_AT = 160, CLAMP_AT = 220;
  // 折不折、怎么折：群页（foldBody）和导出长图（roomCanvas）共用这一套判断
  function foldParts(text, fold = true) {
    const t = String(text ?? ""), i = t.indexOf("\n\n");
    const head = i > 0 ? t.slice(0, i) : t, rest = i > 0 ? t.slice(i + 2).trim() : "";
    if (!fold || t.length <= FOLD_AT) return { folded: false, head: t, rest: "" };
    if (!rest && head.length <= CLAMP_AT) return { folded: false, head: t, rest: "" };
    return { folded: true, head, rest };
  }
  function foldBody(text) {
    const f = foldParts(text, true);
    if (!f.folded) return `<p>${esc(f.head)}</p>`;
    const clamp = f.head.length > CLAMP_AT ? " xk-rm-clamp" : "";
    return `<div class="xk-rm-fold"><p class="${clamp.trim()}">${esc(f.head)}${f.rest ? `<span class="xk-rm-rest">\n\n${esc(f.rest)}</span>` : ""}</p><button class="xk-rm-unfold" type="button">展开全文${f.rest ? `（还有 ${f.rest.length} 字）` : ""}</button></div>`;
  }
  function roomPaintMembers(ms) {
    const box = roomEl && $(".xk-rm-mem", roomEl); if (!box) return;
    box.innerHTML = ms.map((m) => { const st = roomTalking.has(m.id) ? "talk" : m.state === "sleep" ? "sleep" : m.state === "talk" ? "talk" : "idle";
      return `<button class="xk-rm-chip xk-press${roomTo.has(m.id) ? " on" : ""}" data-id="${m.id}" style="--c:${rc(m.id)}"><img src="${bub(m.id, st)}" alt=""><span>${rname(m.id)}<small>${st === "sleep" ? "睡着了" : st === "talk" ? "在说…" : "在群里"}</small></span></button>`; }).join("");
  }
  // 群的四种模式（#108）：平时 / 计划 / 目标 / 直播，带一段补充说明；不是平时就在成员下面挂一条
  let roomModes = {}, roomModeNow = { kind: "normal", prompt: "", rounds: 0 };
  function roomModePaint(m) {
    roomModeNow = m || roomModeNow;
    if (!roomEl) return;
    const k = roomModeNow.kind, name = (roomModes[k] || {}).name || k, bar = $(".xk-rm-mode", roomEl);
    $(".xk-rm-modebtn", roomEl).textContent = name;
    $(".xk-rm-modebtn", roomEl).classList.toggle("on", k !== "normal");
    bar.hidden = k === "normal";
    bar.textContent = `${name}模式${roomModeNow.prompt ? "：" + roomModeNow.prompt : ""}${k === "goal" ? ` · 已 ${roomModeNow.rounds || 0} 轮` : ""}`;
  }
  const MODE_TIP = { normal: "闲聊，接话照平时的上限", plan: "只商量不动手：查、读、讨论，小克收成计划等你点头", goal: "给一个目标做到完：点名接话不设上限，小克判断做完了切回平时", live: "直播：一人操作一人旁观，同一时刻一个人出声" };
  function modeSheet() {
    let pick = roomModeNow.kind;
    openSheet(`<h2>群的模式</h2><div class="xk-rm-modes">${Object.entries(roomModes).map(([k, m]) => `<button class="xk-press${k === pick ? " on" : ""}" data-k="${k}"><b>${esc(m.name)}</b><small>${esc(MODE_TIP[k] || "")}</small></button>`).join("")}</div>
      <textarea class="xk-rm-modeprompt" rows="3" placeholder="补充说明：这一轮的目标、要商量的事、今天播什么（平时可以不填）">${pick === "normal" ? "" : esc(roomModeNow.prompt || "")}</textarea>
      <button class="xk-wide xk-press" id="xk-rm-modego">切换</button>`, (s) => {
      $(".xk-rm-modes", s).onclick = (e) => { const b = e.target.closest("[data-k]"); if (!b) return; pick = b.dataset.k; s.querySelectorAll(".xk-rm-modes [data-k]").forEach((x) => x.classList.toggle("on", x === b)); SFX.play("toggle"); };
      $("#xk-rm-modego", s).onclick = async () => {
        try { roomModePaint((await api("/api/xk/room/mode", { method: "POST", body: { kind: pick, prompt: $(".xk-rm-modeprompt", s).value } })).mode); closeSheet(); }
        catch (e) { fail(e); }
      };
    });
  }
  async function roomLoad() {
    const r = await api("/api/xk/room?after=" + roomLast);
    for (const m of r.messages) roomMsg(m, true);
    roomPaintMembers(r.members);
    roomModes = r.modes || roomModes; roomModePaint(r.mode);
    roomScroll();
  }
  function roomScroll() { const l = roomEl && $(".xk-rm-list", roomEl); if (l) l.scrollTop = l.scrollHeight; }
  function roomMsg(m, quiet) {
    if (!roomEl || m.n <= roomLast) { if (!roomEl && m.from !== "owner" && m.from !== "system") $("#xk-room-dot")?.classList.add("on"); return; }
    roomLast = m.n; roomMsgs.set(m.n, m);
    const l = $(".xk-rm-list", roomEl);
    $(".xk-rm-empty", roomEl)?.remove();
    l.insertAdjacentHTML("beforeend", roomRow(m));
    if (!quiet) { roomScroll(); if (m.from !== "owner") SFX.play("receive"); }
  }
  function roomTyping(id, on) {
    if (on) roomTalking.add(id); else roomTalking.delete(id);
    if (!roomEl) return;
    const t = $(".xk-rm-typing", roomEl);
    t.innerHTML = [...roomTalking].map((x) => `<span style="--c:${rc(x)}"><img src="${bub(x, "talk")}" alt="">${rname(x)}在说…</span>`).join("");
    api("/api/xk/room?after=" + roomLast).then((r) => roomPaintMembers(r.members)).catch(() => {});
  }
  async function memberSheet(id) {
    const r = await api("/api/xk/room?after=" + roomLast);
    const m = r.members.find((x) => x.id === id) || {};
    const h = await api("/api/xk/health").catch(() => ({ roles: [] }));
    const talk = (h.roles.find((x) => x.id === id) || {}).talk;
    const u = m.usage, pct = u && u.window ? Math.min(100, Math.round(u.used / u.window * 100)) : null;
    const quota = m.cooldown ? `额度用完了，大约 ${new Date(m.cooldown.until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} 恢复` : talk ? talk.why : "能说话";
    openSheet(`<div style="display:flex;gap:14px;align-items:center"><img src="${bub(id, m.state === "sleep" ? "sleep" : "idle")}" alt="" style="width:72px;height:72px;border-radius:50%;box-shadow:0 0 0 3px ${rc(id)}"><div><h2>${rname(id)}</h2><p class="sub" style="margin:0">${ROLE[id].sub}</p></div></div>
      <div class="xk-gt">她这段对话的上下文</div>
      ${pct != null ? `<div class="xk-rm-bar" style="--c:${rc(id)}"><i style="width:${pct}%"></i></div><p class="xk-hint">用了 ${Math.round(u.used / 1000)}K / ${Math.round(u.window / 1000)}K（${pct}%），是她这段对话最近一轮的数（私聊、群里都算）</p>` : `<p class="xk-hint">${id === "hachimi" ? "哈基米走 Antigravity，拿不到上下文占用" : "她这段对话还没跑过一轮，说过一句就有数了"}</p>`}
      <div class="xk-gt">额度</div><p class="xk-hint">${esc(quota)}</p>
      <button class="xk-wide xk-press" id="xk-rm-dm">和她私聊</button>`, (s) => {
      $("#xk-rm-dm", s).onclick = () => { closeSheet(); closeRoom(); if (id !== cur.role) setTimeout(() => switchRole(id).catch(fail), 380); };
    });
  }
  function openRoom() {
    if (roomEl) return;
    $("#xk-room-dot")?.classList.remove("on");
    roomEl = document.createElement("section"); roomEl.id = "xk-room"; roomEl.setAttribute("aria-label", "我们仨的群");
    roomEl.innerHTML = `<div class="xk-subh xk-rm-h" style="background-image:url('${art("room/room_header")}')"><button class="xk-back xk-press" aria-label="返回">${svg("back")}</button><h2>我们仨</h2><button class="xk-rm-exp xk-press" aria-label="导出长图">${svg("export")}</button></div>
      <div class="xk-rm-mem"></div>
      <button class="xk-rm-mode xk-press" hidden></button>
      <div class="xk-rm-pickwho">${PICK_WHO.map(([id, n]) => `<button class="xk-press" data-who="${id}"${id === "all" ? "" : ` style="--c:${id === "owner" ? "var(--accent)" : rc(id)}"`}>${n}</button>`).join("")}</div>
      <div class="xk-rm-list"><div class="xk-rm-empty"><img src="${art("room/room_empty")}" alt=""><p>三个人都在，等你开口。点上面的头像可以只叫她接话。</p></div></div>
      <div class="xk-rm-typing"></div>
      <div class="xk-rm-pickbar"><button class="xk-press xk-rm-pick-no">取消</button><span></span><button class="xk-press xk-rm-pick-go">生成长图</button></div>
      <form class="xk-rm-in"><button type="button" class="xk-rm-modebtn xk-press" aria-label="切换群的模式">平时</button><textarea rows="1" placeholder="在群里说点什么…" enterkeyhint="send"></textarea><button class="xk-press" aria-label="发送">${svg("go")}</button></form>`;
    document.body.appendChild(roomEl); void roomEl.offsetWidth; roomEl.classList.add("on"); SFX.play("sheet");
    roomLast = -1; roomTo = new Set(); roomMsgs.clear(); roomPick.clear();
    $(".xk-back", roomEl).onclick = () => { if (!pickOff()) closeRoom(); };
    $(".xk-rm-exp", roomEl).onclick = () => pickOn();
    $(".xk-rm-modebtn", roomEl).onclick = () => modeSheet();
    $(".xk-rm-mode", roomEl).onclick = () => modeSheet();
    $(".xk-rm-pick-no", roomEl).onclick = () => pickOff();
    $(".xk-rm-pick-go", roomEl).onclick = () => {
      const list = [...roomPick].sort((a, b) => a - b).map((n) => roomMsgs.get(n)).filter(Boolean);
      if (!list.length) return toast("还没勾消息", "点气泡勾上，或者用上面按人选");
      pickOff();
      exportRoomImage(list).catch(fail);
    };
    $(".xk-rm-pickwho", roomEl).onclick = (e) => {
      const b = e.target.closest("[data-who]"); if (!b) return;
      const who = b.dataset.who, ns = [...roomMsgs.values()].filter((m) => who === "all" || m.from === who).map((m) => m.n);
      const all = ns.length && ns.every((n) => roomPick.has(n));
      for (const n of ns) all ? roomPick.delete(n) : roomPick.add(n);
      SFX.play("toggle"); pickPaint();
    };
    // 点上面的头像：只叫她（再点取消，可以叫好几个）；长按看她的上下文和额度
    $(".xk-rm-mem", roomEl).onclick = (e) => { const c = e.target.closest("[data-id]"); if (!c) return; const id = c.dataset.id; roomTo.has(id) ? roomTo.delete(id) : roomTo.add(id); c.classList.toggle("on"); SFX.play("toggle"); };
    $(".xk-rm-mem", roomEl).oncontextmenu = (e) => { const c = e.target.closest("[data-id]"); if (!c) return; e.preventDefault(); memberSheet(c.dataset.id).catch(fail); };
    $(".xk-rm-list", roomEl).onclick = (e) => {
      if (roomEl.classList.contains("pick")) {
        const r = e.target.closest("[data-n]"); if (!r) return;
        const n = +r.dataset.n; roomPick.has(n) ? roomPick.delete(n) : roomPick.add(n);
        SFX.play("toggle"); pickPaint(); return;
      }
      const u = e.target.closest(".xk-rm-unfold");
      if (u) { const f = u.parentElement, open = f.classList.toggle("open"); u.dataset.t ||= u.textContent; u.textContent = open ? "收起" : u.dataset.t; return; }
      const a = e.target.closest(".xk-rm-av"); if (a) memberSheet(a.dataset.id).catch(fail);
    };
    const ta = $("textarea", roomEl), form = $(".xk-rm-in", roomEl);
    ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 120) + "px"; };
    ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = ta.value.trim(); if (!text) return;
      ta.value = ""; ta.oninput(); SFX.play("send");
      try { await api("/api/xk/room", { method: "POST", body: { text, to: [...roomTo] } }); roomTo.clear(); roomEl?.querySelectorAll(".xk-rm-chip.on").forEach((c) => c.classList.remove("on")); }
      catch (err) { ta.value = text; fail(err); }
    };
    roomLoad().catch(fail);
    roomTyping(null, false);
  }
  function pickOn() {
    if (!roomEl || !roomMsgs.size) return toast("群里还没有消息", "说过几句再来导出");
    roomPick.clear(); roomEl.classList.add("pick"); SFX.play("toggle"); pickPaint();
  }
  function pickOff() {
    if (!roomEl || !roomEl.classList.contains("pick")) return false;
    roomEl.classList.remove("pick"); roomPick.clear(); pickPaint(); return true;
  }
  function pickPaint() {
    if (!roomEl) return;
    roomEl.querySelectorAll(".xk-rm-list [data-n]").forEach((r) => r.classList.toggle("picked", roomPick.has(+r.dataset.n)));
    roomEl.querySelectorAll(".xk-rm-pickwho [data-who]").forEach((b) => {
      const ns = [...roomMsgs.values()].filter((m) => b.dataset.who === "all" || m.from === b.dataset.who).map((m) => m.n);
      b.classList.toggle("on", !!ns.length && ns.every((n) => roomPick.has(n)));
      b.disabled = !ns.length;
    });
    const t = $(".xk-rm-pickbar span", roomEl); if (t) t.textContent = `已选 ${roomPick.size} 条`;
  }
  function closeRoom() {
    const el = roomEl; if (!el) return false; roomEl = null;
    el.classList.remove("on"); setTimeout(() => el.remove(), moving() ? 380 : 0);
    return true;
  }

  // ── 返回键：外壳调 window.__ccBack()，返回 false 就把 App 退到后台。我们的卡片和四页也登记进去（#12）：
  //    先关我们的卡片 → 再让上游关它的浮层（整页、设置、侧栏……一层层退）→ 不在聊天页就回聊天页 → 都没有才退到后台
  const upBack = window.__ccBack;
  window.__ccBack = function () {
    try {
      if (obEl) { if (obI) obTo(obI - 1); else obDone(); return true; }
      if (sheet.classList.contains("on")) { closeSheet(); return true; }
      if (roomEl) { if (!pickOff()) closeRoom(); return true; }
      if (tab === 4 && !root.classList.contains("xk-cover") && closeMeSub()) return true;
      if (typeof upBack === "function" && upBack()) return true;
      if (tab !== 0) { go(0); return true; }
    } catch (e) { console.error("[xk] back", e); }
    return false;
  };

  // 空对话下的「使用提示」开伴侣版帮助，不开上游原版
  document.addEventListener("click", (e) => {
    if (!e.target.closest(".wl-tips")) return;
    e.stopPropagation(); e.preventDefault();
    go(4); setTimeout(() => openMeSub("help"), 60);
  }, true);

  // 普通按钮也给一声轻响（我们自己的部件各有各的声，不重复）
  document.addEventListener("click", (e) => {
    if (e.target.closest("#xk-tabs, #xk-sheet, .xk-page, #xk-face, #xk-new")) return;
    if (e.target.closest("#btn-send")) return;
    if (e.target.closest("button, .btn, summary, [role=button]")) SFX.play("tap");
  }, true);

  // ── 服务商按角色显示（#11，主人 11-02 定的）：上游只有一个「全局在用」，我们三个人各绑一家。
  //    侧栏账户行写当前角色用的那家；设置 → 接口与型号的「当前在用」改成「全局默认」，下面说明三个人各用各的
  const PROV_LABEL = { anthropic: "Claude", deepseek: "DeepSeek" };
  const roleProv = (id) => (id === "hachimi" ? "Gemini · Antigravity" : PROV_LABEL[(R(id) || {}).provider] || (R(id) || {}).provider || "");
  function paintProv() {
    // 空对话的接入指引说「☰ → 设置 → 接口」：侧栏已经只剩对话，改成现在的去处
    const tip = [...document.querySelectorAll(".setup-guide .tiny")].find((x) => x.textContent.includes("☰"));
    if (tip) tip.textContent = "两条路都在「我的 → 账号与接口」，以后随时能换。";
    const id = cur.role || root.dataset.xkRole || "xiaoke";
    const sub = $("#acct-sub"), want = roleProv(id);
    if (sub && want && sub.textContent !== want) sub.textContent = want;
    const info = $("#provider-info");
    if (info && info.textContent.startsWith("当前在用：")) info.textContent = info.textContent.replace("当前在用：", "全局默认：");
    if (info && !$("#xk-prov-note")) {
      const n = document.createElement("p"); n.id = "xk-prov-note"; n.className = "xk-hint";
      n.textContent = "三个人各用各的：小克用 Claude，哈基米用 Gemini（Antigravity），小鱼用 DeepSeek。这里是全局默认，只影响不属于她们的会话。";
      info.after(n);
    }
  }
  // 流式输出时 DOM 每秒变很多次：合并到下一帧再看一次，别每次变动都查
  let provQ = 0;
  new MutationObserver(() => { if (!provQ) provQ = requestAnimationFrame(() => { provQ = 0; paintProv(); }); }).observe(document.body, { subtree: true, childList: true, characterData: true });

  // ── 键盘弹起时让路（#14，主人 11-02 定的：平时一直摆着，只在键盘弹起这段时间让）：
  //    收起底栏和输入框上方的小人，输入框下那行合成一行（放不下就横着滑）
  const vv = window.visualViewport;
  if (vv) {
    let base = 0;
    const kb = () => { base = Math.max(base, vv.height); const up = base - vv.height > 150; if (root.classList.contains("xk-kb") !== up) { root.classList.toggle("xk-kb", up); movePill(); } };
    vv.addEventListener("resize", kb);
    addEventListener("orientationchange", () => { base = 0; setTimeout(kb, 400); });
    kb();
  }

  // ── 侧栏只留对话，按三个人分组（主人 11-02 定的）：导航、新对话、账户行和底栏 / 顶栏 / 我的重复，藏掉（CSS）。
  //    上游每次重画最近对话，这里接着按会话目录归到三个人名下重画一遍；条目沿用上游的 .sr-item[data-sid]，
  //    点开、长按菜单还是上游自己的委托处理；分组标题用上游的折叠（data-sgfold，记在 cc.sideFold）
  const SIDE_MAX = 30;
  const roleOfCwd = (cwd) => { const m = /\/roles\/(xiaoke|hachimi|deepseek)(\/|$)/.exec(cwd || ""); return m ? m[1] : ""; };
  // 自动起名只剩标点、空白的（主人发一个「。」试反应），换成时间（#16 第 6 条）
  const sideTitle = (x) => (/[\p{L}\p{N}]/u.test(x.title || "") ? x.title : ((d) => `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")} 的对话`)(new Date(x.mtime)));
  function paintSide() {
    const box = $("#side-recent"), c = cc();
    if (!box || !c || box.firstElementChild?.classList.contains("xk-side")) return;
    const list = (c.state.sessions || []).filter((x) => !x.misc || x.id === c.view.sessionId);
    if (!list.length) return;
    const runs = c.srv.runs || [], live = new Set(runs.filter((x) => !x.idle).map((x) => x.sessionId)), ask = new Set(runs.filter((x) => x.perms && x.perms.length).map((x) => x.sessionId));
    let shut = new Set(); try { shut = new Set(JSON.parse(localStorage.getItem("cc.sideFold") || "[]")); } catch {}
    const ids = [...(ROLES ? ROLES.order : Object.keys(ROLE)), ""];
    const row = (x) => `<button class="sr-item${x.id === c.view.sessionId ? " on" : ""}" data-sid="${esc(x.id)}" title="${esc(x.title)}">${ask.has(x.id) ? '<i class="sr-dot ask"></i>' : live.has(x.id) ? '<i class="sr-dot"></i>' : ""}<span>${x.pinned ? '<small class="xk-pin">置顶</small>' : ""}${esc(sideTitle(x))}</span></button>`;
    box.innerHTML = `<div class="xk-side"></div><button class="xk-room-row" id="xk-room-row"><img src="${art("room/room_avatar")}" alt=""><span>我们仨<small>三个人都在的群</small></span><i id="xk-room-dot"></i></button>` + ids.map((id) => {
      const l = list.filter((x) => roleOfCwd(x.cwd) === id).sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || b.mtime - a.mtime);
      if (!l.length) return "";
      const k = "xk-" + (id || "other"), s = shut.has(k);
      return `<h4 class="sr-g xk-sg${s ? " shut" : ""}" data-sgfold="${k}" role="button" aria-expanded="${!s}" style="--c:${id ? rc(id) : "var(--fg3)"}"><svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>${id ? `<img src="${art(ROLE[id].mark)}" alt="">` : ""}<span>${id ? rname(id) : "其他"}</span>${s ? `<em>${l.length}</em>` : ""}</h4>`
        + (s ? "" : l.slice(0, SIDE_MAX).map(row).join("") + (l.length > SIDE_MAX ? '<button class="sr-all" data-all>全部对话</button>' : ""));
    }).join("") + `<div class="sr-hint">长按一段对话：置顶、重命名、导出、删除</div>`;
    // 侧栏先退（上游的返回会一层层关，这时最上面是侧栏），再开群
    $("#xk-room-row", box).onclick = () => { upBack?.(); openRoom(); };
  }
  let sideQ = 0;
  const sideObs = () => { const box = $("#side-recent"); if (!box) return setTimeout(sideObs, 500); new MutationObserver(() => { if (!sideQ) sideQ = requestAnimationFrame(() => { sideQ = 0; paintSide(); }); }).observe(box, { childList: true }); paintSide(); };
  sideObs();

  // ── 第一次打开的引导（第 2 版美术 onboard/）：五页，能左右滑、能跳过；看过一次就不再出（记在本机）──
  const OB = [
    ["1_welcome", "欢迎回家", "这是小克的小屋。你说的话、交给她的事，她都接着。"],
    ["2_trio", "三位住客", "小克、哈基米、小鱼，各有各的脾气，也各用各的模型。「角色」页能看她们、换人。"],
    ["3_handover", "谁累了谁歇着", "谁的额度用完了就睡一会儿，下一位接着陪你；她醒了再接回来，话题不断。"],
    ["4_memory", "记得你说过的", "三个人各记各的，每晚还会写一篇日记。「记忆」「日记」两页随时翻。"],
    ["5_stay", "让她们留在后台", "系统会把后台的小克冻住，夜里的日记、闲时的整理就停了。请在系统设置里允许小克在后台运行、不做电池优化。"],
  ];
  let obEl = null, obI = 0;
  function onboard() {
    if (obEl) return;
    obEl = document.createElement("div"); obEl.id = "xk-ob"; obEl.setAttribute("role", "dialog"); obEl.setAttribute("aria-label", "引导");
    obEl.innerHTML = `<button class="xk-ob-skip">跳过</button><div class="xk-ob-track">${OB.map(([k, t, p]) => `<section><div class="xk-ob-tx"><h2>${t}</h2><p>${p}</p></div><img src="${art("onboard/onboard_" + k)}" alt=""></section>`).join("")}</div>
      <div class="xk-ob-foot"><div class="xk-ob-dots">${OB.map(() => "<i></i>").join("")}</div><div class="xk-ob-btns"><button class="xk-ob-alt">进去吧</button><button class="xk-ob-go xk-press">下一步</button></div></div>`;
    document.body.appendChild(obEl);
    $(".xk-ob-skip", obEl).onclick = obDone;
    $(".xk-ob-alt", obEl).onclick = obDone;
    $(".xk-ob-go", obEl).onclick = () => {
      if (obI < OB.length - 1) return obTo(obI + 1);
      api("/api/app/open_app_settings", { method: "POST", body: {} }).catch(fail); obDone();
    };
    let x0 = null;
    obEl.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    obEl.addEventListener("touchend", (e) => { if (x0 == null) return; const dx = e.changedTouches[0].clientX - x0; x0 = null; if (Math.abs(dx) > 50) obTo(obI + (dx < 0 ? 1 : -1)); });
    requestAnimationFrame(() => { obEl.classList.add("on"); obTo(0); });
  }
  function obTo(i) {
    obI = Math.max(0, Math.min(OB.length - 1, i));
    $(".xk-ob-track", obEl).style.transform = `translateX(${-obI * 100}%)`;
    obEl.querySelectorAll(".xk-ob-dots i").forEach((d, k) => d.classList.toggle("on", k === obI));
    const last = obI === OB.length - 1;
    $(".xk-ob-go", obEl).textContent = last ? "去允许后台运行" : "下一步";
    $(".xk-ob-alt", obEl).classList.toggle("on", last);
    SFX.play("tab");
  }
  function obDone() {
    LS.set("onboarded", true);
    const el = obEl; obEl = null; if (!el) return;
    el.classList.remove("on"); setTimeout(() => el.remove(), moving() ? 400 : 0);
  }

  // ── 启动：等上游的顶栏和 __cc 就绪 ──
  // 刷新时先按上次的角色上色，等 syncRole 查到当前会话再纠正；别先画成小克再跳（会像「试图切到小克」）
  applyRole(LS.get("role", "xiaoke"), false);
  (function boot() {
    if (!mountHead() || !window.__cc) return setTimeout(boot, 300);
    movePill(); syncRole(true).catch(() => {});
    if (!LS.get("onboarded", false)) onboard();
    loadBoard().catch(() => {});
  })();
  window.XK = { api, toast, go, switchRole, applyRole, SFX, petals, openRoom, roomCanvas, exportRoomImage };
})();
