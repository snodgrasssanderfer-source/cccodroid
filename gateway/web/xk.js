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
    const set = () => { root.dataset.xkRole = id; paintHead(); paintShell(); };
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
  const fail = (e) => toast("没成功", e.message || String(e), null, true);
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

  /** 手动换角色：开一个新会话落到那个角色，第一条消息带上刚才那段对话（网关 /api/xk/switch）；
   *  从接班会话换回原角色时网关给 resume，打开她原来那段接着聊（#1） */
  async function switchRole(id) {
    const cc = window.__cc, from = cc.view.sessionId || null;
    const r = await api("/api/xk/switch", { method: "POST", body: { to: id, fromSessionId: from } });
    cur.sid = undefined; cur.role = id; cur.origin = null;
    if (r.resume) cc.openSession(r.resume);
    else { cc.newConversation(); cc.view.projectId = r.projectId; }
    await loadRoles();
    applyRole(id, true);
    toast(r.resume ? `换回${rname(id)}了` : `换成${rname(id)}了`, r.resume ? "接着你们原来那段，下一条会带上她不在时聊的" : from ? "下一条消息会带上刚才的对话" : "", sprite(id, "wave"));
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
      if (!live) document.querySelectorAll("#chat details.think[data-xk]").forEach((d) => { d.open = false; });
    }
  }

  // ── 网关事件：接班提示、出错、运行状态 ──
  const follow = new Map();   // run 号 → 新会话一拿到会话号就打开（只在主人正看着被接班的那个会话时）
  (function listen() {
    const es = new EventSource("/api/events");
    es.onmessage = (m) => {
      let ev; try { ev = JSON.parse(m.data); } catch { return; }
      if (ev.type === "xk") {
        if (ev.op === "handover") {
          const pic = ev.from === "xiaoke" && ev.to === "hachimi" ? art("group/handover_1") : ev.from === "hachimi" && ev.to === "deepseek" ? art("group/handover_2") : sprite(ev.to, "wave");
          SFX.play("sleep"); peek("sleeping");
          toast(ev.back ? `${rname(ev.to)}回来了` : `${rname(ev.to)}来接班`, ev.reason, pic);
          const now = window.__cc && window.__cc.view.sessionId;
          if (!ev.fromSession || ev.fromSession === now) follow.set(ev.runId, true);
          loadRoles().then(() => { paintHead(); if ($("#xk-p-roles.on")) renderRoles(); }).catch(() => {});
        } else if (ev.op === "handover_none") { peek("sleeping"); toast(`${rname(ev.from)}睡着了`, ev.reason, sprite(ev.from, "sleeping"), true); }
        else if (ev.op === "memory_failed") toast(`${rname(ev.role)}整理记忆没成功`, ev.error, null, true);
        else if (ev.op === "diary") toast("日记", ev.text, art("xiaoke/10_diary"), !!ev.error);
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
  setInterval(() => { const c = !!document.querySelector(COVER); if (root.classList.contains("xk-cover") !== c) root.classList.toggle("xk-cover", c); }, 300);

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

  // ── 角色页 ──
  function roleState(id) { return asleep(id) ? "睡着了" : id === cur.role ? "在聊" : "替班"; }
  async function renderRoles() {
    await loadRoles();
    const b = body("roles"), order = ROLES.order.filter((id) => ROLE[id]);
    b.innerHTML = `<div class="xk-cards">${order.map((id) => `<button class="xk-card xk-press${id === cur.role ? " on" : ""}" data-id="${id}" style="--c:var(--xk-c-${id === "deepseek" ? "xiaoyu" : id});--s:var(--xk-s-${id === "deepseek" ? "xiaoyu" : id})"><img src="${sprite(id, asleep(id) ? "sleeping" : "idle")}" alt=""><b>${rname(id)}</b><span class="xk-tag">${roleState(id)}</span></button>`).join("")}</div>
      <div class="xk-block"><h2>替班顺序</h2><div class="xk-order">${order.map((id, i) => `${i ? `<button class="xk-swap xk-press" data-i="${i}" aria-label="交换顺序">${svg("swap")}</button>` : ""}<div class="o"><i style="background-image:url('${sprite(id, "idle")}')"></i><span>${rname(id)}</span></div>`).join("")}</div>
        <p class="xk-hint">谁的额度用完，就由下一位接班，只带上刚才那段对话；额度恢复后交还。点中间的箭头换顺序。</p></div>
      <div class="xk-block"><h2>导入人设与世界书</h2><p class="xk-hint" style="margin:0 0 10px">一次可以选好几个文件，txt、md、SillyTavern 的 JSON 都行。按文件名猜它是谁的人设、还是世界书，导入前可以改。世界书三个人共用，每一轮都会读到。</p>
        <label class="xk-mini xk-press">选文件导入<input type="file" multiple id="xk-imp"></label></div>`;
    b.querySelectorAll(".xk-card").forEach((c) => c.onclick = () => { SFX.play("tap"); roleSheet(c.dataset.id); });
    b.querySelectorAll(".xk-swap").forEach((x) => x.onclick = async () => {
      const i = +x.dataset.i, o = order.slice(); [o[i - 1], o[i]] = [o[i], o[i - 1]];
      try { await api("/api/xk/order", { method: "PUT", body: { order: o } }); SFX.play("toggle"); renderRoles(); } catch (e) { fail(e); }
    });
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
      <button class="xk-wide xk-press" id="xk-talk"${z ? " disabled" : ""}>${z ? "她睡着了" : id === cur.role ? "回去聊天" : `换${rname(id)}来聊（开新会话）`}</button>`, (s) => {
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
  function memGroup(d) {
    // 按本地日期：toISOString 是 UTC，每天 0–8 点「今天 / 昨天」会错一天（#16）
    const day = (x) => { const d = new Date(Date.now() - x * 864e5); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
    return d === day(0) ? "今天" : d === day(1) ? "昨天" : d >= day(7) ? "这一周" : d.slice(0, 7).replace("-", " 年 ") + " 月";
  }
  function drawMem() {
    const box = $("#xk-ml"); if (!box) return;
    const q = ($("#xk-mq")?.value || "").trim();
    const list = memItems.filter((m) => !q || m.text.includes(q) || (m.who || "").includes(q)).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    if (!list.length) { box.innerHTML = `<div class="xk-empty"><img src="${art(memRole === "xiaoke" ? "xiaoke/11_memory" : "deco/empty_memory")}" alt="">${q ? "没找到相关的记忆" : `${rname(memRole)}还没有记忆<br>聊过的事停下 10 分钟后，她会自己整理进来`}</div>`; return; }
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
          if (b.dataset.a === "past") { await api(url, { method: "PATCH", body: { past: !m.past, until: m.past ? "" : new Date().toISOString().slice(0, 10) } }); m.past = !m.past; SFX.play("toggle"); drawMem(); }
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
    days.onclick = (e) => { const b = e.target.closest(".xk-day"); if (!b || b.dataset.d === diaryDay) return; diaryDay = b.dataset.d; days.querySelectorAll(".xk-day").forEach((x) => x.classList.toggle("on", x === b)); SFX.play("tab"); drawLeaf(true); };
    requestAnimationFrame(() => days.querySelector(".on")?.scrollIntoView({ inline: "center", block: "nearest" }));
    // 日记写不写得了按真实状态说（#15）：被挡住就写原因、给去处理的按钮
    let blk = null; try { const h = await api("/api/xk/health"); const r0 = h.roles.find((x) => x.id === diaryRole); blk = r0 && r0.diary; } catch {}
    const leaf = $("#xk-leaf");
    leaf.dataset.r = ROLE[diaryRole].dir || diaryRole;
    leaf.dataset.note = blk ? "现在写不了：" + blk.why : r.pending?.length ? "素材攒着呢，今晚十点后写第一篇" : "每晚十点后，她会根据当天的聊天写一篇";
    diaryFix = blk && blk.fix;
    $("#xk-dwarn")?.remove();
    if (blk && diaryDays.length) days.insertAdjacentHTML("afterend", `<p class="xk-hint xk-warn" id="xk-dwarn">${esc(rname(diaryRole))}今晚写不了：${esc(blk.why)}</p>`);
    drawLeaf(flip);
  }
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
    const put = () => { leaf.innerHTML = html; leaf.classList.toggle("blank", !diaryDay); const f = $("#xk-dfix", leaf); if (f) f.onclick = () => doFix(diaryFix); };
    if (flip && moving()) { leaf.classList.remove("flip"); void leaf.offsetWidth; leaf.classList.add("flip"); setTimeout(put, 250); }
    else put();
  }

  // ── 我的页（主人 11-02 定的：伴侣设置；上游整套设置和工具收进「开发者」）──
  //    顶上三人健康卡（#15），下面六个分区，点开从右边滑进来一层
  const cc = () => window.__cc;
  const rc = (id) => `var(--xk-c-${id === "deepseek" ? "xiaoyu" : id})`;
  const meRow = (id, k, sub, right) => `<button class="xk-row xk-press" id="${id}"><span class="k">${k}${sub ? `<small>${sub}</small>` : ""}</span>${right ?? svg("go")}</button>`;
  const sw = (on) => `<span class="xk-sw${on ? " on" : ""}"></span>`;
  const SECTS = [["account", "账号与接口", "她们各用各的那家"], ["appearance", "外观", "深浅、动效、音效"], ["notify", "通知", "跑完和等你确认时提醒"],
    ["usage", "用量", "三个人各花了多少"], ["about", "关于", "版本、更新、开源声明"], ["developer", "开发者", "cccodroid 原本的设置和工具"]];
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
    if (!b.querySelector(".xk-sects")) b.innerHTML = `<div id="xk-hcard"></div><div class="xk-sects">${SECTS.map(([k, t, s]) => `<button class="xk-sect xk-press" data-k="${k}" style="background-image:url('${art("me/me_" + k)}')"><b>${t}</b><small>${s}</small></button>`).join("")}</div>`;
    b.querySelector(".xk-sects").onclick = (e) => { const s = e.target.closest(".xk-sect"); if (s) openMeSub(s.dataset.k); };
    const items = healthItems(await api("/api/xk/health"));
    const box = $("#xk-hcard", b); box.innerHTML = healthHtml(items);
    box.querySelectorAll("[data-fix]").forEach((el) => el.onclick = () => doFix(items[+el.dataset.fix].fix));
  }

  // 分区：一层从右边滑进来的页，顶上是这一区的头图；返回键先关它
  function openMeSub(k) {
    closeMeSub(true);
    const [, title] = SECTS.find((s) => s[0] === k);
    const el = document.createElement("section"); el.className = "xk-sub"; el.dataset.k = k;
    el.innerHTML = `<div class="xk-subh" style="background-image:url('${art("me/me_" + k)}')"><button class="xk-back xk-press" aria-label="返回">${svg("back")}</button><h2>${title}</h2></div><div class="xk-subb"></div>`;
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
    async about(b) {
      let feed = null, ver = ""; try { feed = await api("/api/xk/update-feed"); } catch {}
      try { ver = ((await api("/api/app/upd_status")).items || []).find((i) => i.id === "app")?.current || ""; } catch {}
      b.innerHTML = `<div class="xk-list">${meRow("xk-a-ver", "版本", "", `<span class="v">${esc(ver || "—")}</span>`)}${meRow("xk-a-upd", "检查更新", "")}${meRow("xk-a-feed", "更新源", feed ? esc(feed.feed) : "")}</div>
        <div class="xk-gt">开源</div><div class="xk-list">${meRow("xk-a-lic", "源代码", "小克基于 cccodroid（Apache-2.0）修改，开源声明在仓库的 NOTICE")}</div>`;
      $("#xk-a-lic", b).onclick = () => { SFX.play("tap"); openUrl("https://github.com/snodgrasssanderfer-source/cccodroid"); };
      $("#xk-a-upd", b).onclick = () => { SFX.play("tap"); cc()?.openPage("settings", "update"); };
      $("#xk-a-feed", b).onclick = () => openSheet(`<h2>更新源</h2><p class="sub">GitHub releases API 形状的地址，留空用默认：${esc(feed?.default || "")}</p><textarea id="xk-feed" rows="2" style="width:100%;box-sizing:border-box;border:1px solid var(--line);border-radius:12px;background:var(--bg);color:var(--fg);padding:10px;font:14px var(--font-ui)">${esc(feed?.feed || "")}</textarea><button class="xk-wide xk-press" id="xk-feed-save">保存</button>`,
        (s) => { $("#xk-feed-save", s).onclick = async () => { try { const r = await api("/api/xk/update-feed", { method: "PUT", body: { feed: $("#xk-feed", s).value.trim() } }); closeSheet(); toast("保存好了", r.feed); SUB.about(b); } catch (e) { fail(e); } }; });
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

  // ── 返回键：外壳调 window.__ccBack()，返回 false 就把 App 退到后台。我们的卡片和四页也登记进去（#12）：
  //    先关我们的卡片 → 再让上游关它的浮层（整页、设置、侧栏……一层层退）→ 不在聊天页就回聊天页 → 都没有才退到后台
  const upBack = window.__ccBack;
  window.__ccBack = function () {
    try {
      if (sheet.classList.contains("on")) { closeSheet(); return true; }
      if (tab === 4 && !root.classList.contains("xk-cover") && closeMeSub()) return true;
      if (typeof upBack === "function" && upBack()) return true;
      if (tab !== 0) { go(0); return true; }
    } catch (e) { console.error("[xk] back", e); }
    return false;
  };

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
    box.innerHTML = `<div class="xk-side"></div>` + ids.map((id) => {
      const l = list.filter((x) => roleOfCwd(x.cwd) === id).sort((a, b) => (b.pinned || 0) - (a.pinned || 0) || b.mtime - a.mtime);
      if (!l.length) return "";
      const k = "xk-" + (id || "other"), s = shut.has(k);
      return `<h4 class="sr-g xk-sg${s ? " shut" : ""}" data-sgfold="${k}" role="button" aria-expanded="${!s}" style="--c:${id ? rc(id) : "var(--fg3)"}"><svg viewBox="0 0 24 24"><path d="M8 10l4 4 4-4"/></svg>${id ? `<img src="${art(ROLE[id].mark)}" alt="">` : ""}<span>${id ? rname(id) : "其他"}</span>${s ? `<em>${l.length}</em>` : ""}</h4>`
        + (s ? "" : l.slice(0, SIDE_MAX).map(row).join("") + (l.length > SIDE_MAX ? '<button class="sr-all" data-all>全部对话</button>' : ""));
    }).join("") + `<div class="sr-hint">长按一段对话：置顶、重命名、导出、删除</div>`;
  }
  let sideQ = 0;
  const sideObs = () => { const box = $("#side-recent"); if (!box) return setTimeout(sideObs, 500); new MutationObserver(() => { if (!sideQ) sideQ = requestAnimationFrame(() => { sideQ = 0; paintSide(); }); }).observe(box, { childList: true }); paintSide(); };
  sideObs();

  // ── 启动：等上游的顶栏和 __cc 就绪 ──
  applyRole("xiaoke", false);
  (function boot() {
    if (!mountHead() || !window.__cc) return setTimeout(boot, 300);
    movePill(); syncRole(true).catch(() => {});
  })();
  window.XK = { api, toast, go, switchRole, applyRole, SFX, petals };
})();
