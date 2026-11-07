// 小克 · 平板的聊天页：只管画。找手机、配对、加密请求都在 Java（window.Pad，见 PadActivity.Bridge），
// 群聊接口和手机上的一样（gateway/gw/xk-room.mjs），经手机网关的加密口子转过去（只放行聊天要用的几个）。
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ROLE = { xiaoke: { name: "小克", dir: "xiaoke", c: "var(--xiaoke)" }, hachimi: { name: "哈基米", dir: "hachimi", c: "var(--hachimi)" }, deepseek: { name: "小鱼", dir: "xiaoyu", c: "var(--xiaoyu)" } };
  const bub = (id, st) => `art/overlay/${ROLE[id]?.dir || id}/bubble_${st}.webp`;

  // ── 加密请求：Java 那边异步，回调按号对上 ──
  let seq = 0;
  const waiting = new Map();
  window.padReply = (id, r) => { const w = waiting.get(id); waiting.delete(id); if (w) w(r); };
  function call(method, path, body) {
    return new Promise((ok, no) => {
      const id = ++seq;
      waiting.set(id, (r) => (r.s === 200 ? ok(r.b) : no(new Error(r.error || "手机说不行（" + r.s + "）"))));
      Pad.call(id, method, path, body == null ? "" : JSON.stringify(body));
    });
  }

  // ── 配对和连接的几步 ──
  const SETUP = {
    idle: ["和手机配对", "先在手机上的小克里打开「我的 → 平板」，点「配对新平板」，再点下面的「配对」。两台要连在同一个网里（家里 Wi‑Fi、手机热点都行）。", "art/pad/pair.webp", true],
    searching: ["正在找手机…", "在同一个网里找装了小克的手机。找不到的话，看看两台是不是连着同一个 Wi‑Fi；有些公共 Wi‑Fi 不让设备互相访问，开手机热点就行。", "art/pad/pair.webp", false],
    confirm: ["看看两边的数一样吗", "手机上会显示一样的 6 位数。一样的话，在手机上点「一致，配对」。不一样就别点，有人在中间捣乱。", "art/pad/pair.webp", false],
  };
  let phase = "";
  window.padState = (st) => {
    phase = st.phase;
    const s = SETUP[st.phase];
    $("#setup").hidden = !s; $("#chat").hidden = !!s;
    if (s) {
      $("#setup-title").textContent = s[0]; $("#setup-text").textContent = s[1]; $("#setup-art").src = s[2];
      $("#pair").hidden = !s[3];
      $("#manual").hidden = st.phase === "confirm";
      $("#sas").hidden = st.phase !== "confirm"; $("#sas").textContent = st.sas || "";
      $("#setup-err").hidden = !st.error; $("#setup-err").textContent = st.error || "";
      $("#diag").textContent = st.diag || "";
    } else {
      $("#phone").textContent = "已连上手机 " + (st.phone || "");
      load().catch(fail);
    }
  };
  $("#pair").onclick = () => Pad.pair();
  $("#manual-f").onsubmit = (e) => {
    e.preventDefault();
    const m = $("#manual-a").value.trim().match(/^([\d.]+):(\d+)$/);
    if (!m) { $("#setup-err").hidden = false; $("#setup-err").textContent = "要像 192.168.1.23:8797 这样，地址和端口中间一个冒号"; return; }
    Pad.manual(m[1], Number(m[2]));
  };

  // ── 群聊 ──
  let last = -1, to = new Set();
  const talking = new Set();
  function row(m) {
    if (m.from === "system") return `<div class="sys">${esc(m.text)}</div>`;
    if (m.from === "owner") return `<div class="me"><p>${esc(m.text)}</p></div>`;
    const r = ROLE[m.from] || { name: m.from, c: "var(--fg3)" };
    return `<div class="her${m.kind === "aside" ? " aside" : ""}" style="--c:${r.c}"><img src="${bub(m.from, "idle")}" alt=""><div><b>${esc(r.name)}${m.kind === "aside" ? " · 插了一句" : ""}</b><p>${esc(m.text)}</p></div></div>`;
  }
  function add(m) {
    if (m.n <= last) return;
    last = m.n;
    $("#empty")?.remove();
    $("#list").insertAdjacentHTML("beforeend", row(m));
    $("#list").scrollTop = $("#list").scrollHeight;
  }
  function members(ms) {
    $("#mem").innerHTML = ms.map((m) => {
      const st = talking.has(m.id) || m.state === "talk" ? "talk" : m.state === "sleep" ? "sleep" : "idle", r = ROLE[m.id];
      return `<button class="chip${to.has(m.id) ? " on" : ""}" data-id="${m.id}" style="--c:${r.c}"><img src="${bub(m.id, st)}" alt="">${esc(r.name)}${st === "sleep" ? " · 睡着了" : st === "talk" ? " · 在说…" : ""}</button>`;
    }).join("");
  }
  async function load() {
    const r = await call("GET", "/api/xk/room?after=" + last);
    for (const m of r.messages) add(m);
    members(r.members);
  }
  $("#mem").onclick = (e) => { const c = e.target.closest("[data-id]"); if (!c) return; to.has(c.dataset.id) ? to.delete(c.dataset.id) : to.add(c.dataset.id); c.classList.toggle("on"); };
  const ta = $("#in textarea");
  ta.onblur = () => window.scrollTo(0, 0);
  ta.oninput = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight, 140) + "px"; };
  ta.onkeydown = (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#in").requestSubmit(); } };
  async function send(text) {
    await call("POST", "/api/xk/room", { text, to: [...to] });
    to.clear(); document.querySelectorAll(".chip.on").forEach((c) => c.classList.remove("on"));
  }
  $("#in").onsubmit = async (e) => {
    e.preventDefault();
    const text = ta.value.trim(); if (!text) return;
    ta.value = ""; ta.oninput();
    try { await send(text); } catch (err) { ta.value = text; fail(err); }
  };
  function fail(e) { const p = $("#stream-err"); p.hidden = false; p.textContent = e.message || String(e); setTimeout(() => { p.hidden = true; }, 6000); }

  // ── 手机推过来的事件（加密长轮询，Java 解好了递过来） ──
  window.padEvent = (ev) => {
    if (ev.type !== "xk") return;
    // 按消息号只念一次：长轮询重连时补发的旧消息不再念第二遍（#101）
    if (ev.op === "room") { add(ev.msg); if (ROLE[ev.msg.from] && voiceOk && ev.msg.n > spoken) { spoken = ev.msg.n; Pad.say(ev.msg.from, ev.msg.text); } }
    // QQ 群直播：12 号的台词边写边推过来（一段一个 id，重连补发的旧段不再念）
    else if (ev.op === "voice") { if (voiceOk && ev.id > voiceSeen) { voiceSeen = ev.id; Pad.say(ev.role, ev.text); } }
    else if (ev.op === "voice_stop") Pad.voiceStop();
    else if (ev.op === "room_typing") {
      if (ev.on) talking.add(ev.role); else talking.delete(ev.role);
      $("#typing").innerHTML = [...talking].map((id) => `<span style="--c:${ROLE[id]?.c}">${esc(ROLE[id]?.name || id)}在说…</span>`).join("");
      load().catch(() => {});
    }
  };

  // ── 新版：手机代下好了才提示，点了才装（系统会再弹一次确认） ──
  window.padUpdate = (u) => {
    const b = $("#upd");
    b.hidden = false; b.disabled = u.state === "downloading" || u.state === "installing";
    b.textContent = u.state === "new" ? `有新版 ${u.version}，点这里更新`
      : u.state === "downloading" ? `正在从手机拿新版… ${u.pct}%`
      : u.state === "installing" ? "拿好了，在系统弹窗里点「更新」"
      : `${u.error}（点这里再试）`;
  };
  $("#upd").onclick = () => Pad.update();

  // ── 声音：直连主人电脑上的语音服务（xk/voice），念她们的话、按住说话 ──
  let voiceOk = false, spoken = -1, voiceSeen = 0;   // 直播台词按 id 只念一次（id 是手机的时钟，跟平板的时钟不比）
  window.padVoice = (v) => {
    voiceOk = v.ok && v.on;
    $("#mic").hidden = !v.ok;
    $("#von").checked = v.on;
    const names = (v.voices || []).map((id) => ROLE[id]?.name || id).join("、");
    $("#vstate").textContent = v.ok ? `连上电脑了（${v.host}）。挑好音色的：${names || "还没有（在电脑上运行 design.bat、pick.bat）"}`
      : v.error || (v.found ? "找到电脑了" : "在家里 Wi‑Fi 里找电脑上的语音服务…（电脑上要开着 start.bat，两台连同一个 Wi‑Fi）");
    $("#vbtn").classList.toggle("on", voiceOk);
  };
  $("#vbtn").onclick = () => { $("#voice").hidden = !$("#voice").hidden; };
  $("#vcode-f").onsubmit = (e) => { e.preventDefault(); if ($("#vcode").value.trim()) Pad.voiceCode($("#vcode").value); $("#vcode").value = ""; };
  $("#von").onchange = () => Pad.voiceOn($("#von").checked);
  $("#vfind").onclick = () => Pad.voiceFind();
  // 按住说话：按下开始录，松手（或手指滑出按钮）停下送去转文字
  const mic = $("#mic");
  let holding = false;
  const down = (e) => {
    e.preventDefault(); if (holding) return; holding = true;
    const who = to.size ? [...to] : Object.keys(ROLE);
    $("#lart").innerHTML = who.map((id) => `<img src="art/mini/listening_${ROLE[id].dir}.webp" alt="">`).join("");
    $("#listening").hidden = false; mic.classList.add("on");
    Pad.listen(true);
  };
  const up = () => { if (!holding) return; holding = false; $("#listening").hidden = true; mic.classList.remove("on"); Pad.listen(false); };
  mic.onpointerdown = down; mic.onpointerup = up; mic.onpointercancel = up; mic.onpointerleave = up;
  mic.oncontextmenu = (e) => e.preventDefault();
  window.padHeard = async (r) => {
    if (!r.text) return fail(new Error(r.error || "没听清"));
    try { await send(r.text); } catch (err) { ta.value = r.text; ta.oninput(); fail(err); }
  };

  // ── 手机画面（串流）：点了才开，省电 ──
  let streaming = false;
  $("#screen").onclick = () => { streaming = !streaming; Pad.stream(streaming); $("#screen").textContent = streaming ? "收起画面" : "看手机画面"; };
  window.padStream = (s) => {
    if (s === "on") return;
    streaming = false; $("#screen").textContent = "看手机画面";
    if (s) fail(new Error("手机画面断了：" + s));
  };

  window.padState(JSON.parse(Pad.state()));
  window.padVoice(JSON.parse(Pad.voiceState()));
})();
