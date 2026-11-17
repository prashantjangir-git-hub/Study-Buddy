/* Study Buddy front end. Plain JavaScript, no build step. */
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const el = (tag, cls, html) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const store = {
    get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const thumbUrl = (id, p) => `/slides/${id}/thumb-${String(p).padStart(3, "0")}.jpg`;
  const pageUrl = (id, p) => `/slides/${id}/page-${String(p).padStart(3, "0")}.png`;
  const ICON = {
    x: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5.5 5.5l9 9M14.5 5.5l-9 9"/></svg>',
    pen: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M13.5 3.5l3 3L7 16H4v-3z"/></svg>',
    retry: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 10a6 6 0 1 0 2-4.5M4 3v3h3"/></svg>',
    check: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>',
    books: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3.5 4.5h4.2a2.3 2.3 0 0 1 2.3 2.3v9a1.8 1.8 0 0 0-1.8-1.8H3.5zM16.5 4.5h-4.2A2.3 2.3 0 0 0 10 6.8v9a1.8 1.8 0 0 1 1.8-1.8h4.7z"/></svg>',
    spark: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5l1.6 4.3 4.4 1.6-4.4 1.6L10 14.3 8.4 10 4 8.4l4.4-1.6z"/></svg>',
    plus: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12"/></svg>',
  };

  const state = {
    decks: [],
    scope: null,
    provider: store.get("provider", "ollama"),
    status: null,
    history: [],
    busy: false,
    memories: [],
    knownMemoryIds: null,
    viewer: { deck: null, pages: [], i: 0 },
    panel: null,       // "viewer" | "memory" | null
    view: "chat",
  };

  const chatView = $("#chatView"), thread = $("#thread"), dock = $("#dock");
  const input = $("#input"), sendBtn = $("#send"), panel = $("#panel");

  // ===================================================== smooth caret ==
  // A spring-animated caret that glides to where you type, ported from the
  // SmoothInput React component to plain JS and extended to multi-line text.
  const PASSWORD_CHAR = /firefox|fxios/i.test(navigator.userAgent) ? "●" : "•";
  const MIRROR_PROPS = ["boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle",
    "fontStyle", "fontVariant", "fontWeight", "fontStretch", "fontSize", "lineHeight", "fontFamily",
    "fontFeatureSettings", "fontVariationSettings", "letterSpacing", "wordSpacing", "textTransform", "textIndent", "tabSize"];

  class SmoothCaret {
    constructor(field, host, spring = { stiffness: 500, damping: 30, mass: 0.5 }) {
      this.field = field;
      this.host = host;
      this.multi = field.tagName === "TEXTAREA";
      this.spring = spring;
      this.caret = el("div", "smooth-caret");
      this.mirror = el("div", "smooth-mirror");
      this.marker = document.createElement("span");
      host.append(this.caret, this.mirror);
      this.x = this.y = this.tx = this.ty = this.vx = this.vy = 0;
      this.snap = true;
      this.raf = 0;
      this.idleTimer = 0;

      const later = () => requestAnimationFrame(() => this.update());
      ["input", "keydown", "keyup", "mouseup", "select", "click"].forEach((e) => field.addEventListener(e, later));
      field.addEventListener("focus", () => { this.snap = true; later(); });
      field.addEventListener("blur", () => this.hide());
      field.addEventListener("scroll", () => { this.snap = true; this.update(); });
      document.addEventListener("selectionchange", () => { if (document.activeElement === field) later(); });
      new ResizeObserver(() => { this.snap = true; if (document.activeElement === field) this.update(); }).observe(host);
      document.fonts?.ready.then(() => { this.snap = true; if (document.activeElement === field) this.update(); });
    }

    hide() { this.caret.classList.remove("on", "idle"); }

    measure() {
      const f = this.field;
      const cs = getComputedStyle(f);
      const m = this.mirror;
      MIRROR_PROPS.forEach((p) => { m.style[p] = cs[p]; });
      m.style.width = f.offsetWidth + "px";
      m.style.whiteSpace = this.multi ? "pre-wrap" : "pre";
      m.style.left = f.offsetLeft + "px";
      m.style.top = f.offsetTop + "px";
      const start = f.selectionStart ?? 0, end = f.selectionEnd ?? 0;
      const idx = start === end ? start : (f.selectionDirection === "backward" ? start : end);
      const before = f.type === "password" ? PASSWORD_CHAR.repeat(idx) : f.value.slice(0, idx);
      m.textContent = before;
      this.marker.textContent = "​";
      m.appendChild(this.marker);
      const fs = parseFloat(cs.fontSize);
      const lh = this.multi ? (parseFloat(cs.lineHeight) || fs * 1.4) : fs * 1.3;
      const h = Math.round(lh * 0.82);
      let x = f.offsetLeft + this.marker.offsetLeft - f.scrollLeft;
      // a single-line input centres its text vertically, whatever the line height says
      let y = this.multi
        ? f.offsetTop + this.marker.offsetTop - f.scrollTop + (lh - h) / 2
        : f.offsetTop + f.clientTop + (f.clientHeight - h) / 2;
      // keep it inside the visible text box
      const left = f.offsetLeft + parseFloat(cs.paddingLeft) - 1;
      const right = f.offsetLeft + f.clientWidth - parseFloat(cs.paddingRight);
      const top = f.offsetTop, bottom = f.offsetTop + f.clientHeight;
      const visible = x >= left - 1 && x <= right + 2 && y + h > top && y < bottom;
      x = Math.min(Math.max(x, left), right);
      return { x, y, h, visible, selecting: start !== end };
    }

    update() {
      if (document.activeElement !== this.field) return this.hide();
      const r = this.measure();
      this.caret.style.height = r.h + "px";
      if (!r.visible || r.selecting) return this.hide();
      this.caret.classList.add("on");
      this.caret.classList.remove("idle");
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => this.caret.classList.add("idle"), 600);
      this.tx = r.x; this.ty = r.y;
      if (this.snap || reduceMotion()) {
        this.snap = false;
        this.x = r.x; this.y = r.y; this.vx = this.vy = 0;
        this.paint();
        return;
      }
      if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame((t) => this.tick(t)); }
    }

    tick(now) {
      const { stiffness: k, damping: c, mass: m } = this.spring;
      let dt = Math.min(0.05, (now - this.last) / 1000);
      this.last = now;
      const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
      dt /= steps;
      for (let i = 0; i < steps; i++) {
        this.vx += ((-k * (this.x - this.tx) - c * this.vx) / m) * dt;
        this.vy += ((-k * (this.y - this.ty) - c * this.vy) / m) * dt;
        this.x += this.vx * dt;
        this.y += this.vy * dt;
      }
      const settled = Math.abs(this.x - this.tx) < 0.05 && Math.abs(this.y - this.ty) < 0.05 && Math.abs(this.vx) < 0.5 && Math.abs(this.vy) < 0.5;
      if (settled) { this.x = this.tx; this.y = this.ty; this.vx = this.vy = 0; }
      this.paint();
      this.raf = settled ? 0 : requestAnimationFrame((t) => this.tick(t));
    }

    paint() { this.caret.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`; }
  }

  // ========================================================== helpers ==

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: opts.body && !(opts.body instanceof FormData) ? { "Content-Type": "application/json" } : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  let toastTimer;
  function toast(msg, ms = 3400) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("on"), ms);
  }

  const inlineCode = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
  const nearBottom = () => thread.scrollHeight - thread.scrollTop - thread.clientHeight < 160;
  const scrollDown = (force) => { if (force || nearBottom()) thread.scrollTop = thread.scrollHeight; };
  const deckName = (id) => state.decks.find((d) => d.id === id)?.name || "Lecture";
  const shortName = (n) => (n.length > 22 ? n.slice(0, 20).trimEnd() + "…" : n);
  function deckCode(name) {
    const m = name.match(/\b(?:lecture|lec|week|wk|l|w)\s*0*(\d+)/i);
    if (m) return (/^w/i.test(m[0]) ? "W" : "L") + m[1];
    const first = name.split(/\s+/)[0] || name;
    return first.length > 12 ? first.slice(0, 11) + "…" : first;
  }
  const listJoin = (a) => (a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1]);

  // ========================================================= markdown ==

  function renderMarkdown(src, sources, seenCites) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    const tex = (t, display) => {
      if (window.katex) {
        try { return window.katex.renderToString(t, { displayMode: display, throwOnError: false }); } catch { /* fall through */ }
      }
      return `<code>${esc(t)}</code>`;
    };
    src = src.replace(/```[\w+-]*\n?([\s\S]*?)(```|$)/g, (_, code) => hold(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
    src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => hold(`<div>${tex(t.trim(), true)}</div>`));
    src = src.replace(/\\\[([\s\S]+?)\\\]/g, (_, t) => hold(`<div>${tex(t.trim(), true)}</div>`));
    src = src.replace(/\\\((.+?)\\\)/g, (_, t) => hold(tex(t, false)));
    src = src.replace(/(^|[^\\$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/g, (_, pre, t) => pre + hold(tex(t, false)));
    src = src.replace(/`([^`\n]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));

    let citeCount = 0;
    const inline = (s) => {
      s = esc(s);
      s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      s = s.replace(/(^|[^*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, "$1<em>$2</em>");
      s = s.replace(/(^|\W)_(?!\s)(.+?)(?<!\s)_(?!\w)/g, "$1<em>$2</em>");
      s = s.replace(/\[((?:S\d+\s*,?\s*)+)\]/g, (_, inner) => (inner.match(/\d+/g) || []).map((n) => {
        const it = sources[+n - 1];
        if (!it) return "";
        const seen = citeCount++ < seenCites ? " seen" : "";
        return `<button type="button" class="cite${seen}" data-deck="${it.deck_id}" data-page="${it.page}" title="${esc(it.deck_name)}, slide ${it.page}">${esc(deckCode(it.deck_name))} p.${it.page}</button>`;
      }).join(""));
      return s;
    };

    const out = [];
    let list = null, para = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.type}>`); list = null; } };
    for (const raw of src.split("\n")) {
      const line = raw.trimEnd();
      let m;
      if (!line.trim()) { flushPara(); flushList(); continue; }
      if (/^\u0000\d+\u0000$/.test(line.trim()) && /^<(pre|div)>/.test(slots[+line.trim().slice(1, -1)])) {
        flushPara(); flushList(); out.push(line.trim()); continue;
      }
      if ((m = line.match(/^#{1,6}\s+(.*)$/))) { flushPara(); flushList(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
      if ((m = line.match(/^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/))) {
        flushPara();
        const type = m[1] ? "ol" : "ul";
        if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
        list.items.push(m[2]); continue;
      }
      if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
      flushList();
      para.push(line);
    }
    flushPara(); flushList();
    let html = out.join("");
    for (let k = 0; k < 3 && html.includes("\u0000"); k++) html = html.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i]);
    return { html, cites: citeCount };
  }
  const mdInline = (s) => renderMarkdown(s, [], 0).html.replace(/^<p>|<\/p>$/g, "");

  // ============================================================ theme ==

  const themeBtn = $("#themeBtn");
  function labelTheme() {
    const dark = document.documentElement.dataset.theme === "dark";
    themeBtn.setAttribute("aria-label", dark ? "Switch to light mode" : "Switch to dark mode");
  }
  themeBtn.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    const apply = () => { document.documentElement.dataset.theme = next; store.set("theme", next); labelTheme(); };
    if (!document.startViewTransition || reduceMotion()) return apply();
    const r = themeBtn.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    document.startViewTransition(apply).ready.then(() => {
      document.documentElement.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: 700, easing: "cubic-bezier(.16, 1, .3, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    });
  });
  labelTheme();

  // ============================================================= tabs ==

  const tabs = $(".tabs");
  function placeTabThumb() {
    const b = $('[aria-selected="true"]', tabs);
    const t = $(".tab-thumb", tabs);
    t.style.width = b.offsetWidth + "px";
    t.style.transform = `translateX(${b.offsetLeft}px)`;
  }
  function setView(v) {
    if (state.view === v) return;
    state.view = v;
    $$("button[data-view]", tabs).forEach((b) => b.setAttribute("aria-selected", String(b.dataset.view === v)));
    placeTabThumb();
    $("#chatView").hidden = v !== "chat";
    $("#libraryView").hidden = v !== "library";
    document.body.classList.toggle("library-mode", v === "library");
    const shown = v === "chat" ? $("#chatView") : $("#libraryView");
    if (!reduceMotion()) shown.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }], { duration: 450, easing: "cubic-bezier(.16,1,.3,1)" });
    if (v === "chat") setTimeout(() => input.focus(), 50);
  }
  tabs.addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
  addEventListener("resize", placeTabThumb);
  document.fonts?.ready.then(placeTabThumb);

  // =========================================================== status ==

  async function loadStatus() {
    try { state.status = await api("/api/status"); } catch { return; }
    if (state.provider === "gemini" && !state.status.gemini.configured) setMode("ollama");
    showNotice();
  }

  function showNotice() {
    const n = $("#notice"), s = state.status;
    let msg = "";
    if (s && state.provider === "ollama") {
      if (!s.ollama.running) msg = "Ollama isn't running. Open the Ollama app, then refresh this page. Or <button type=\"button\" data-gemini>use Gemini instead</button>.";
      else if (s.ollama.missing.length) msg = `Download the local models first. In a terminal, run: ${s.ollama.missing.map((m) => `<code>ollama pull ${esc(m)}</code>`).join(" ")}`;
    } else if (s && !s.ollama.running) {
      msg = "Ollama isn't running, so reading new PDFs and remembering things won't work. Open the Ollama app.";
    }
    n.innerHTML = msg;
    n.hidden = !msg;
  }
  $("#notice").addEventListener("click", (e) => { if (e.target.closest("[data-gemini]")) chooseGemini(); });

  // ============================================================= mode ==

  const modeEl = $(".mode");
  function setMode(p, announce) {
    state.provider = p;
    store.set("provider", p);
    modeEl.dataset.mode = p;
    $$("button", modeEl).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === p)));
    showNotice();
    if (announce) toast(p === "gemini" ? "Gemini will explain. Sharper on hard topics, with a free daily limit." : "Your laptop will explain. Private and unlimited.");
  }
  function chooseGemini() {
    if (state.status?.gemini.configured) setMode("gemini", true);
    else openGeminiModal();
  }
  modeEl.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-mode]");
    if (!b) return;
    if (b.dataset.mode === "gemini") {
      if (state.provider === "gemini") openGeminiModal();   // already on: manage the key
      else chooseGemini();
    } else if (state.provider !== "ollama") setMode("ollama", true);
  });

  // ---------------------------------------------------- Gemini modal --
  const gModal = $("#geminiModal"), keyInput = $("#keyInput"), keyError = $("#keyError");
  function openGeminiModal() {
    const connected = !!state.status?.gemini.configured;
    $("#gTitle").textContent = connected ? "Gemini is connected" : "Connect Gemini";
    $("#gIntro").innerHTML = connected
      ? `Using <b>${esc(state.status.gemini.model)}</b>. Paste a new key below to replace it, or disconnect.`
      : "Gemini explains harder topics better and reads diagrams well. It's free with a daily limit.";
    $("#gSteps").hidden = connected;
    $("#keyRemove").hidden = !connected;
    $("#keySave").textContent = connected ? "Replace key" : "Connect";
    keyInput.value = "";
    keyInput.type = "password";
    keyError.textContent = "";
    gModal.hidden = false;
    setTimeout(() => keyInput.focus(), 80);
  }
  function closeGeminiModal() { gModal.hidden = true; }
  gModal.addEventListener("click", (e) => { if (e.target.closest("[data-dismiss]")) closeGeminiModal(); });
  $("#keyEye").addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
    keyInput.focus();
  });
  $("#geminiForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const save = $("#keySave");
    const label = save.textContent;
    save.disabled = true;
    save.textContent = "Checking…";
    keyError.textContent = "";
    try {
      await api("/api/settings/gemini", { method: "POST", body: JSON.stringify({ key: keyInput.value }) });
      await loadStatus();
      closeGeminiModal();
      setMode("gemini");
      toast("Gemini connected. It'll explain from now on.");
    } catch (err) {
      keyError.textContent = err.message;
      const w = $("#keyWrap");
      w.classList.remove("shake"); void w.offsetWidth; w.classList.add("shake");
    } finally {
      save.disabled = false;
      save.textContent = label;
    }
  });
  $("#keyRemove").addEventListener("click", async () => {
    await api("/api/settings/gemini", { method: "POST", body: JSON.stringify({ remove: true }) }).catch(() => {});
    await loadStatus();
    closeGeminiModal();
    setMode("ollama");
    toast("Gemini disconnected. Your laptop will explain.");
  });

  // ============================================================ decks ==

  let deckPoll;
  async function loadDecks() {
    try { state.decks = (await api("/api/decks")).decks; } catch { return; }
    renderLibrary();
    renderScope();
    updateGreeting();
    clearTimeout(deckPoll);
    if (state.decks.some((d) => d.status === "reading" || d.status === "indexing")) deckPoll = setTimeout(loadDecks, 1200);
  }

  function deckMeta(d) {
    if (d.status === "ready") return `${d.pages} slides`;
    if (d.status === "error") return d.error || "Couldn't read this file";
    if (d.status === "indexing") return "Indexing slides…";
    return d.pages ? `Reading slide ${Math.max(1, Math.round(d.progress * 2 * d.pages))} of ${d.pages}…` : "Opening…";
  }

  function renderLibrary() {
    const grid = $("#deckGrid");
    const seen = new Set();
    state.decks.forEach((d, k) => {
      seen.add(d.id);
      let card = grid.querySelector(`.deck-card[data-id="${d.id}"]`);
      if (!card) {
        card = el("div", "deck-card");
        card.dataset.id = d.id;
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.style.animationDelay = `${Math.min(k, 10) * 50}ms`;
        card.innerHTML = `
          <div class="thumb"></div>
          <div class="name"></div>
          <div class="meta"></div>
          <div class="bar"><i></i></div>
          <button type="button" class="linkish chat-about" data-act="chat">Ask about this lecture</button>
          <div class="actions">
            <button type="button" data-act="retry" aria-label="Try again" hidden>${ICON.retry}</button>
            <button type="button" data-act="rename" aria-label="Rename">${ICON.pen}</button>
            <button type="button" data-act="delete" aria-label="Remove">${ICON.x}</button>
          </div>`;
        grid.appendChild(card);
      }
      const nameEl = $(".name", card);
      if (!nameEl.querySelector("input")) nameEl.textContent = d.name;
      const meta = $(".meta", card);
      meta.textContent = deckMeta(d);
      meta.classList.toggle("error", d.status === "error");
      card.classList.toggle("is-error", d.status === "error" && !d.pages);
      $(".bar", card).hidden = d.status === "ready" || d.status === "error";
      $(".bar i", card).style.transform = `scaleX(${Math.max(0.03, d.progress || 0)})`;
      $(".chat-about", card).hidden = d.status !== "ready";
      $('[data-act="retry"]', card).hidden = d.status !== "error";
      const thumb = $(".thumb", card);
      if (d.pages > 0 && !thumb.dataset.set && (d.status !== "reading" || d.progress > 0.01)) {
        thumb.style.backgroundImage = `url("${thumbUrl(d.id, 1)}")`;
        thumb.dataset.set = "1";
      }
    });
    $$(".deck-card", grid).forEach((c) => { if (!seen.has(c.dataset.id)) c.remove(); });
    $("#deckCount").textContent = state.decks.length || "";
    if (state.scope && !state.decks.some((d) => d.id === state.scope)) setScope(null);
  }

  $("#deckGrid").addEventListener("click", async (e) => {
    if (e.target.closest("#addCard")) return $("#fileInput").click();
    const card = e.target.closest(".deck-card");
    if (!card || e.target.closest("input")) return;
    const id = card.dataset.id;
    const d = state.decks.find((x) => x.id === id);
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (act === "delete") {
      if (!confirm(`Remove "${d?.name}" from your library?`)) return;
      card.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(.9)" }], { duration: 300, fill: "forwards" });
      await api(`/api/decks/${id}`, { method: "DELETE" });
      if (state.viewer.deck?.id === id) closePanel();
      delete deckCache[id];
      return loadDecks();
    }
    if (act === "retry") { await api(`/api/decks/${id}`, { method: "PATCH", body: JSON.stringify({ retry: true }) }); return loadDecks(); }
    if (act === "rename") return startRename(card, id);
    if (act === "chat") { setScope(id); setView("chat"); return; }
    if (d?.status === "ready") openViewer(id, 1);
  });
  $("#deckGrid").addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("deck-card")) { e.preventDefault(); e.target.click(); }
  });

  function startRename(card, id) {
    const nameEl = $(".name", card);
    const current = deckName(id);
    const inp = el("input", "deck-rename");
    inp.value = current;
    nameEl.textContent = "";
    nameEl.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      inp.remove();
      nameEl.textContent = current;
      if (save && v && v !== current) {
        await api(`/api/decks/${id}`, { method: "PATCH", body: JSON.stringify({ name: v }) });
        delete deckCache[id];
        await loadDecks();
        if (state.viewer.deck?.id === id) $("#viewerTitle").textContent = v;
      }
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); e.stopPropagation(); });
    inp.addEventListener("blur", () => finish(true));
    inp.addEventListener("click", (e) => e.stopPropagation());
  }

  // ------------------------------------------------------------ scope --
  const scopeBtn = $("#scopeBtn"), scopeMenu = $("#scopeMenu");
  function setScope(id) {
    state.scope = id;
    renderScope();
  }
  function renderScope() {
    $("#scopeLabel").textContent = state.scope ? deckName(state.scope) : "All lectures";
    scopeBtn.classList.toggle("scoped", !!state.scope);
  }
  function openScopeMenu() {
    const ready = state.decks;
    scopeMenu.innerHTML = "";
    const opt = (id, name, thumb, disabled) => {
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(state.scope === id));
      b.disabled = !!disabled;
      b.innerHTML = `${thumb}<span class="mname">${esc(name)}</span><span class="check">${ICON.check}</span>`;
      b.addEventListener("click", () => { setScope(id); closeScopeMenu(); input.focus(); });
      scopeMenu.appendChild(b);
    };
    opt(null, "All lectures", `<span class="mthumb all">${ICON.books}</span>`);
    ready.forEach((d) => opt(d.id, d.name, `<span class="mthumb" style="background-image:url('${thumbUrl(d.id, 1)}')"></span>`, d.status !== "ready"));
    if (!ready.length) {
      const b = el("button", null, `<span class="mthumb all">${ICON.plus}</span><span class="mname">Add lecture PDFs</span><span></span>`);
      b.type = "button";
      b.addEventListener("click", () => { closeScopeMenu(); $("#fileInput").click(); });
      scopeMenu.appendChild(b);
    }
    scopeMenu.hidden = false;
    const r = scopeBtn.getBoundingClientRect();
    const h = scopeMenu.offsetHeight;
    const below = r.top < h + 20;
    scopeMenu.classList.toggle("below", below);
    scopeMenu.style.left = Math.min(r.left, innerWidth - scopeMenu.offsetWidth - 10) + "px";
    scopeMenu.style.top = (below ? r.bottom + 8 : r.top - h - 8) + "px";
    scopeBtn.setAttribute("aria-expanded", "true");
    $("button", scopeMenu)?.focus();
  }
  function closeScopeMenu() { scopeMenu.hidden = true; scopeBtn.setAttribute("aria-expanded", "false"); }
  scopeBtn.addEventListener("click", (e) => { e.stopPropagation(); scopeMenu.hidden ? openScopeMenu() : closeScopeMenu(); });
  document.addEventListener("click", (e) => { if (!scopeMenu.hidden && !scopeMenu.contains(e.target)) closeScopeMenu(); });

  // =========================================================== upload ==

  async function upload(files) {
    const list = [...files];
    if (!list.length) return;
    const fd = new FormData();
    list.forEach((f) => fd.append("files", f));
    try {
      const res = await api("/api/decks", { method: "POST", body: fd });
      if (res.rejected.length) toast(res.rejected.join(" "), 6500);
      else toast(res.added.length === 1 ? `Reading ${res.added[0].name}…` : `Reading ${res.added.length} lectures…`);
      if (res.added.length && state.view === "chat" && chatView.classList.contains("is-empty")) setView("library");
    } catch (err) { toast(err.message, 5000); }
    loadDecks();
  }
  $("#attachBtn").addEventListener("click", () => $("#fileInput").click());
  $("#fileInput").addEventListener("change", (e) => { upload(e.target.files); e.target.value = ""; });

  let dragDepth = 0;
  const dz = $("#dropzone");
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dz.classList.add("on"); });
  addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) dz.classList.remove("on"); });
  addEventListener("drop", (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; dz.classList.remove("on"); upload(e.dataTransfer.files); });

  // ============================================================= chat ==

  function updateGreeting() {
    const h = new Date().getHours();
    const when = h >= 5 && h < 12 ? "this morning" : h < 17 && h >= 12 ? "this afternoon" : h < 21 && h >= 17 ? "this evening" : "tonight";
    $("#greeting").textContent = state.decks.length
      ? `What are we studying ${when}?`
      : "Add your lecture PDFs with the clip button, or drop them anywhere.";
  }

  // The first message moves the composer from the middle of the screen to the bottom
  function startChatting() {
    if (!chatView.classList.contains("is-empty")) return;
    const before = dock.getBoundingClientRect().top;
    $("#hero")?.remove();
    chatView.classList.remove("is-empty");
    document.body.classList.add("chatting");
    const after = dock.getBoundingClientRect().top;
    if (!reduceMotion()) dock.animate([{ transform: `translateY(${before - after}px)` }, { transform: "none" }], { duration: 650, easing: "cubic-bezier(.16,1,.3,1)" });
    showNewChatChip(true);
  }

  function newChat() {
    if (state.busy) return;
    state.history = [];
    $$(".msg", thread).forEach((m) => m.remove());
    const hero = el("div", "hero");
    hero.id = "hero";
    hero.innerHTML = `<span class="orb orb-lg" aria-hidden="true"></span><h1>Hi, I'm Study Buddy</h1><p id="greeting"></p>`;
    thread.appendChild(hero);
    chatView.classList.add("is-empty");
    document.body.classList.remove("chatting");
    updateGreeting();
    showNewChatChip(false);
    input.focus();
  }
  function showNewChatChip(on) {
    let c = $("#newChat");
    if (on && !c) {
      c = el("button", "chip", `${ICON.plus}New chat`);
      c.id = "newChat";
      c.type = "button";
      c.addEventListener("click", newChat);
      $("#actions").prepend(c);
    } else if (!on && c) c.remove();
  }

  function addUser(text) {
    startChatting();
    const m = el("div", "msg user");
    const b = el("div", "bubble");
    b.textContent = text;
    m.appendChild(b);
    thread.appendChild(m);
    scrollDown(true);
  }

  function addAssistant(label = "Finding the right slides") {
    const m = el("div", "msg assistant");
    m.innerHTML = `<span class="orb orb-sm busy" aria-hidden="true"></span><div class="msg-body"><div class="thinking"><span class="dots"><i></i><i></i><i></i></span><span class="shimmer">${esc(label)}</span></div></div>`;
    thread.appendChild(m);
    scrollDown(true);
    return { msg: m, body: $(".msg-body", m), done: () => $(".orb", m).classList.remove("busy") };
  }

  function readingLine(sources) {
    if (!sources.length) return null;
    const wrap = el("div", "reading");
    const stack = el("div", "stack");
    sources.slice(0, 6).forEach((s, i) => {
      const b = el("button");
      b.type = "button";
      b.style.backgroundImage = `url("${thumbUrl(s.deck_id, s.page)}")`;
      b.style.animationDelay = `${i * 80}ms`;
      b.title = `${s.deck_name}, slide ${s.page}`;
      b.setAttribute("aria-label", `Open ${s.deck_name}, slide ${s.page}`);
      b.addEventListener("click", () => openViewer(s.deck_id, s.page));
      stack.appendChild(b);
    });
    const decks = [...new Set(sources.map((s) => s.deck_name))];
    const pages = sources.map((s) => s.page).sort((a, b) => a - b);
    const label = decks.length > 1 ? `${sources.length} slides from ${decks.length} lectures`
      : pages.length > 6 ? `${decks[0]}, all ${pages.length} slides`
      : `${decks[0]}, ${pages.length === 1 ? "slide" : "slides"} ${listJoin(pages.map(String))}`;
    wrap.append(stack, el("span", null, esc(label)));
    return wrap;
  }

  function setBusy(b) {
    state.busy = b;
    sendBtn.classList.toggle("busy", b);
    updateSend();
    $$("#actions .chip").forEach((c) => (c.disabled = b));
  }
  const updateSend = () => { sendBtn.disabled = state.busy || !input.value.trim(); };

  async function send(text, opts = {}) {
    if (state.busy) return;
    const message = (text || "").trim();
    if (!message && opts.action !== "summary") return;
    addUser(opts.label || message);
    const a = addAssistant();
    setBusy(true);
    const body = {
      message, provider: state.provider, deck_id: opts.deckId ?? state.scope,
      history: state.history.slice(-8), focus: opts.focus || null, action: opts.action || null,
    };
    let sources = [], text_ = "", answer = null, seenCites = 0, frame = 0, learning = false;
    const paint = () => {
      frame = 0;
      if (!answer) return;
      const stick = nearBottom();
      const r = renderMarkdown(text_, sources, seenCites);
      answer.innerHTML = r.html;
      seenCites = r.cites;
      if (stick) scrollDown(true);
    };
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "The server didn't answer.");
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          const ev = JSON.parse(line);
          if (ev.type === "sources") {
            sources = ev.sources;
            a.body.innerHTML = "";
            const r = readingLine(sources);
            if (r) a.body.appendChild(r);
            a.body.appendChild(el("div", "thinking", `<span class="dots"><i></i><i></i><i></i></span><span class="shimmer">${state.provider === "gemini" ? "Gemini is thinking" : "Thinking"}</span>`));
            scrollDown(true);
          } else if (ev.type === "token") {
            if (!answer) {
              $(".thinking", a.body)?.remove();
              answer = el("div", "answer streaming");
              a.body.appendChild(answer);
            }
            text_ += ev.text;
            if (!frame) frame = requestAnimationFrame(paint);
          } else if (ev.type === "error") {
            throw new Error(ev.message);
          } else if (ev.type === "done") {
            learning = ev.learning;
          }
        }
      }
      if (frame) cancelAnimationFrame(frame);
      paint();
      answer?.classList.remove("streaming");
      if (!text_.trim()) throw new Error("The model returned an empty answer. Try asking again.");
      state.history.push({ role: "user", content: message }, { role: "assistant", content: text_ });
      if (learning) watchMemories();
    } catch (err) {
      $(".thinking", a.body)?.remove();
      answer?.classList.remove("streaming");
      a.body.appendChild(el("p", "error-line", inlineCode(err.message || String(err))));
      loadStatus();
    } finally {
      a.done();
      setBusy(false);
      scrollDown();
    }
  }

  thread.addEventListener("click", (e) => {
    const c = e.target.closest(".cite");
    if (c) openViewer(c.dataset.deck, +c.dataset.page);
  });

  $("#composer").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = input.value;
    if (!v.trim() || state.busy) return;
    input.value = "";
    autosize();
    send(v);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
  });
  function autosize() {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 220) + "px";
    updateSend();
  }
  input.addEventListener("input", autosize);

  // ---------------------------------------------------- quick actions --
  function pickDeckOrWarn() {
    if (state.scope) return state.scope;
    const ready = state.decks.filter((d) => d.status === "ready");
    if (ready.length === 1) return ready[0].id;
    if (!ready.length) { toast("Add a lecture PDF first."); return null; }
    toast("Pick a lecture first.");
    openScopeMenu();
    return null;
  }
  function runAction(action) {
    if (state.busy) return;
    if (action === "summary") {
      const id = pickDeckOrWarn();
      if (id) send("", { action: "summary", deckId: id, label: `Summarize ${deckName(id)}` });
    } else if (action === "quiz") {
      if (!state.decks.some((d) => d.status === "ready")) return toast("Add a lecture PDF first.");
      startQuiz("deck");
    } else if (action === "weak") {
      startQuiz("weak");
    } else if (action === "revise") {
      send("Based on what you know about me and my slides, what should I revise first, and why?", { label: "What should I revise first?" });
    }
  }
  $("#actions").addEventListener("click", (e) => { const b = e.target.closest("[data-action]"); if (b) runAction(b.dataset.action); });

  // ============================================================= quiz ==

  async function startQuiz(mode) {
    if (state.busy) return;
    const scope = state.scope;
    addUser(mode === "weak" ? "Quiz my weak spots" : `Quiz me on ${scope ? deckName(scope) : "all my lectures"}`);
    const a = addAssistant(mode === "weak" ? "Looking at what you've found hard" : "Writing your questions");
    setBusy(true);
    try {
      const { questions } = await api("/api/quiz", { method: "POST", body: JSON.stringify({ mode, deck_id: scope, provider: state.provider, count: 5 }) });
      a.body.innerHTML = "";
      a.body.appendChild(quizCard(questions));
      scrollDown(true);
    } catch (err) {
      a.body.innerHTML = "";
      a.body.appendChild(el("p", "error-line", inlineCode(err.message)));
    } finally {
      a.done();
      setBusy(false);
    }
  }

  function quizCard(questions) {
    const card = el("div", "quiz glass");
    const results = [];
    let i = 0;
    const pips = () => questions.map((_, k) => {
      const r = results[k];
      return `<i class="${r ? (r.correct ? "right" : "wrong") : k === i ? "now" : ""}"></i>`;
    }).join("");

    function show() {
      const q = questions[i];
      card.innerHTML = `
        <div class="quiz-progress"><span>Question ${i + 1} of ${questions.length}</span><span class="quiz-pips">${pips()}</span></div>
        <p class="quiz-q enter">${mdInline(q.question)}</p>
        <div class="options"></div>
        <div class="quiz-why"><div><p></p></div></div>
        <div class="quiz-foot"><span class="quiz-src"></span><span class="quiz-next"></span></div>`;
      q.options.forEach((o, k) => {
        const b = el("button", "option", `<span class="letter">${"ABCD"[k]}</span><span>${mdInline(o)}</span>`);
        b.type = "button";
        b.addEventListener("click", () => answer(k));
        $(".options", card).appendChild(b);
      });
    }

    function answer(k) {
      const q = questions[i];
      const correct = k === q.answer;
      results[i] = { question: q.question, chosen: q.options[k], answer: q.options[q.answer], correct };
      $$(".option", card).forEach((b, j) => {
        b.disabled = true;
        b.classList.add(j === q.answer ? "right" : j === k ? "wrong" : "faded");
      });
      $(".quiz-pips", card).innerHTML = pips();
      const why = $(".quiz-why", card);
      $("p", why).innerHTML = `<strong>${correct ? "Right." : "Not quite."}</strong> ${mdInline(q.explanation || "")}`;
      requestAnimationFrame(() => why.classList.add("open"));
      if (q.source) {
        const s = el("button", "linkish");
        s.type = "button";
        s.textContent = `See ${shortName(q.source.deck_name)}, slide ${q.source.page}`;
        s.addEventListener("click", () => openViewer(q.source.deck_id, q.source.page));
        $(".quiz-src", card).appendChild(s);
      }
      const next = el("button", "primary");
      next.type = "button";
      next.textContent = i + 1 < questions.length ? "Next question" : "See my score";
      next.addEventListener("click", () => { i++; i < questions.length ? show() : finish(); });
      $(".quiz-next", card).appendChild(next);
      next.focus({ preventScroll: true });
      setTimeout(() => scrollDown(), 60);
    }

    function finish() {
      const right = results.filter((r) => r.correct).length;
      const missed = results.length - right;
      card.innerHTML = `
        <div class="quiz-progress"><span>Done</span><span class="quiz-pips">${pips()}</span></div>
        <p class="quiz-score">${right} of ${results.length} right</p>
        <p class="muted" style="margin:0">${missed ? `I've noted the ${missed === 1 ? "one" : missed} you missed, so your weak-spots quiz will come back to ${missed === 1 ? "it" : "them"}.` : "Clean sweep. I'll remember you've got this."}</p>
        <div class="quiz-foot"><span></span><span><button type="button" class="primary" data-again>Another quiz</button></span></div>`;
      $("[data-again]", card).addEventListener("click", () => startQuiz(missed ? "weak" : "deck"));
      api("/api/quiz/finish", { method: "POST", body: JSON.stringify({ results }) })
        .then((r) => { if (r.learning) watchMemories(); }).catch(() => {});
    }

    show();
    return card;
  }

  // ============================================================ panel ==

  function openPanel(which) {
    state.panel = which;
    $("#viewer").hidden = which !== "viewer";
    $("#memoryPanel").hidden = which !== "memory";
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    document.body.classList.add("panel-open");
    $("#memoryBtn").setAttribute("aria-expanded", String(which === "memory"));
  }
  function closePanel() {
    state.panel = null;
    panel.classList.remove("open");
    panel.setAttribute("aria-hidden", "true");
    document.body.classList.remove("panel-open");
    $("#memoryBtn").setAttribute("aria-expanded", "false");
  }
  $$("[data-close]").forEach((b) => b.addEventListener("click", closePanel));

  // ----------------------------------------------------- slide viewer --
  const deckCache = {};
  async function openViewer(deckId, page) {
    let data = deckCache[deckId];
    if (!data) {
      try {
        data = await api(`/api/decks/${deckId}`);
        if (data.deck.status === "ready") deckCache[deckId] = data;
      } catch (err) { return toast(err.message); }
    }
    const v = state.viewer;
    const fresh = v.deck?.id !== deckId || state.panel !== "viewer";
    v.deck = data.deck;
    v.pages = data.pages;
    openPanel("viewer");
    $("#viewerTitle").textContent = deckName(deckId);
    if (fresh) buildStrip();
    goTo(Math.max(0, Math.min(v.pages.length - 1, page - 1)), 0);
  }
  function buildStrip() {
    const v = state.viewer, strip = $("#strip");
    strip.innerHTML = "";
    v.pages.forEach((p, k) => {
      const b = el("button", null, `<img loading="lazy" alt="" src="${thumbUrl(v.deck.id, p.page)}"><span>${p.page}</span>`);
      b.type = "button";
      b.setAttribute("aria-label", `Slide ${p.page}`);
      b.addEventListener("click", () => goTo(k, k > v.i ? 1 : -1));
      strip.appendChild(b);
    });
  }
  function goTo(k, dir) {
    const v = state.viewer;
    if (!v.pages.length) return;
    v.i = k;
    const p = v.pages[k];
    const img = $("#stageImg");
    img.classList.remove("turn-next", "turn-prev");
    void img.offsetWidth;
    if (dir) img.classList.add(dir > 0 ? "turn-next" : "turn-prev");
    img.src = pageUrl(v.deck.id, p.page);
    img.alt = `${v.deck.name}, slide ${p.page}`;
    $("#viewerPage").textContent = `Slide ${p.page} of ${v.pages.length}`;
    $("#prevSlide").disabled = k === 0;
    $("#nextSlide").disabled = k === v.pages.length - 1;
    $$("#strip button").forEach((b, j) => {
      b.setAttribute("aria-current", String(j === k));
      if (j === k) b.scrollIntoView({ block: "nearest", behavior: reduceMotion() ? "auto" : "smooth" });
    });
  }
  $("#prevSlide").addEventListener("click", () => state.viewer.i > 0 && goTo(state.viewer.i - 1, -1));
  $("#nextSlide").addEventListener("click", () => state.viewer.i < state.viewer.pages.length - 1 && goTo(state.viewer.i + 1, 1));
  $("#explainSlide").addEventListener("click", () => {
    const v = state.viewer, page = v.pages[v.i]?.page;
    if (!page || state.busy) return;
    setView("chat");
    if (innerWidth < 1180) closePanel();
    send(`Explain slide ${page} of "${v.deck.name}" to me.`, { focus: { deck_id: v.deck.id, page }, deckId: v.deck.id, label: `Explain slide ${page} of ${v.deck.name}` });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!scopeMenu.hidden) return closeScopeMenu();
      if (!gModal.hidden) return closeGeminiModal();
      if (state.panel) return closePanel();
    }
    if (state.panel !== "viewer" || /INPUT|TEXTAREA/.test(document.activeElement?.tagName)) return;
    if (e.key === "ArrowRight") $("#nextSlide").click();
    if (e.key === "ArrowLeft") $("#prevSlide").click();
  });

  // =========================================================== memory ==

  async function loadMemories() {
    let data;
    try { data = await api("/api/memories"); } catch { return null; }
    const prev = state.knownMemoryIds;
    const prevText = new Map(state.memories.map((m) => [m.id, m.memory]));
    state.memories = data.memories;
    const fresh = new Set();
    if (prev) data.memories.forEach((m) => { if (!prev.has(m.id) || prevText.get(m.id) !== m.memory) fresh.add(m.id); });
    state.knownMemoryIds = new Set(data.memories.map((m) => m.id));
    $("#memoryCount").textContent = data.memories.length;
    $("#memoryMeta").textContent = data.error ? `Last update failed: ${data.error}`
      : data.backend === "mem0" ? "Learned from our chats and quizzes, stored with Mem0." : "Learned from our chats and your quizzes.";
    renderMemories(fresh);
    return { data, fresh };
  }
  function renderMemories(fresh = new Set()) {
    const ul = $("#memories");
    ul.innerHTML = "";
    state.memories.forEach((m, k) => {
      const li = el("li", fresh.has(m.id) ? "fresh" : "");
      li.style.animationDelay = `${Math.min(k, 12) * 35}ms`;
      const t = el("span", "text");
      t.textContent = m.memory;
      const b = el("button", null, ICON.x);
      b.type = "button";
      b.setAttribute("aria-label", "Forget this");
      b.addEventListener("click", async () => {
        li.classList.add("leaving");
        await api(`/api/memories/${encodeURIComponent(m.id)}`, { method: "DELETE" }).catch(() => {});
        setTimeout(loadMemories, 320);
      });
      li.append(t, b);
      ul.appendChild(li);
    });
    $("#memoriesEmpty").hidden = state.memories.length > 0;
    $("#forgetAll").hidden = state.memories.length === 0;
  }

  let watchTimer = null, watchUntil = 0;
  function watchMemories() {
    watchUntil = Date.now() + 4 * 60 * 1000;
    $("#learning").hidden = false;
    if (watchTimer) return;
    const tick = async () => {
      const r = await loadMemories();
      if (r?.fresh.size) {
        const btn = $("#memoryBtn");
        btn.classList.remove("learned"); void btn.offsetWidth; btn.classList.add("learned");
        const newest = r.data.memories.find((m) => r.fresh.has(m.id));
        if (state.panel !== "memory") toast(r.fresh.size === 1 && newest ? `Noted: ${newest.memory}` : `Learned ${r.fresh.size} things about you`, 4500);
      }
      if ((r && r.data.pending === 0) || Date.now() > watchUntil) {
        watchTimer = null;
        $("#learning").hidden = true;
        return;
      }
      watchTimer = setTimeout(tick, 2500);
    };
    watchTimer = setTimeout(tick, 1500);
  }
  $("#memoryBtn").addEventListener("click", () => {
    if (state.panel === "memory") return closePanel();
    openPanel("memory");
    loadMemories();
  });
  let forgetArmed = false;
  $("#forgetAll").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    if (!forgetArmed) {
      forgetArmed = true;
      b.textContent = "Click again to forget everything";
      setTimeout(() => { forgetArmed = false; b.textContent = "Forget everything"; }, 3500);
      return;
    }
    forgetArmed = false;
    b.textContent = "Forget everything";
    $$("#memories li").forEach((li, k) => { li.style.animationDelay = `${k * 30}ms`; li.classList.add("leaving"); });
    await api("/api/memories", { method: "DELETE" }).catch(() => {});
    setTimeout(loadMemories, 450);
  });

  // ============================================================= boot ==

  new SmoothCaret(input, $(".field", $("#composer")));
  new SmoothCaret(keyInput, $("#keyWrap"));
  setMode(state.provider);
  placeTabThumb();
  updateGreeting();
  loadStatus();
  loadDecks();
  loadMemories();
  updateSend();
  setInterval(loadStatus, 30000);
  input.focus();
})();
