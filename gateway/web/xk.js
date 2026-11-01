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

  const boot = () => { mountEntry(); if (!$("#xk-entry")) setTimeout(boot, 500); };
  boot();
})();
