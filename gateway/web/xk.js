// 小克：界面上我们自己加的部分。上游 app.js 是一个闭包，这里只通过 window.__cc（上游自己导出的）、DOM 和 /api/xk/* 跟它打交道。
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  async function api(path, opts = {}) {
    const o = { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } };
    if (o.body && typeof o.body !== "string") o.body = JSON.stringify(o.body);
    const r = await fetch(path, o);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || j.error || "HTTP " + r.status);
    return j;
  }
  function toast(msg, err) {
    const el = $("#toast");
    if (!el) return alert(msg);
    el.textContent = msg; el.className = err ? "err" : ""; el.classList.remove("hidden"); el.style.display = "";
    clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add("hidden"), err ? 5000 : 3500);
  }
  const fail = (e) => toast(e.message || String(e), true);

  // ── 产品名：只换作为名字出现的 cccodroid，路径和链接里的不动（和外壳 Xk.brand 同一条规则）──
  const BRAND = /(?<![\/\w.-])cccodroid(?![\/\w.-])/g;
  function brand(root) {
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) if (n.nodeValue.includes("cccodroid")) n.nodeValue = n.nodeValue.replace(BRAND, "小克");
    if (root.querySelectorAll) for (const el of root.querySelectorAll("[title],[aria-label],[placeholder]"))
      for (const a of ["title", "aria-label", "placeholder"]) { const v = el.getAttribute(a); if (v && v.includes("cccodroid")) el.setAttribute(a, v.replace(BRAND, "小克")); }
  }
  new MutationObserver((ms) => {
    for (const m of ms) {
      if (m.type === "characterData") { if (m.target.nodeValue.includes("cccodroid")) m.target.nodeValue = m.target.nodeValue.replace(BRAND, "小克"); }
      else for (const n of m.addedNodes) n.nodeType === 1 ? brand(n) : n.nodeType === 3 && n.nodeValue.includes("cccodroid") && (n.nodeValue = n.nodeValue.replace(BRAND, "小克"));
    }
    if (document.title.includes("cccodroid")) document.title = document.title.replace(BRAND, "小克");
  }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  brand(document.body);
  document.title = "小克";

  // ── 「小克」面板：各模块往 TABS 里登记一页 ──
  const TABS = [];
  window.XK = { api, toast, fail, esc, tab: (id, label, render) => TABS.push({ id, label, render }), open: openPanel, $ };

  function openPanel(tabId) {
    let el = $("#xk-panel");
    if (!el) {
      el = document.createElement("div");
      el.id = "xk-panel";
      el.innerHTML = `<div class="xk-box"><div class="xk-head"><b>小克</b><span class="xk-tabs"></span><button class="icon-btn xk-x" aria-label="关闭">✕</button></div><div class="xk-body"></div></div>`;
      document.body.appendChild(el);
      el.querySelector(".xk-x").onclick = () => el.classList.add("hidden");
      el.addEventListener("click", (e) => { if (e.target === el) el.classList.add("hidden"); });
    }
    el.classList.remove("hidden");
    const tabs = el.querySelector(".xk-tabs"), body = el.querySelector(".xk-body");
    const cur = TABS.find((t) => t.id === tabId) || TABS[0];
    tabs.innerHTML = TABS.map((t) => `<button class="xk-tab${t === cur ? " on" : ""}" data-id="${t.id}">${esc(t.label)}</button>`).join("");
    tabs.onclick = (e) => { const b = e.target.closest(".xk-tab"); if (b) openPanel(b.dataset.id); };
    body.innerHTML = "";
    Promise.resolve(cur.render(body)).catch(fail);
  }

  // 侧栏顶上的入口
  function mountEntry() {
    const head = $(".side-head");
    if (!head || $("#xk-entry")) return;
    const b = document.createElement("button");
    b.id = "xk-entry"; b.className = "icon-btn"; b.title = "小克"; b.textContent = "克";
    b.onclick = () => openPanel();
    head.insertBefore(b, head.lastElementChild);
  }

  // ── 设置：更新源与关于 ──
  XK.tab("about", "设置", async (body) => {
    const f = await api("/api/xk/update-feed");
    body.innerHTML = `<h3>App 更新源</h3>
      <p class="tiny">GitHub releases API 形状的地址，留空用默认：${esc(f.default)}</p>
      <input id="xk-feed" class="xk-in" value="${esc(f.feed)}"><button class="btn sm" id="xk-feed-save">保存</button>
      <h3>关于</h3><p class="tiny">小克基于 cccodroid（greyoak111/cccodroid，Apache-2.0）修改。上游的许可与 NOTICE 原样保留在 App 内。</p>`;
    $("#xk-feed-save", body).onclick = () => api("/api/xk/update-feed", { method: "PUT", body: { feed: $("#xk-feed", body).value } })
      .then((r) => toast("已保存：" + r.feed)).catch(fail);
  });


  // ── 角色：顶栏显示这个会话是谁，点开可以换 ──
  let ROLES = null;
  async function loadRoles() { ROLES = await api("/api/xk/roles"); return ROLES; }
  const roleName = (id) => (ROLES && ROLES.roles.find((r) => r.id === id) || {}).name || id || "—";
  let chipSid;
  async function paintChip(force) {
    const cc = window.__cc;
    if (!cc) return;
    const sid = cc.view.sessionId || null;
    if (!force && sid === chipSid && $("#xk-role")) return;
    chipSid = sid;
    let chip = $("#xk-role");
    if (!chip) {
      const tb = $("#title-block");
      if (!tb) return;
      chip = document.createElement("button");
      chip.id = "xk-role"; chip.className = "xk-role";
      chip.onclick = (e) => { e.stopPropagation(); roleMenu(chip); };
      tb.after(chip);
    }
    if (!ROLES) await loadRoles();
    const r = await api("/api/xk/session-role" + (sid ? "?sid=" + encodeURIComponent(sid) : ""));
    chip.textContent = roleName(r.role || r.active) + (r.origin ? "（接班）" : "");
    chip.title = r.origin ? `从${roleName(r.origin.from)}接过来的：${r.origin.reason}` : "当前角色，点一下可以换";
  }
  function roleMenu(anchor) {
    $("#xk-role-menu")?.remove();
    const m = document.createElement("div");
    m.id = "xk-role-menu"; m.className = "xk-menu";
    m.innerHTML = ROLES.roles.map((r) => `<button data-id="${r.id}">${esc(r.name)}${r.cooldown ? "（额度未恢复）" : ""}${r.imported ? "" : "（未导入人设）"}</button>`).join("");
    document.body.appendChild(m);
    const b = anchor.getBoundingClientRect();
    m.style.top = b.bottom + 4 + "px"; m.style.left = Math.max(4, b.left) + "px";
    m.onclick = async (e) => {
      const id = e.target.closest("button")?.dataset.id;
      m.remove();
      if (id) await switchRole(id).catch(fail);
    };
    setTimeout(() => document.addEventListener("click", () => m.remove(), { once: true }), 0);
  }
  /** 手动换角色：开一个新会话落到那个角色，第一条消息带上刚才那段对话（网关 /api/xk/switch） */
  async function switchRole(id) {
    const cc = window.__cc, from = cc.view.sessionId || null;
    const r = await api("/api/xk/switch", { method: "POST", body: { to: id, fromSessionId: from } });
    cc.newConversation();
    cc.view.projectId = r.projectId;
    await loadRoles(); paintChip(true);
    toast(`换成${roleName(id)}了` + (from ? "，下一条消息会带上刚才的对话" : ""));
  }
  XK.switchRole = switchRole;
  setInterval(() => paintChip().catch(() => {}), 1000);

  XK.tab("roles", "角色", async (body) => {
    await loadRoles();
    body.innerHTML = `<p class="tiny">人设文件是 .txt：「【一】system_prompt」「【二】post_history_instructions」「【三】mes_example」三段各占一行开头；没有这些标记就整篇当人设。内容只存在手机里。</p>` +
      ROLES.roles.map((r) => `<div class="xk-card"><div class="xk-row"><b>${esc(r.name)}</b><span class="tiny">${r.id === ROLES.active ? "当前" : ""}
        ${r.imported ? `人设 ${r.personaChars} 字` : "未导入人设"} · post_history ${r.postHistoryChars} 字${r.cooldown ? ` · 额度未恢复（${new Date(r.cooldown.until).toLocaleString()}）` : ""}</span></div>
        <div class="xk-row"><label class="btn sm">导入人设<input type="file" accept=".txt,text/plain" hidden data-persona="${r.id}"></label>
        <button class="btn sm ghost" data-use="${r.id}">换成${esc(r.name)}</button></div></div>`).join("") +
      `<h3>世界书</h3><p class="tiny">三个角色共用。纯文本、Markdown 或 SillyTavern 世界书 JSON。</p>
       <label class="btn sm">导入世界书<input type="file" accept=".txt,.md,.json" hidden id="xk-wb"></label>
       <h3>接班顺序</h3><p class="tiny">额度用完时按这个顺序换到下一个角色。</p>
       <input class="xk-in" id="xk-order" value="${esc(ROLES.order.join(", "))}"><button class="btn sm" id="xk-order-save">保存顺序</button>`;
    body.onchange = async (e) => {
      const f = e.target.files && e.target.files[0];
      if (!f) return;
      const text = await f.text();
      try {
        if (e.target.dataset.persona) { const r = await api(`/api/xk/roles/${e.target.dataset.persona}/persona`, { method: "PUT", body: { text } }); toast(`已导入：人设 ${r.personaChars} 字，post_history ${r.postHistoryChars} 字`); }
        else if (e.target.id === "xk-wb") { const r = await api("/api/xk/worldbook", { method: "PUT", body: { text } }); toast(`世界书已导入：${r.chars} 字`); }
        openPanel("roles");
      } catch (err) { fail(err); }
    };
    body.onclick = (e) => {
      const u = e.target.dataset && e.target.dataset.use;
      if (u) { $("#xk-panel").classList.add("hidden"); switchRole(u).catch(fail); }
      if (e.target.id === "xk-order-save") api("/api/xk/order", { method: "PUT", body: { order: $("#xk-order", body).value.split(/[,，\s]+/).filter(Boolean) } }).then(() => toast("已保存")).catch(fail);
    };
  });

  // ── 记忆：每个角色一套，看、改、删 ──
  const KIND = { fact: "事实", event: "事件", plan: "计划", opinion: "看法" };
  const CH = { app: "App", "qq-private": "QQ 私聊", "qq-group": "QQ 群" };
  let memRole = null;
  XK.tab("memory", "记忆", async (body) => {
    if (!ROLES) await loadRoles();
    memRole = memRole || ROLES.active;
    const r = await api("/api/xk/memory?role=" + memRole);
    body.innerHTML = `<div class="xk-row">${ROLES.roles.map((x) => `<button class="btn sm ${x.id === memRole ? "" : "ghost"}" data-role="${x.id}">${esc(x.name)}</button>`).join("")}
      <input class="xk-in" id="xk-mq" placeholder="筛选" style="flex:1;min-width:120px"></div>
      <p class="tiny">${r.items.length} 条。对话停下 10 分钟后她会自动整理一遍；灰色的是已过去的。</p><div id="xk-mlist"></div>`;
    const paint = () => {
      const q = $("#xk-mq", body).value.trim();
      $("#xk-mlist", body).innerHTML = r.items.filter((m) => !q || m.text.includes(q) || m.who.includes(q)).map((m) => `
        <div class="xk-card${m.past ? " xk-past" : ""}" data-id="${m.id}">
          <div class="tiny">${esc(m.date)} · ${KIND[m.kind] || m.kind} · ${esc(m.who)} · 来自${CH[m.channel] || esc(m.channel)}${m.past ? ` · 已过去${m.until ? "（" + esc(m.until) + " 起）" : ""}` : m.until ? ` · 到 ${esc(m.until)}` : ""}</div>
          <div>${esc(m.text)}</div>
          <div class="xk-row"><button class="btn sm ghost" data-act="edit">改</button><button class="btn sm ghost" data-act="past">${m.past ? "还成立" : "标成已过去"}</button><button class="btn sm ghost" data-act="del">删</button></div>
        </div>`).join("") || `<p class="tiny">还没有记忆。</p>`;
    };
    paint();
    $("#xk-mq", body).oninput = paint;
    body.onclick = async (e) => {
      const rb = e.target.dataset.role;
      if (rb) { memRole = rb; return openPanel("memory"); }
      const act = e.target.dataset.act, card = e.target.closest(".xk-card");
      if (!act || !card) return;
      const id = card.dataset.id, m = r.items.find((x) => x.id === id);
      try {
        if (act === "del") { if (!confirm("删掉这条记忆？")) return; await api(`/api/xk/memory/${memRole}/${id}`, { method: "DELETE" }); }
        if (act === "past") await api(`/api/xk/memory/${memRole}/${id}`, { method: "PATCH", body: { past: !m.past, until: m.past ? "" : new Date().toISOString().slice(0, 10) } });
        if (act === "edit") {
          const text = prompt("内容", m.text); if (text == null) return;
          const date = prompt("日期（YYYY-MM-DD）", m.date); if (date == null) return;
          await api(`/api/xk/memory/${memRole}/${id}`, { method: "PATCH", body: { text, date } });
        }
        openPanel("memory");
      } catch (err) { fail(err); }
    };
  });
  const boot = () => { mountEntry(); if (!$("#xk-entry")) setTimeout(boot, 500); };
  boot();
})();
