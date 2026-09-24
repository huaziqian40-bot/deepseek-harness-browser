// @deepseek-ai/dsh-tool-browser — minimal CDP (Chrome DevTools Protocol) core.
// No puppeteer/playwright dependency: a raw `ws` client against Chrome's
// DevTools endpoints plus a Chromium launcher that own the full lifecycle.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

const DEFAULT_VIEWPORT = { width: 1280, height: 800 };

/** Windows virtual-key codes used to make non-printable key default actions
 *  (Backspace/Delete/Enter/Arrows/Ctrl-combos...) actually run in Chromium —
 *  plain Input.dispatchKeyEvent "keyDown" without these does NOT trigger
 *  editing default actions in headful Chromium. */
const VK = {
  Backspace: 8, Tab: 9, Enter: 13, Shift: 16, Control: 17, Alt: 18, CapsLock: 20, Escape: 27, Space: 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46,
  "0": 48, "1": 49, "2": 50, "3": 51, "4": 52, "5": 53, "6": 54, "7": 55, "8": 56, "9": 57,
  A: 65, B: 66, C: 67, D: 68, E: 69, F: 70, G: 71, H: 72, I: 73, J: 74, K: 75, L: 76, M: 77,
  N: 78, O: 79, P: 80, Q: 81, R: 82, S: 83, T: 84, U: 85, V: 86, W: 87, X: 88, Y: 89, Z: 90,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
  ";": 186, "=": 187, ",": 188, "-": 189, ".": 190, "/": 191, "`": 192, "[": 219, "\\": 220, "]": 221, "'": 222
};

export function vkFor(key, code) {
  if (key !== undefined && VK[key] !== undefined) return VK[key];
  if (code !== undefined && VK[code] !== undefined) return VK[code];
  if (code !== undefined) {
    const k = /^Key([A-Z])$/.exec(code);
    if (k) return k[1].charCodeAt(0);
    const d = /^Digit([0-9])$/.exec(code);
    if (d) return 48 + Number(d[1]);
    const f = /^F([0-9]{1,2})$/.exec(code);
    if (f && Number(f[1]) >= 1 && Number(f[1]) <= 12) return 111 + Number(f[1]);
  }
  return undefined;
}

export function isPrintableKey(key) {
  return typeof key === "string" && key.length === 1 && /^[\x20-\x7e]$/.test(key);
}

/**
 * Read the pixel dimensions out of a JPEG buffer by locating the SOF segment
 * (marker 0xC0..0xCF, excluding tables). Returns undefined when not found —
 * callers fall back to CDP metadata.
 */
export function jpegSize(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  const len = buf.length;
  while (i + 9 < len) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // stand-alone markers with no payload
      continue;
    }
    const segLen = buf.readUInt16BE(i + 2);
    if (segLen < 2) return undefined;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (segLen >= 7) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      return undefined;
    }
    i += 2 + segLen;
  }
  return undefined;
}

/** Resolve the Chrome/Chromium executable, checking env, PATH, and this box's bundle. */
export function resolveChromeBinary() {
  // 1) explicit env vars win
  for (const p of [process.env.DSH_CHROME_PATH, process.env.CHROME_PATH, process.env.CHROMIUM_PATH]) {
    if (p && existsSync(p)) return p;
  }
  // 2) well-known locations (bundled, home, system installs, mac, windows)
  const candidates = [
    "/home/sandbox/.local/dsh-browser/chrome-linux64/chrome",
    join(homedir(), ".local/dsh-browser/chrome-linux64/chrome"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/microsoft-edge",
    "/usr/local/bin/chromium",
    "/usr/local/bin/google-chrome",
    "/snap/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Chromium\\Application\\chrome.exe",
    join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
    join(process.env.LOCALAPPDATA ?? "", "Microsoft/Edge/Application/msedge.exe")
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  // 3) PATH lookup fallback (covers apt/snap/homebrew installs on PATH)
  const sep = process.platform === "win32" ? ";" : ":";
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const dir of (process.env.PATH ?? "").split(sep)) {
    if (!dir) continue;
    for (const name of ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome", "msedge", "microsoft-edge"]) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

const RE_DEVTOOLS_PORT = /DevTools listening on ws:\/\/[^:]+:(\d+)\//;

/**
 * Environment additions Chrome needs on minimal containers: the bundled
 * runtime libraries (extracted Debian .debs) when the binary lives in the
 * well-known bundle location and the container has no system copies.
 */
export function chromeRuntimeEnv() {
  const libsDir = join(homedir(), ".local", "dsh-libs", "x86_64-linux-gnu");
  const current = process.env.LD_LIBRARY_PATH ?? "";
  if (current !== "") return { LD_LIBRARY_PATH: current };
  const env = {};
  if (existsSync(libsDir)) env.LD_LIBRARY_PATH = libsDir;
  const fontsConf = join(homedir(), ".local", "dsh-libs", "etc", "fonts", "fonts.conf");
  if (existsSync(fontsConf)) {
    env.FONTCONFIG_FILE = fontsConf;
    env.FONTCONFIG_PATH = join(homedir(), ".local", "dsh-libs", "etc", "fonts");
  }
  return env;
}

/**
 * Launch a Chrome/Chromium instance and return the launched process plus the
 * DevTools HTTP port. `headful` is honored when a display exists; otherwise
 * (containers without X) it falls back to `--headless=new`, which still runs
 * the exact same browser engine and CDP screencast — the visible surface is
 * the shared web UI.
 */
export async function launchChrome({
  headful = true,
  userDataDir,
  port: fixedPort,
  flags = [],
  env = {}
} = {}) {
  const chrome = resolveChromeBinary();
  if (!chrome) {
    throw new Error(
      "Chrome/Chromium binary not found. Set DSH_CHROME_PATH or place a chrome binary at ~/.local/dsh-browser/chrome-linux64/chrome (Chrome for Testing recommended)."
    );
  }
  const hasDisplay = Boolean(process.env.DISPLAY);
  const useHeadlessNew = headful ? !hasDisplay : true;
  const args = [
    ...(useHeadlessNew ? ["--headless=new"] : []),
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=" + (fixedPort ?? 0),
    "--user-data-dir=" + userDataDir,
    "--window-size=" + DEFAULT_VIEWPORT.width + "," + DEFAULT_VIEWPORT.height,
    ...flags
  ];
  const child = spawn(chrome, args, {
    stdio: ["ignore", "ignore", "pipe"],
    env: { ...process.env, ...chromeRuntimeEnv(), ...env }
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    if (stderr.length > 1 << 20) stderr = stderr.slice(-(1 << 20));
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Chrome did not report a DevTools port in time (is the binary runnable?)"));
    }, 20000);
    const onData = () => {
      const match = RE_DEVTOOLS_PORT.exec(stderr);
      if (!match) return;
      cleanup();
      resolve(Number(match[1]));
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(new Error(`Chrome exited early (code=${String(code)} signal=${String(signal)}): ${stderr.slice(-500)}`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    child.stderr.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return { child, port, headless: useHeadlessNew, binary: chrome, stderrRef: () => stderr };
}

/**
 * Raw CDP connection to one target's WebSocket debugger URL.
 * Fire-and-forget events fan out to `on(event, fn)` listeners; awaited
 * commands resolve on the matching id response.
 */
export class CdpSession {
  ws;
  nextId = 1;
  pending = new Map();
  listeners = new Map();
  closed = false;

  constructor(ws) {
    this.ws = ws;
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        const waiter = this.pending.get(msg.id);
        if (!waiter) return;
        this.pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(`CDP ${msg.error.message}`));
        else waiter.resolve(msg.result ?? {});
        return;
      }
      if (msg.method === undefined) return;
      const fns = this.listeners.get(msg.method);
      if (fns) for (const fn of [...fns]) {
        try {
          fn(msg.params ?? {});
        } catch (error) {
          console.error("[dsh-tool-browser] event listener error", error);
        }
      }
    });
    ws.on("close", () => this._shutdown());
    ws.on("error", () => this._shutdown());
  }

  _shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error("CDP connection closed"));
    this.pending.clear();
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
    return () => {
      this.listeners.get(method)?.delete(fn);
    };
  }

  once(method, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for CDP event ${method}`));
      }, timeoutMs);
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP connection closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
    this._shutdown();
  }
}

/** Discover the page targets of a DevTools HTTP port: [{id, title, url, type, webSocketDebuggerUrl}]. */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  if (!res.ok) throw new Error(`DevTools /json/list failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * High-level browser manager: owns one Chrome process, connects to a page
 * target, drives navigation/input/screenshot, and streams screencast frames.
 */
export class BrowserManager {
  chrome;
  binary;
  port;
  headless;
  session;
  viewport = { ...DEFAULT_VIEWPORT };
  pageTargetId;
  screencastActive = false;
  _frameCallbacks = new Set();
  _navWaiters = [];
  sessions = new Map(); // targetId -> pre-warmed CdpSession
  screencastOff = null; // unregister fn for the active session's frame listener

  static async launch(opts) {
    const { viewport, ...launchOpts } = opts;
    const { child, port, headless, binary } = await launchChrome(launchOpts);
    const manager = new BrowserManager(child, port, headless, viewport);
    manager.binary = binary;
    try {
      await manager.connect();
    } catch (error) {
      manager.dispose();
      throw error;
    }
    return manager;
  }

  constructor(chrome, port, headless, viewport) {
    this.chrome = chrome;
    this.viewport = viewport ? { ...viewport } : { ...DEFAULT_VIEWPORT };
    this.port = port;
    this.headless = headless;
    chrome.once("exit", () => this._emitClosed());
  }

  _emitClosed() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.screencastOff?.();
    this.screencastOff = null;
    this.session = undefined;
    for (const fn of [...this._frameCallbacks]) fn({ type: "closed" });
  }

  async _attach(target) {
    const existing = this.sessions.get(target.id);
    if (existing) return existing;
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    const session = new CdpSession(ws);
    session._viewportApplied = false;
    await session.send("Page.enable");
    await session.send("Runtime.enable");
    await session.send("Network.enable").catch(() => {});
    this.sessions.set(target.id, session);
    return session;
  }

  async _applyViewportIfNeeded(session) {
    if (session._viewportApplied) return;
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: this.viewport.width,
      height: this.viewport.height,
      deviceScaleFactor: 1,
      mobile: false
    });
    session._viewportApplied = true;
  }

  async connect() {
    const targets = await listTargets(this.port);
    const page = targets.find((target) => target.type === "page") ?? targets[0];
    if (!page) throw new Error("No page target found on the DevTools port");
    await this._attach(page);
    this.pageTargetId = page.id;
    this.session = this.sessions.get(page.id);
    await this._applyViewportIfNeeded(this.session);
  }

  async applyViewport(viewport) {
    this.viewport = { ...viewport };
    for (const session of this.sessions.values()) session._viewportApplied = false;
    if (this.session) await this._applyViewportIfNeeded(this.session);
  }

  onFrame(fn) {
    this._frameCallbacks.add(fn);
    return () => this._frameCallbacks.delete(fn);
  }

  onEvent(method, fn) {
    return this.session.on(method, fn);
  }

  async navigate(url, timeoutMs = 30000) {
    await this.session.send("Page.navigate", { url });
    await this.session.once("Page.loadEventFired", timeoutMs).catch(() => {});
    return this.pageInfo();
  }

  /** Session navigation history: { currentIndex, entries:[{id,url,userTypedURL,title,transitionType}] } */
  async history() {
    const res = await this.session.send("Page.getNavigationHistory");
    return { currentIndex: res.currentIndex ?? 0, entries: res.entries ?? [] };
  }

  async goToHistoryEntry(entryId, timeoutMs = 30000) {
    await this.session.send("Page.navigateToHistoryEntry", { entryId });
    await this.session.once("Page.loadEventFired", timeoutMs).catch(() => {});
    return this.pageInfo();
  }

  /** Go back one history entry (no-op at the first entry). */
  async back() {
    const h = await this.history();
    const idx = h.currentIndex - 1;
    const entry = h.entries[idx];
    if (!entry) return { moved: false, ...(await this.pageInfo()) };
    await this.goToHistoryEntry(entry.id);
    return { moved: true, ...(await this.pageInfo()) };
  }

  /** Go forward one history entry (no-op at the last entry). */
  async forward() {
    const h = await this.history();
    const idx = h.currentIndex + 1;
    const entry = h.entries[idx];
    if (!entry) return { moved: false, ...(await this.pageInfo()) };
    await this.goToHistoryEntry(entry.id);
    return { moved: true, ...(await this.pageInfo()) };
  }

  async pageInfo() {
    const result = await this.session.send("Runtime.evaluate", {
      expression: "JSON.stringify({title: document.title, url: location.href})",
      returnByValue: true
    });
    let parsed = {};
    try {
      parsed = JSON.parse(result.result.value ?? "{}");
    } catch {
      /* keep defaults */
    }
    return { title: parsed.title ?? "", url: parsed.url ?? "", viewport: { ...this.viewport } };
  }

  async eval(expression, { awaitPromise = true, timeoutMs = 30000 } = {}) {
    const result = await this.session.send(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise,
        userGesture: true
      },
      timeoutMs
    );
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "evaluation threw";
      throw new Error(`browser eval threw: ${detail}`);
    }
    const out = {};
    if (result.result?.type !== undefined) out.type = result.result.type;
    if (result.result?.subtype !== undefined) out.subtype = result.result.subtype;
    if (result.result?.value !== undefined) out.value = result.result.value;
    if (result.result?.description !== undefined) out.description = result.result.description;
    return out;
  }

  /** Page targets of this Chrome: [{id, url, title}] for type === "page". */
  async listTabs() {
    const targets = await listTargets(this.port);
    return targets
      .filter((t) => t.type === "page")
      .map((t) => ({ id: t.id, url: t.url, title: t.title ?? "" }));
  }

  /** Open a new tab (page target) via the DevTools HTTP endpoint, pre-warming
   *  its CDP session so switching to it is near-instant. */
  async openTab(url = "about:blank") {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
    if (!res.ok) throw new Error(`DevTools /json/new failed: HTTP ${res.status}`);
    const target = await res.json();
    await this._attach(target);
    return { id: target.id, url: target.url, title: target.title ?? "" };
  }

  /** Close a tab. If it was the active one, switch to the first remaining tab
   *  (or reopen a blank tab so the browser never dies on the last close). */
  async closeTab(id) {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/close/${encodeURIComponent(id)}`);
    const ok = res.ok;
    const session = this.sessions.get(id);
    if (session) {
      session.close();
      this.sessions.delete(id);
    }
    if (this.pageTargetId === id) {
      const remaining = (await this.listTabs()).filter((t) => t.id !== id);
      if (remaining.length > 0) {
        await this.switchToTab(remaining[0].id);
      } else {
        const nb = await this.openTab("about:blank");
        await this.switchToTab(nb.id);
      }
    }
    return Boolean(ok);
  }

  /**
   * Make `id` the active page target. Sessions are pre-warmed per tab, so a
   * switch only stops/restarts the screencast (no reconnect, no re-enable).
   * Screencast, input, eval and navigation all follow the active session.
   */
  async switchToTab(id) {
    const targets = await listTargets(this.port);
    const target = targets.find((t) => t.id === id && t.type === "page") ?? targets.find((t) => t.id === id);
    if (!target) throw new Error(`No target with id ${id}`);
    if (id === this.pageTargetId && this.session && !this.session.closed) {
      return this.pageInfo();
    }
    if (this.screencastActive) await this.stopScreencast().catch(() => {});
    const session = await this._attach(target);
    await this._applyViewportIfNeeded(session);
    this.session = session;
    this.pageTargetId = target.id;
    return this.pageInfo();
  }

  /** Move the pointer (CDP coordinates relative to the viewport). */
  async mouseMove(x, y, { buttons = 0 } = {}) {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x),
      y: Math.round(y),
      // A press-drag (buttons>0) move MUST carry button:"left", otherwise CDP
      // swallows the move and pointermove never fires (capture drag stalls).
      button: buttons ? "left" : "none",
      buttons
    });
  }

  async mousePress(x, y, { button = "left", buttons = 1, clickCount = 1, modifiers = 0 } = {}) {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x),
      y: Math.round(y),
      button,
      buttons,
      clickCount,
      modifiers
    });
  }

  async mouseRelease(x, y, { button = "left", buttons = 0, clickCount = 1, modifiers = 0 } = {}) {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x),
      y: Math.round(y),
      button,
      buttons,
      clickCount,
      modifiers
    });
  }

  async click(x, y, { modifiers = 0, button = "left" } = {}) {
    await this.mouseMove(x, y);
    await this.mousePress(x, y, { button, modifiers, buttons: 1, clickCount: 1 });
    await this.mouseRelease(x, y, { button, modifiers, buttons: 0, clickCount: 1 });
  }

  async wheel(x, y, deltaX, deltaY) {
    await this.session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: Math.round(x),
      y: Math.round(y),
      deltaX: Math.round(deltaX),
      deltaY: Math.round(deltaY)
    });
  }

  /** Dispatch raw key events. `key`/`code` follow the DOM KeyboardEvent shape. */
  async key(type, key, code, { text, modifiers = 0, repeat = false, vk } = {}) {
    await this.session.send("Input.dispatchKeyEvent", {
      type,
      key,
      code,
      ...(text !== undefined ? { text, unmodifiedText: text } : {}),
      modifiers,
      ...(repeat ? { repeat: true } : {}),
      ...(vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {})
    });
  }

  async pressKey(key, code) {
    if (key === "Enter") {
      // Enter inserts a newline via the keypress (char) phase, and only runs
      // when the rawKeyDown carries the virtual-key code.
      await this.key("rawKeyDown", key, code, { vk: 13 });
      await this.key("char", key, code, { text: "\r" });
      await this.key("keyUp", key, code, { vk: 13 });
      return;
    }
    if (!isPrintableKey(key)) {
      const vk = vkFor(key, code);
      await this.key("rawKeyDown", key, code, { vk });
      await this.key("keyUp", key, code, { vk });
      return;
    }
    await this.key("keyDown", key, code, { text: key });
    await this.key("keyUp", key, code);
  }

  async typeText(text) {
    for (const ch of String(text)) {
      const code = /[a-z]/i.test(ch) ? "Key" + ch.toUpperCase() : "None";
      // keyDown WITHOUT text: the char event carries the text. Sending text on
      // keyDown AND a char event double-inserts every character ("aabbcc").
      await this.session.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, code });
      await this.session.send("Input.dispatchKeyEvent", { type: "char", key: ch, text: ch, code: "None" });
      await this.session.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch, code });
    }
  }

  async screenshot({ format = "png", quality, fullPage = false } = {}) {
    const result = await this.session.send("Page.captureScreenshot", {
      format,
      ...quality !== undefined ? { quality } : {},
      fromSurface: true,
      captureBeyondViewport: fullPage
    });
    return result.data; // base64
  }

  async startScreencast({ quality = 70, everyNthFrame = 1, maxWidth = 1600, maxHeight = 1000, maxFrameRate = 0 } = {}) {
    if (this.screencastActive) return;
    this.screencastOff?.();
    this.screencastOff = this.session.on("Page.screencastFrame", (params) => {
      this.session.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
      // Headful Chromium omits `metadata` on screencast frames, so derive the
      // frame size from the JPEG header itself (SOF segment) when needed.
      const raw = Buffer.from(params.data, "base64");
      const dims = jpegSize(raw) ?? {
        width: params.metadata?.width,
        height: params.metadata?.height
      };
      for (const fn of [...this._frameCallbacks]) fn({
        type: "frame",
        data: params.data,
        width: dims?.width,
        height: dims?.height,
        timestamp: params.metadata?.timestamp ?? Date.now() / 1000
      });
    });
    await this.session.send("Page.startScreencast", {
      format: "jpeg",
      quality,
      everyNthFrame,
      maxWidth,
      maxHeight,
      // Cap the source frame rate: the server throttles pushes itself, so an
      // uncapped screencast just burns CPU encoding frames nobody sees.
      ...(maxFrameRate > 0 ? { maxFrameRate } : {})
    });
    this.screencastActive = true;
  }

  async stopScreencast() {
    if (!this.screencastActive) return;
    await this.session.send("Page.stopScreencast").catch(() => {});
    this.screencastOff?.();
    this.screencastOff = null;
    this.screencastActive = false;
  }

  /**
   * Gracefully shut the browser down through the browser-level CDP endpoint
   * (`Browser.close`), letting Chrome flush cookies/localStorage to disk.
   * On Windows `child.kill()` is TerminateProcess — an abrupt kill can lose
   * writes that have not yet been flushed, so we prefer the CDP path and only
   * fall back to signals when the CDP endpoint is unreachable.
   */
  async gracefulClose(timeoutMs = 5000) {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/json/version`);
      if (!res.ok) return false;
      const info = await res.json();
      if (!info.webSocketDebuggerUrl) return false;
      const ws = new WebSocket(info.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          try { ws.close(); } catch { /* noop */ }
          reject(new Error("browser ws open timeout"));
        }, 2000);
        ws.once("open", () => { clearTimeout(timer); resolve(); });
        ws.once("error", () => { clearTimeout(timer); reject(new Error("browser ws error")); });
      });
      await new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; resolve(); } };
        const timer = setTimeout(finish, timeoutMs);
        ws.once("close", finish);
        ws.once("error", finish);
        ws.send(JSON.stringify({ id: 1, method: "Browser.close" }));
        // Browser.close terminates the browser; the ws then closes.
      });
      // Give the process a moment to exit; the fallback below covers failures.
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.chrome.once("exit", () => { clearTimeout(timer); resolve(); });
      });
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    await this.stopScreencast().catch(() => {});
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.session = undefined;
    this._emitClosed();
    if (!this.chrome.killed) {
      const graceful = await this.gracefulClose();
      if (!graceful) {
        this.chrome.kill("SIGTERM");
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            this.chrome.kill("SIGKILL");
            resolve();
          }, 3000);
          this.chrome.once("exit", () => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
    }
  }

  dispose() {
    try {
      this.chrome.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.screencastOff?.();
    this.screencastOff = null;
    this.session = undefined;
  }
}