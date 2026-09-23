// DeepSeek Harness — shared headful-browser widget (injected client script).
// Primary rendering: binary JPEG frames over the WS (hardware-decoded via
// createImageBitmap) for low latency; WS also carries status, live cursor and
// instant input-echo feedback, so input registers visually before the next
// frame arrives.
//
// 2.1.0 — Edge-style layout (tab strip + nav bar), draggable FAB, back/forward
// + history, watch-only / operate mode split, resizable panel (viewport follows).
(function () {
  "use strict";
  if (globalThis.__DSH_BROWSER_WIDGET__) return;
  globalThis.__DSH_BROWSER_WIDGET__ = true;

  const MODS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
  const BIN_FRAME = 1;
  const HOME_URL = "https://www.bing.com";
  const PANEL_MIN_W = 420;
  const PANEL_MIN_H = 340;
  const DRAG_THRESHOLD = 4; // px of pointer travel before a FAB drag counts

  let ws;
  let reconnectTimer = null;
  let connected = false;
  let running = false;
  let vw = 1280;
  let vh = 800;
  let lastClick = { t: 0, x: -1, y: -1 };
  let frameCounter = 0;
  let fpsStart = 0;
  let decodeBusy = false;
  let gotFirstFrame = false;
  let cursorVisible = false;
  let cursorVp = null; // last known remote pointer position (viewport coords)
  let viewMode = "view"; // "view" = watch-only | "operate" = user drives
  let canGoBack = false;
  let canGoForward = false;

  // ---------- DOM ----------
  const root = document.createElement("div");
  root.id = "dsh-browser-widget-root";
  root.innerHTML = `
    <style>
      #dsh-browser-widget-root { all: initial; position: fixed; z-index: 2147483000; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif; }
      #dsh-browser-widget-root * { box-sizing: border-box; }
      .dbw-fab { position: fixed; right: 18px; bottom: 18px; width: 56px; height: 56px; border-radius: 16px; background: linear-gradient(135deg, #4f7cff, #7b61ff); color: #fff; border: 1px solid rgba(255,255,255,.25); box-shadow: 0 8px 24px rgba(0,0,0,.35); cursor: pointer; display: flex; align-items: center; justify-content: center; font-size: 24px; transition: transform .15s ease; z-index: 2147483001; touch-action: none; user-select: none; }
      .dbw-fab:hover { transform: scale(1.06); }
      .dbw-fab.dragging { transition: none; transform: scale(1.12); cursor: grabbing; }
      .dbw-fab .dbw-dot { position: absolute; top: 8px; right: 8px; width: 10px; height: 10px; border-radius: 50%; background: #28c840; border: 2px solid #fff; }
      .dbw-fab .dbw-dot.off { background: #ff5b5b; }
      .dbw-panel { position: fixed; right: 18px; bottom: 86px; width: min(880px, calc(100vw - 36px)); height: min(600px, calc(100vh - 140px)); background: #14171f; border: 1px solid rgba(255,255,255,.14); border-radius: 16px; box-shadow: 0 24px 80px rgba(0,0,0,.55); display: none; flex-direction: column; overflow: hidden; color: #e8eaf0; }
      .dbw-panel.open { display: flex; }
      .dbw-panel.max { width: calc(100vw - 24px); height: calc(100vh - 24px); right: 12px; bottom: 12px; }
      /* title bar (drag handle) */
      .dbw-head { display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(255,255,255,.04); border-bottom: 1px solid rgba(255,255,255,.08); cursor: move; user-select: none; touch-action: none; flex: 0 0 auto; }
      .dbw-head .dbw-brand { font-size: 13px; font-weight: 700; letter-spacing: .3px; white-space: nowrap; }
      .dbw-head .dbw-brand em { font-style: normal; color: #7ea6ff; }
      .dbw-chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.05); white-space: nowrap; }
      .dbw-chip.on { color: #7dffa8; border-color: rgba(125,255,168,.4); }
      .dbw-chip.off { color: #ff9b9b; border-color: rgba(255,155,155,.4); }
      .dbw-head .dbw-link { flex: 1; font-size: 11px; color: #9aa3b5; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
      .dbw-btn { border: 0; background: rgba(255,255,255,.08); color: #e8eaf0; border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
      .dbw-btn:hover { background: rgba(255,255,255,.16); }
      .dbw-btn.primary { background: linear-gradient(135deg, #4f7cff, #7b61ff); }
      .dbw-btn.danger { background: rgba(255,91,91,.22); color: #ffb4b4; }
      /* Edge-style tab strip (row 1) */
      .dbw-tabs { display: none; gap: 6px; padding: 6px 12px 4px; overflow-x: auto; align-items: center; background: rgba(13,17,28,.35); border-bottom: 1px solid rgba(255,255,255,.06); flex: 0 0 auto; }
      .dbw-tabs::-webkit-scrollbar { height: 4px; }
      .dbw-tab { flex: 0 0 auto; max-width: 200px; padding: 5px 10px; border-radius: 8px 8px 0 0; border: 1px solid rgba(255,255,255,.12); border-bottom: 0; background: rgba(255,255,255,.05); color: #b9c2d4; font-size: 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; overflow: hidden; }
      .dbw-tab .label { flex: 1 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dbw-tab .x { flex: 0 0 auto; opacity: .55; font-size: 11px; padding: 0 2px; }
      .dbw-tab:hover { background: rgba(255,255,255,.12); }
      .dbw-tab.active { background: #20242e; color: #eef2fa; border-color: rgba(255,255,255,.22); font-weight: 700; }
      .dbw-tab .x { opacity: .55; font-size: 11px; padding: 0 2px; }
      .dbw-tab .x:hover { opacity: 1; }
      .dbw-tab.new { background: transparent; border-style: dashed; border-radius: 8px; border-bottom: 1px dashed rgba(255,255,255,.25); }
      /* Edge-style navigation bar (row 2) */
      .dbw-navbar { display: flex; gap: 6px; padding: 8px 12px; align-items: center; flex: 0 0 auto; }
      .dbw-navbtn { border: 0; background: transparent; color: #cfd6e6; border-radius: 8px; min-width: 30px; height: 32px; font-size: 15px; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0 6px; }
      .dbw-navbtn:hover:not(:disabled) { background: rgba(255,255,255,.12); }
      .dbw-navbtn:disabled { opacity: .35; cursor: default; }
      .dbw-navbtn.danger { color: #ffb4b4; }
      .dbw-navbtn.primary { background: linear-gradient(135deg, #4f7cff, #7b61ff); color: #fff; font-size: 12px; }
      .dbw-urlbox { flex: 1; display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12); border-radius: 99px; padding: 0 10px; height: 32px; min-width: 80px; }
      .dbw-urlbox:focus-within { border-color: #4f7cff; background: rgba(79,124,255,.08); }
      .dbw-siteicon { font-size: 12px; width: 16px; text-align: center; flex: 0 0 auto; }
      .dbw-url { flex: 1; background: transparent; border: 0; color: #e8eaf0; font-size: 13px; outline: none; min-width: 0; }
      .dbw-urlgo { border: 0; background: transparent; color: #9db6ff; font-size: 14px; cursor: pointer; padding: 2px 4px; border-radius: 6px; }
      .dbw-urlgo:hover { background: rgba(255,255,255,.12); }
      .dbw-modebtn { border: 1px solid rgba(255,255,255,.2); border-radius: 99px; height: 32px; padding: 0 12px; font-size: 12px; cursor: pointer; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
      .dbw-modebtn.view { background: rgba(255,255,255,.08); color: #b9c2d4; }
      .dbw-modebtn.operate { background: linear-gradient(135deg, #2ea06a, #37d67a); color: #06231a; font-weight: 700; }
      /* history dropdown */
      .dbw-hmenu { position: absolute; right: 12px; top: 96px; z-index: 8; width: 320px; max-height: 260px; overflow-y: auto; background: #1c212c; border: 1px solid rgba(255,255,255,.15); border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,.5); }
      .dbw-hmenu[hidden] { display: none; }
      .dbw-hitem { display: flex; flex-direction: column; gap: 2px; padding: 8px 12px; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,.06); }
      .dbw-hitem:hover { background: rgba(79,124,255,.15); }
      .dbw-hitem.current { background: rgba(79,124,255,.12); border-left: 3px solid #4f7cff; }
      .dbw-hitem .t { font-size: 12px; color: #e8eaf0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .dbw-hitem .u { font-size: 11px; color: #7f89a3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
      .dbw-hitem.empty { cursor: default; color: #7f89a3; }
      /* stage */
      .dbw-stage { flex: 1; position: relative; background: repeating-conic-gradient(#0b0d12 0% 25%, #10131b 0% 50%) 0 0 / 22px 22px; overflow: hidden; touch-action: none; min-height: 120px; }
      .dbw-surface { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); image-rendering: auto; outline: none; cursor: crosshair; display: block; background: #000; }
      .dbw-canvas { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); image-rendering: auto; outline: none; cursor: crosshair; display: none; }
      .dbw-placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; color: #66708a; font-size: 13px; }
      .dbw-placeholder.done { display: none; }
      .dbw-bigicon { font-size: 44px; opacity: .7; }
      /* watch-only mode: NO overlay / NO blur — the page stays fully visible
         and usable to look at; the mode state lives on the nav-bar toggle only */
      .dbw-canvas.dbw-readonly { cursor: not-allowed; }
      .dbw-foot { padding: 6px 12px; font-size: 11px; color: #77809a; border-top: 1px solid rgba(255,255,255,.07); display: flex; justify-content: space-between; gap: 10px; flex: 0 0 auto; }
      .dbw-statusbar { display: flex; gap: 12px; }
      .dbw-toast { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); background: #1e2430; border: 1px solid rgba(255,255,255,.15); color: #dfe5f2; padding: 6px 12px; border-radius: 8px; font-size: 12px; max-width: 70%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 5; }
      .dbw-toast.show { opacity: 1; }
      .dbw-cursor { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 3; opacity: 0; filter: drop-shadow(0 1px 2px rgba(0,0,0,.9)); }
      .dbw-cursor.show { opacity: 1; }
      .dbw-ripple { position: absolute; left: 0; top: 0; width: 34px; height: 34px; margin: -17px 0 0 -17px; border: 2.5px solid rgba(90,150,255,.95); border-radius: 50%; transform: scale(.25); opacity: 0; pointer-events: none; z-index: 4; box-shadow: 0 0 0 1px rgba(0,0,0,.35); }
      .dbw-ripple.pop { animation: dbw-ripple-anim .5s ease-out forwards; }
      @keyframes dbw-ripple-anim { 0% { transform: scale(.25); opacity: 1; } 100% { transform: scale(1.9); opacity: 0; } }
      .dbw-keyflash { position: absolute; left: 50%; bottom: 40px; transform: translateX(-50%); background: rgba(79,124,255,.92); color: #fff; border-radius: 8px; padding: 4px 10px; font-size: 12px; font-weight: 600; opacity: 0; pointer-events: none; z-index: 5; box-shadow: 0 4px 12px rgba(0,0,0,.4); transition: opacity .12s; }
      .dbw-keyflash.show { opacity: 1; }
      .dbw-spinner { position: absolute; inset: 0; display: none; align-items: center; justify-content: center; color: #9aa8c8; font-size: 13px; z-index: 2; pointer-events: none; }
      .dbw-spinner.show { display: flex; }
      /* resize handles */
      .dbw-grip { position: absolute; right: 0; bottom: 0; width: 18px; height: 18px; z-index: 9; cursor: nwse-resize; opacity: 0; }
      .dbw-grip::after { content: ""; position: absolute; right: 3px; bottom: 3px; width: 9px; height: 9px; border-right: 2px solid rgba(255,255,255,.5); border-bottom: 2px solid rgba(255,255,255,.5); border-radius: 0 0 3px 0; }
      .dbw-gedge-r { position: absolute; top: 0; right: 0; width: 7px; height: 100%; z-index: 9; cursor: ew-resize; }
      .dbw-gedge-b { position: absolute; left: 0; bottom: 0; width: 100%; height: 7px; z-index: 9; cursor: ns-resize; }
      .dbw-panel:hover .dbw-grip { opacity: 1; }
      @media (prefers-color-scheme: light) {
        .dbw-panel { background: #f4f6fb; border-color: rgba(20,23,31,.15); color: #20242e; }
        .dbw-head { background: rgba(20,23,31,.04); }
        .dbw-chip.off { color: #c0392b; border-color: rgba(192,57,43,.4); }
        .dbw-chip.on { color: #1e8449; border-color: rgba(30,132,73,.45); }
        .dbw-link { color: #5a647c; }
        .dbw-btn { background: rgba(20,23,31,.08); color: #20242e; }
        .dbw-url { color: #20242e; }
        .dbw-urlbox { background: #fff; border-color: rgba(20,23,31,.2); }
        .dbw-navbtn { color: #3a4154; }
        .dbw-tab { color: #4a5268; background: rgba(20,23,31,.05); }
        .dbw-tab.active { background: #fff; color: #10131b; }
        .dbw-stage { background: repeating-conic-gradient(#e8ebf3 0% 25%, #dde1ec 0% 50%) 0 0 / 22px 22px; }
        .dbw-foot { color: #6a7290; border-color: rgba(20,23,31,.08); }
        .dbw-placeholder { color: #8a92aa; }
        .dbw-hmenu { background: #fff; }
        .dbw-hitem .t { color: #20242e; }
      }
    </style>
    <button class="dbw-fab" title="打开/收起共享浏览器面板（可拖动）">🌐<span class="dbw-dot off"></span></button>
    <div class="dbw-panel">
      <div class="dbw-head">
        <span class="dbw-brand">🖥️ 共享浏览器 <em>Shared Browser</em></span>
        <span class="dbw-chip off" data-role="state">未连接</span>
        <span class="dbw-chip" data-role="display">—</span>
        <span class="dbw-link" data-role="link"></span>
        <button class="dbw-btn" data-role="max" title="最大化 / 还原">⛶</button>
        <button class="dbw-btn" data-role="close" title="收起面板">✕</button>
      </div>
      <div class="dbw-tabs" data-role="tabs"></div>
      <div class="dbw-navbar">
        <button class="dbw-navbtn" data-role="back" title="后退" disabled>←</button>
        <button class="dbw-navbtn" data-role="forward" title="前进" disabled>→</button>
        <button class="dbw-navbtn" data-role="refresh" title="刷新" disabled>⟳</button>
        <button class="dbw-navbtn" data-role="home" title="主页" disabled>🏠</button>
        <div class="dbw-urlbox">
          <span class="dbw-siteicon" data-role="siteicon">🌐</span>
          <input class="dbw-url" data-role="url" placeholder="输入网址，回车打开" spellcheck="false" autocomplete="off" />
          <button class="dbw-urlgo" data-role="go" title="打开" disabled>➜</button>
        </div>
        <button class="dbw-navbtn" data-role="start" title="启动共享浏览器">▶</button>
        <button class="dbw-navbtn" data-role="hist" title="历史记录" disabled>🕘</button>
        <button class="dbw-modebtn view" data-role="mode" title="切换操作模式">👁 仅观看</button>
        <button class="dbw-navbtn" data-role="shot" title="截图" disabled>📷</button>
        <button class="dbw-navbtn danger" data-role="stop" title="紧急关闭浏览器" disabled>⏹</button>
      </div>
      <div class="dbw-hmenu" data-role="hmenu" hidden></div>
      <div class="dbw-stage" data-role="stage">
        <canvas class="dbw-canvas" data-role="canvas" tabindex="0"></canvas>
        <div class="dbw-placeholder" data-role="placeholder">
          <span class="dbw-bigicon">🕸️</span>
          <span data-role="ph-text">未启动浏览器 —— 点击「▶ 启动」或让 Agent 执行 browser_launch</span>
        </div>
        <div class="dbw-spinner" data-role="spinner">⏳ 正在连接画面…</div>
        <div class="dbw-cursor" data-role="cursor"><svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1 L2 14.5 L5.6 11.4 L8.2 16.2 L10.1 15.2 L7.6 10.6 L12.4 10.8 Z" fill="#ffffff" stroke="#1a1f2e" stroke-width="1.2"/></svg></div>
        <div class="dbw-ripple" data-role="ripple"></div>
        <div class="dbw-keyflash" data-role="keyflash"></div>
        <div class="dbw-toast" data-role="toast"></div>
      </div>
      <div class="dbw-grip" data-role="grip" title="拖动拉伸窗口"></div>
      <div class="dbw-gedge-r" data-role="gedge-r"></div>
      <div class="dbw-gedge-b" data-role="gedge-b"></div>
      <div class="dbw-foot">
        <span>💡 你与 Agent 正在操作同一个浏览器实例</span>
        <span class="dbw-statusbar"><span data-role="fps"></span><span data-role="clients"></span></span>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const $ = (sel) => root.querySelector(sel);
  const fab = root.querySelector(".dbw-fab");
  const panel = root.querySelector(".dbw-panel");
  const canvas = root.querySelector(".dbw-canvas");
  const ctx2d = canvas.getContext("2d");
  const stage = root.querySelector(".dbw-stage");
  const urlInput = root.querySelector(".dbw-url");
  const toastEl = root.querySelector(".dbw-toast");
  const tabsEl = root.querySelector('[data-role="tabs"]');
  const chipState = root.querySelector('[data-role="state"]');
  const chipDisplay = root.querySelector('[data-role="display"]');
  const chipLink = root.querySelector('[data-role="link"]');
  const chipMode = root.querySelector('[data-role="fps"]');
  const chipClients = root.querySelector('[data-role="clients"]');
  const placeholder = root.querySelector('[data-role="placeholder"]');
  const phText = root.querySelector('[data-role="ph-text"]');
  const spinner = root.querySelector('[data-role="spinner"]');
  const cursorEl = root.querySelector('[data-role="cursor"]');
  const rippleEl = root.querySelector('[data-role="ripple"]');
  const keyflashEl = root.querySelector('[data-role="keyflash"]');
  const backBtn = root.querySelector('[data-role="back"]');
  const fwdBtn = root.querySelector('[data-role="forward"]');
  const refreshBtn = root.querySelector('[data-role="refresh"]');
  const homeBtn = root.querySelector('[data-role="home"]');
  const goBtn = root.querySelector('[data-role="go"]');
  const histBtn = root.querySelector('[data-role="hist"]');
  const modeBtn = root.querySelector('[data-role="mode"]');
  const shotBtn = root.querySelector('[data-role="shot"]');
  const stopBtn = root.querySelector('[data-role="stop"]');
  const startBtn = root.querySelector('[data-role="start"]');
  const siteIcon = root.querySelector('[data-role="siteicon"]');
  const hmenu = root.querySelector('[data-role="hmenu"]');

  let toastTimer = null;
  let keyflashTimer = null;
  let resizeTimer = null;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2600);
  }

  // ---------- WebSocket ----------
  function wsUrl() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/browser/ws`;
  }

  function connect() {
    clearTimeout(reconnectTimer);
    try {
      ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer"; // must be set right after construction
    } catch {
      scheduleReconnect();
      return;
    }
    ws.onopen = () => {
      connected = true;
      setStateChip();
      ws.send(JSON.stringify({ type: "hello" }));
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        handleMessage(msg);
      } else {
        handleBinary(event.data);
      }
    };
    ws.onclose = () => {
      connected = false;
      setStateChip();
      scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
    };
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  }

  function send(obj) {
    // debug/assert hook: last outbound input message
    try {
      globalThis.__DBW_LAST_SENT__ = obj;
    } catch {
      /* ignore */
    }
    if (ws && ws.readyState === 1) {
      try {
        ws.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    }
  }

  // ---------- rendering (binary JPEG frames over WS) -------------------------
  async function handleBinary(raw) {
    // Browser WebSocket may deliver binary frames as ArrayBuffer or Blob
    // (depending on binaryType support); node clients send Buffer. Handle all.
    let buf = raw;
    if (buf instanceof Blob) {
      try {
        buf = await buf.arrayBuffer();
      } catch {
        return;
      }
    }
    if (!(buf instanceof ArrayBuffer)) return;
    const view = new Uint8Array(buf); // ArrayBuffer has no index access; use a view
    if (buf.byteLength < 9 || view[0] !== BIN_FRAME) return;
    // debug/assert probe
    try {
      const st = (globalThis.__DBW_BIN_STATS__ = globalThis.__DBW_BIN_STATS__ || { calls: 0, len: 0, first: -1 });
      st.calls++;
      st.len = buf.byteLength;
      st.first = view[0];
    } catch {
      /* ignore */
    }
    const dv = new DataView(buf);
    const w = dv.getUint32(1);
    const h = dv.getUint32(5);
    vw = w;
    vh = h;
    frameCounter++;
    if (fpsStart === 0) fpsStart = Date.now();
    if (frameCounter % 15 === 0) {
      const fps = Math.round(frameCounter / ((Date.now() - fpsStart) / 1000));
      chipMode.textContent = `⚡ ${fps} fps`;
    }
    if (decodeBusy) return; // drop stale frames while a decode is in flight
    decodeBusy = true;
    const jpeg = buf.slice(9);
    try {
      const bmp = await createImageBitmap(new Blob([jpeg], { type: "image/jpeg" }));
      if (!gotFirstFrame) {
        gotFirstFrame = true;
        spinner.classList.remove("show");
        placeholder.classList.add("done");
        canvas.style.display = "block"; // canvas starts display:none in CSS
      }
      canvas.width = w;
      canvas.height = h;
      const layoutChanged = layoutCanvas(w, h); // cached rects: no forced reflow
      if (layoutChanged) placeCursor(); // only re-anchor when geometry actually changed
      ctx2d.drawImage(bmp, 0, 0, w, h);
      bmp.close();
    } catch {
      /* skip frame */
    } finally {
      decodeBusy = false;
    }
  }

  function renderTabs(tabs, activeId) {
    const list = tabs || [];
    tabsEl.innerHTML = "";
    for (const t of list) {
      const chip = document.createElement("button");
      chip.className = "dbw-tab" + (t.id === activeId ? " active" : "");
      chip.title = t.url || t.title || t.id;
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = (t.title || t.url || "空白标签").slice(0, 40);
      chip.appendChild(label);
      const x = document.createElement("span");
      x.className = "x";
      x.textContent = "✕";
      x.title = "关闭标签";
      x.addEventListener("click", (e) => {
        e.stopPropagation();
        send({ type: "tabs", command: "close", id: t.id });
      });
      chip.appendChild(x);
      chip.addEventListener("click", () => {
        if (t.id !== activeId) send({ type: "tabs", command: "activate", id: t.id });
      });
      tabsEl.appendChild(chip);
    }
    const plus = document.createElement("button");
    plus.className = "dbw-tab new";
    plus.textContent = "+ 新标签";
    plus.title = "新建空白标签";
    plus.addEventListener("click", () => send({ type: "tabs", command: "new", url: "about:blank" }));
    tabsEl.appendChild(plus);
    tabsEl.style.display = list.length > 0 ? "flex" : "none";
    // Tab bar changes the stage height -> re-fit the canvas so clicks stay accurate.
    layoutSurface();
  }

  function siteIconFor(url) {
    if (!url) return "🌐";
    if (url.startsWith("https:")) return "🔒";
    if (url.startsWith("http:")) return "🌐";
    if (url.startsWith("file:")) return "📄";
    if (url.startsWith("about:")) return "🛡";
    return "🌐";
  }

  function renderHistory(h) {
    const entries = h.entries || [];
    hmenu.innerHTML = "";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "dbw-hitem empty";
      empty.textContent = "（暂无历史记录）";
      hmenu.appendChild(empty);
    } else {
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        const item = document.createElement("div");
        item.className = "dbw-hitem" + (i === h.currentIndex ? " current" : "");
        item.title = e.url;
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = (e.title || e.url || "空白页").slice(0, 40);
        const u = document.createElement("span");
        u.className = "u";
        u.textContent = e.url || "";
        item.appendChild(t);
        item.appendChild(u);
        item.addEventListener("click", () => {
          hmenu.hidden = true;
          send({ type: "nav", command: "goto", entryId: e.id });
        });
        hmenu.appendChild(item);
      }
    }
    hmenu.hidden = false;
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case "status": {
        running = Boolean(msg.running);
        setStateChip();
        if (msg.title || msg.url) chipLink.textContent = `${msg.title || ""} — ${msg.url || ""}`;
        if (msg.viewport) {
          vw = msg.viewport.width;
          vh = msg.viewport.height;
        }
        if (msg.mode) applyMode(msg.mode);
        chipClients.textContent = msg.clients !== undefined ? `👥 ${msg.clients} 位观众` : "";
        const display = msg.headless ? "无头模式" : "有头模式";
        chipDisplay.textContent = msg.pid ? `${display} · PID ${msg.pid}` : "—";
        placeholder.classList.toggle("done", running);
        if (running) {
          chipMode.textContent = "⚡ 流畅流";
          send({ type: "tabs", command: "list" });
          send({ type: "nav", command: "history" });
        } else {
          gotFirstFrame = false;
          cursorVp = null;
          cursorEl.classList.remove("show");
          tabsEl.style.display = "none";
          phText.textContent = "浏览器已关闭 —— 点击「▶ 启动」或让 Agent 执行 browser_launch";
          ctx2d.clearRect(0, 0, canvas.width, canvas.height);
        }
        refreshNavButtons();
        break;
      }
      case "tabs":
      case "tabsResult": {
        renderTabs(msg.tabs, msg.activeId);
        break;
      }
      case "nav": {
        if (msg.command === "history") {
          renderHistory(msg);
          if (msg.entries && msg.entries.length > 0) {
            canGoBack = msg.currentIndex > 0;
            canGoForward = msg.currentIndex < msg.entries.length - 1;
          }
        } else {
          if (typeof msg.canGoBack === "boolean") canGoBack = msg.canGoBack;
          if (typeof msg.canGoForward === "boolean") canGoForward = msg.canGoForward;
        }
        refreshNavButtons();
        break;
      }
      case "title": {
        if (msg.url) {
          chipLink.textContent = `${msg.title || ""} — ${msg.url}`;
          if (urlInput.value === "" || urlInput.dataset.auto === "1") {
            urlInput.value = msg.url;
            urlInput.dataset.auto = "1";
          }
          siteIcon.textContent = siteIconFor(msg.url);
        }
        break;
      }
      case "notice": {
        toast(msg.text);
        break;
      }
      case "cursor": {
        cursorVp = { x: msg.x, y: msg.y };
        cursorVisible = true;
        placeCursor();
        break;
      }
      case "echo": {
        handleEcho(msg);
        break;
      }
      default:
        break;
    }
  }

  function handleEcho(msg) {
    if (msg.kind === "mouse") {
      if (msg.op === "mousePressed" || msg.op === "mouseReleased") {
        cursorVp = { x: msg.x, y: msg.y };
        placeCursor();
        const pos = toStage(msg.x, msg.y);
        rippleEl.style.left = pos.x + "px";
        rippleEl.style.top = pos.y + "px";
        rippleEl.classList.remove("pop");
        // force reflow so the animation restarts on every press
        void rippleEl.offsetWidth;
        rippleEl.classList.add("pop");
      }
    } else if (msg.kind === "key") {
      showKeyFlash(msg.key);
    } else if (msg.kind === "touch") {
      const p = (msg.points || [])[0];
      if (p) {
        cursorVp = { x: p.x, y: p.y };
        placeCursor();
        const pos = toStage(p.x, p.y);
        rippleEl.style.left = pos.x + "px";
        rippleEl.style.top = pos.y + "px";
        rippleEl.classList.remove("pop");
        void rippleEl.offsetWidth;
        rippleEl.classList.add("pop");
      }
    }
  }

  function showKeyFlash(key) {
    const label = key === " " ? "Space" : key.length === 1 ? key.toUpperCase() : key;
    keyflashEl.textContent = `⌨ ${label}`;
    keyflashEl.classList.add("show");
    clearTimeout(keyflashTimer);
    keyflashTimer = setTimeout(() => keyflashEl.classList.remove("show"), 380);
  }

  function setStateChip() {
    chipState.className = "dbw-chip " + (connected ? (running ? "on" : "") : "off");
    chipState.textContent = !connected ? "未连接" : running ? "● 已连接 · 运行中" : "已连接 · 未启动";
    fab.querySelector(".dbw-dot").classList.toggle("off", !(connected && running));
  }

  // ---------- mode (watch-only vs operate) ----------
  function applyMode(mode) {
    viewMode = mode === "operate" ? "operate" : "view";
    modeBtn.className = "dbw-modebtn " + viewMode;
    modeBtn.textContent = viewMode === "operate" ? "🖱 操作" : "👁 仅观看";
    modeBtn.title = viewMode === "operate" ? "当前为操作模式，点击切回仅观看" : "当前为仅观看模式，点击切换到操作模式";
    refreshNavButtons();
    layoutSurface();
  }

  function refreshNavButtons() {
    const canNav = running && viewMode !== "view";
    backBtn.disabled = !(canNav && canGoBack);
    fwdBtn.disabled = !(canNav && canGoForward);
    refreshBtn.disabled = !canNav;
    homeBtn.disabled = !canNav;
    goBtn.disabled = !canNav;
    urlInput.disabled = !canNav;
    histBtn.disabled = !canNav;
    shotBtn.disabled = !running;
    stopBtn.disabled = !running;
    startBtn.style.display = running ? "none" : "";
    // Watch-only: the page stays crystal-clear (no overlay); we only switch
    // the cursor and keep input-forwarding gated in the handlers below.
    canvas.classList.toggle("dbw-readonly", running && viewMode === "view");
  }

  // ---------- layout ----------
  // Cached geometry: reading getBoundingClientRect() forces synchronous layout
  // (reflow), which on a 15fps video path stalls decoding and drops frames.
  // Rectangles are refreshed ONLY on layout-changing events (resize, panel
  // drag/stretch, tab-bar toggle, mode switch), never on the frame path.
  let stageRectCache = { left: 0, top: 0, width: 0, height: 0 };
  let canvasRectCache = { left: 0, top: 0, width: 0, height: 0 };

  function refreshCanvasRect() {
    const c = canvas.getBoundingClientRect();
    canvasRectCache = { left: c.left, top: c.top, width: c.width, height: c.height };
  }

  function refreshRects() {
    const s = stage.getBoundingClientRect();
    stageRectCache = { left: s.left, top: s.top, width: s.width, height: s.height };
    refreshCanvasRect();
  }

  // Fit the canvas into the stage. Returns true when the CSS size changed (so
  // callers know to re-anchor the cursor). Uses cached stage rect; no reflow.
  function layoutCanvas(w, h) {
    const stageRect = stageRectCache.width > 0 ? stageRectCache : stage.getBoundingClientRect();
    const pad = 4;
    const availW = stageRect.width - pad * 2;
    const availH = stageRect.height - pad * 2;
    const scale = Math.min(availW / w, availH / h, 1);
    const cssW = Math.max(1, Math.floor(w * scale));
    const cssH = Math.max(1, Math.floor(h * scale));
    if (canvas.style.width === cssW + "px" && canvas.style.height === cssH + "px") return false;
    canvas.style.width = cssW + "px";
    canvas.style.height = cssH + "px";
    refreshCanvasRect();
    return true;
  }

  function layoutSurface() {
    canvas.style.display = "block";
    refreshRects();
    layoutCanvas(canvas.width || vw, canvas.height || vh);
    placeCursor();
  }

  function surfaceRect() {
    return canvasRectCache;
  }

  // ---------- input forwarding ----------
  function mods(e) {
    let m = 0;
    if (e.altKey) m |= MODS.Alt;
    if (e.ctrlKey) m |= MODS.Control;
    if (e.metaKey) m |= MODS.Meta;
    if (e.shiftKey) m |= MODS.Shift;
    return m;
  }

  function toViewport(e) {
    const rect = surfaceRect();
    const cw = canvas.width || vw;
    const ch = canvas.height || vh;
    return { x: ((e.clientX - rect.left) / rect.width) * cw, y: ((e.clientY - rect.top) / rect.height) * ch };
  }

  // Map remote viewport coords to a position INSIDE .dbw-stage (the containing
  // block of the cursor/ripple elements). The canvas is centered in the stage,
  // so stage-relative = canvas-absolute minus the stage origin. Cached rects —
  // no reflow on this hot path.
  function toStage(x, y) {
    const rect = canvasRectCache;
    const srect = stageRectCache;
    const cw = canvas.width || vw;
    const ch = canvas.height || vh;
    return {
      x: rect.left - srect.left + (x / cw) * rect.width,
      y: rect.top - srect.top + (y / ch) * rect.height
    };
  }

  // Keep the cursor glued to the remote pointer position even when the layout
  // shifts (tab bar, resize, tab switch) — re-anchored on layout changes.
  function placeCursor() {
    if (!cursorVp) return;
    const pos = toStage(cursorVp.x, cursorVp.y);
    cursorEl.classList.add("show");
    cursorEl.style.left = pos.x + "px";
    cursorEl.style.top = pos.y + "px";
    try {
      globalThis.__DBW_CURSOR__ = { vp: { ...cursorVp }, pos, canvas: canvasRectCache, stage: stageRectCache };
    } catch { /* debug hook */ }
  }

  // Watch-only mode: the user's own input is not forwarded (the server drops
  // it too — defense in depth). No overlay, so the page stays fully visible;
  // a one-time toast hints at the mode when the user tries to interact.
  let viewHintShown = false;
  const pointerSurface = canvas;
  pointerSurface.addEventListener("pointerdown", (e) => {
    if (viewMode !== "operate") {
      e.preventDefault(); // block focus/drag-select default behaviour too
      if (!viewHintShown) {
        viewHintShown = true;
        toast("👁 仅观看模式 —— 点击导航栏「🖱 操作」切换后可操作");
      }
      return;
    }
    e.preventDefault();
    pointerSurface.focus();
    try {
      pointerSurface.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already released */
    }
    const { x, y } = toViewport(e);
    const now = Date.now();
    const clickCount = now - lastClick.t < 400 && Math.abs(x - lastClick.x) < 12 && Math.abs(y - lastClick.y) < 12 ? 2 : 1;
    lastClick = { t: now, x, y };
    send({ type: "input", kind: "mouse", op: "mousePressed", x, y, button: e.button, buttons: e.buttons, modifiers: mods(e), clickCount });
  });
  pointerSurface.addEventListener("pointermove", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    const { x, y } = toViewport(e);
    send({ type: "input", kind: "mouse", op: "mouseMoved", x, y, buttons: e.buttons, modifiers: mods(e) });
  });
  const releasePointer = (e) => {
    if (viewMode !== "operate") return;
    const { x, y } = toViewport(e);
    send({ type: "input", kind: "mouse", op: "mouseReleased", x, y, button: e.button, buttons: e.buttons, modifiers: mods(e), clickCount: 1 });
  };
  pointerSurface.addEventListener("pointerup", releasePointer);
  pointerSurface.addEventListener("pointercancel", releasePointer);
  pointerSurface.addEventListener("wheel", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    const { x, y } = toViewport(e);
    const factor = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
    send({ type: "input", kind: "mouse", op: "mouseWheel", x, y, deltaX: e.deltaX * factor, deltaY: e.deltaY * factor, modifiers: mods(e) });
  }, { passive: false });
  pointerSurface.addEventListener("contextmenu", (e) => e.preventDefault());
  pointerSurface.addEventListener("dblclick", (e) => e.preventDefault());

  pointerSurface.addEventListener("keydown", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    e.stopPropagation();
    const isPrintable = e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (isPrintable) {
      send({ type: "input", kind: "key", op: "keyDown", key: e.key, code: e.code, modifiers: mods(e), repeat: e.repeat });
      send({ type: "input", kind: "key", op: "char", key: e.key, code: e.code, modifiers: mods(e) });
    } else {
      send({ type: "input", kind: "key", op: "keyDown", key: e.key, code: e.code, modifiers: mods(e), repeat: e.repeat });
    }
  });
  pointerSurface.addEventListener("keyup", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    e.stopPropagation();
    send({ type: "input", kind: "key", op: "keyUp", key: e.key, code: e.code, modifiers: mods(e) });
  });

  // touch → CDP touch events (for emulated mobile viewports)
  function touchPoint(t) {
    const rect = surfaceRect();
    return { x: ((t.clientX - rect.left) / rect.width) * vw, y: ((t.clientY - rect.top) / rect.height) * vh };
  }
  pointerSurface.addEventListener("touchstart", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    send({ type: "input", kind: "touch", op: "touchStart", points: [...e.touches].map(touchPoint) });
  }, { passive: false });
  pointerSurface.addEventListener("touchmove", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    send({ type: "input", kind: "touch", op: "touchMove", points: [...e.touches].map(touchPoint) });
  }, { passive: false });
  pointerSurface.addEventListener("touchend", (e) => {
    if (viewMode !== "operate") return;
    e.preventDefault();
    send({ type: "input", kind: "touch", op: "touchEnd", points: [...e.touches].map(touchPoint) });
  }, { passive: false });

  // ---------- FAB: draggable + click to open ----------
  let fabDrag = null;
  function loadFabPos() {
    try {
      const raw = localStorage.getItem("dbw-fab-pos");
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.top === "number") {
        fab.style.right = "auto";
        fab.style.bottom = "auto";
        fab.style.left = p.left + "px";
        fab.style.top = p.top + "px";
      }
    } catch {
      /* ignore */
    }
  }
  function saveFabPos() {
    try {
      const r = fab.getBoundingClientRect();
      localStorage.setItem("dbw-fab-pos", JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    } catch {
      /* ignore */
    }
  }
  fab.addEventListener("pointerdown", (e) => {
    fabDrag = { x: e.clientX, y: e.clientY, moved: false };
    try {
      fab.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  fab.addEventListener("pointermove", (e) => {
    if (!fabDrag) return;
    const dx = e.clientX - fabDrag.x;
    const dy = e.clientY - fabDrag.y;
    if (!fabDrag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
      fabDrag.moved = true;
      // pin position before switching off right/bottom anchoring
      const r = fab.getBoundingClientRect();
      fab.style.right = "auto";
      fab.style.bottom = "auto";
      fab.style.left = r.left + "px";
      fab.style.top = r.top + "px";
      fab.classList.add("dragging");
    }
    if (fabDrag.moved) {
      const w = fab.offsetWidth;
      const h = fab.offsetHeight;
      fab.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, fabDrag.x + dx)) + "px";
      fab.style.top = Math.max(8, Math.min(window.innerHeight - h - 8, fabDrag.y + dy)) + "px";
    }
  });
  const fabUp = () => {
    if (fabDrag) {
      const wasDrag = fabDrag.moved;
      fabDrag = null;
      fab.classList.remove("dragging");
      if (wasDrag) {
        saveFabPos();
        return; // a drag is not a click
      }
    }
    // plain click -> open the panel (or close if already open via fab)
    if (panel.classList.contains("open")) {
      panel.classList.remove("open");
      fab.style.display = "flex";
    } else {
      openPanelNearFab();
    }
  };
  fab.addEventListener("pointerup", fabUp);
  fab.addEventListener("pointercancel", () => {
    fabDrag = null;
    fab.classList.remove("dragging");
  });

  // ---------- panel open / drag / maximize ----------
  function openPanelNearFab() {
    // Read the FAB box BEFORE hiding it — getBoundingClientRect() of a
    // display:none element is all zeros.
    const fr = fab.getBoundingClientRect();
    fab.style.display = "none";
    const saved = loadPanelPosOnce();
    if (!saved && (fr.width > 0 || fr.height > 0)) {
      const pw = panel.offsetWidth || 880;
      const ph = panel.offsetHeight || 600;
      panel.style.right = "auto";
      panel.style.bottom = "auto";
      // Open above the FAB, right edges roughly aligned.
      panel.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, fr.right - pw + 4)) + "px";
      panel.style.top = Math.max(8, Math.min(window.innerHeight - ph - 8, fr.top - ph - 12)) + "px";
    }
    panel.classList.add("open");
    urlInput.focus();
    layoutSurface();
  }

  function loadPanelPosOnce() {
    try {
      const raw = localStorage.getItem("dbw-panel-pos");
      if (!raw) return false;
      const p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.top === "number") {
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = p.left + "px";
        panel.style.top = p.top + "px";
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }
  function savePanelPos() {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem("dbw-panel-pos", JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
    } catch {
      /* ignore */
    }
  }

  root.querySelector('[data-role="close"]').addEventListener("click", () => {
    panel.classList.remove("open");
    hmenu.hidden = true;
    fab.style.display = "flex";
  });
  root.querySelector('[data-role="max"]').addEventListener("click", () => {
    panel.classList.toggle("max");
    layoutSurface();
  });

  const head = panel.querySelector(".dbw-head");
  let drag = null;
  function loadPanelPos() {
    try {
      const raw = localStorage.getItem("dbw-panel-pos");
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.left === "number" && typeof p.top === "number") {
        panel.style.right = "auto";
        panel.style.bottom = "auto";
        panel.style.left = p.left + "px";
        panel.style.top = p.top + "px";
      }
    } catch {
      /* ignore */
    }
  }
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    // pin current position before switching off right/bottom anchoring
    const r = panel.getBoundingClientRect();
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = r.left + "px";
    panel.style.top = r.top + "px";
    panel.classList.remove("max");
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try {
      head.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  });
  head.addEventListener("pointermove", (e) => {
    if (!drag) return;
    // minimal grab-able margin keeps the panel recoverable; otherwise free.
    const w = panel.offsetWidth;
    const left = e.clientX - drag.dx;
    const top = e.clientY - drag.dy;
    panel.style.left = Math.max(-(w - 60), Math.min(window.innerWidth - 60, left)) + "px";
    panel.style.top = Math.max(-10, Math.min(window.innerHeight - 40, top)) + "px";
    refreshRects(); // panel moved -> cached stage/canvas rects are stale
  });
  head.addEventListener("pointerup", () => {
    if (drag) {
      drag = null;
      savePanelPos();
    }
  });
  head.addEventListener("pointercancel", () => {
    drag = null;
  });

  // ---------- panel resize (window stretching; viewport follows) ----------
  let resizeDrag = null;
  function loadPanelSize() {
    try {
      const raw = localStorage.getItem("dbw-panel-size");
      if (!raw) return;
      const p = JSON.parse(raw);
      if (typeof p.w === "number" && typeof p.h === "number") {
        const w = Math.max(PANEL_MIN_W, Math.min(window.innerWidth - 24, p.w));
        const h = Math.max(PANEL_MIN_H, Math.min(window.innerHeight - 24, p.h));
        panel.style.width = w + "px";
        panel.style.height = h + "px";
      }
    } catch {
      /* ignore */
    }
  }
  function savePanelSize() {
    try {
      const r = panel.getBoundingClientRect();
      localStorage.setItem("dbw-panel-size", JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height) }));
    } catch {
      /* ignore */
    }
  }
  function startResize(e, mode) {
    if (!running) return;
    e.preventDefault();
    // pin to left/top so the corner grip grows right/down naturally
    const r = panel.getBoundingClientRect();
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = r.left + "px";
    panel.style.top = r.top + "px";
    panel.classList.remove("max");
    resizeDrag = { mode, startX: e.clientX, startY: e.clientY, w: r.width, h: r.height };
    try {
      panel.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
  function moveResize(e) {
    if (!resizeDrag) return;
    let w = resizeDrag.w;
    let h = resizeDrag.h;
    if (resizeDrag.mode === "e" || resizeDrag.mode === "se") w = resizeDrag.w + (e.clientX - resizeDrag.startX);
    if (resizeDrag.mode === "s" || resizeDrag.mode === "se") h = resizeDrag.h + (e.clientY - resizeDrag.startY);
    w = Math.max(PANEL_MIN_W, Math.min(window.innerWidth - 24, w));
    h = Math.max(PANEL_MIN_H, Math.min(window.innerHeight - 24, h));
    panel.style.width = w + "px";
    panel.style.height = h + "px";
    refreshRects();
    scheduleResizeViewport();
  }
  function endResize() {
    if (!resizeDrag) return;
    resizeDrag = null;
    savePanelSize();
    refreshRects();
    scheduleResizeViewport();
  }
  // After the panel settles, tell the server the page viewport should match
  // the stage area — "stretching the window" really resizes the web page.
  function scheduleResizeViewport() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!running) return;
      // use the cached stage rect (refreshed during resize); no extra reflow
      const r = stageRectCache;
      const w = Math.max(1, Math.round(r.width));
      const h = Math.max(1, Math.round(r.height));
      if (w !== 0 && h !== 0) send({ type: "cmd", command: "resize", width: w, height: h });
    }, 250);
  }
  root.querySelector('[data-role="grip"]').addEventListener("pointerdown", (e) => startResize(e, "se"));
  root.querySelector('[data-role="gedge-r"]').addEventListener("pointerdown", (e) => startResize(e, "e"));
  root.querySelector('[data-role="gedge-b"]').addEventListener("pointerdown", (e) => startResize(e, "s"));
  panel.addEventListener("pointermove", moveResize);
  panel.addEventListener("pointerup", endResize);
  panel.addEventListener("pointercancel", endResize);

  // ---------- navigation controls ----------
  function go(url) {
    const clean = (url || "").trim();
    if (!clean) return;
    if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(clean)) {
      send({ type: "url", url: clean.startsWith("//") ? location.protocol + clean : "https://" + clean });
    } else {
      send({ type: "url", url: clean });
    }
  }
  root.querySelector('[data-role="go"]').addEventListener("click", () => go(urlInput.value));
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go(urlInput.value);
    }
    e.stopPropagation();
  });
  backBtn.addEventListener("click", () => send({ type: "nav", command: "back" }));
  fwdBtn.addEventListener("click", () => send({ type: "nav", command: "forward" }));
  refreshBtn.addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) send({ type: "url", url });
    else send({ type: "cmd", command: "refresh" });
  });
  homeBtn.addEventListener("click", () => send({ type: "url", url: HOME_URL }));
  startBtn.addEventListener("click", () => send({ type: "cmd", command: "open" }));
  shotBtn.addEventListener("click", () => send({ type: "cmd", command: "screenshot" }));
  stopBtn.addEventListener("click", () => send({ type: "cmd", command: "close" }));
  modeBtn.addEventListener("click", () => {
    const next = viewMode === "operate" ? "view" : "operate";
    send({ type: "mode", mode: next });
    applyMode(next); // optimistic; server broadcast confirms
  });
  histBtn.addEventListener("click", () => {
    if (hmenu.hidden) send({ type: "nav", command: "history" });
    else hmenu.hidden = true;
  });
  document.addEventListener("click", (e) => {
    if (!hmenu.hidden && !hmenu.contains(e.target) && e.target !== histBtn) hmenu.hidden = true;
  });

  // ---------- init ----------
  loadFabPos();
  loadPanelPos();
  loadPanelSize();
  refreshRects();
  setStateChip();
  applyMode("view");
  connect();
  window.addEventListener("resize", () => layoutSurface());
  // Stage size changes (tab bar, panel drag/resize, maximized toggle) must
  // re-fit the canvas, otherwise click-to-viewport mapping drifts.
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => layoutSurface()).observe(stage);
  }
})();
