// @deepseek-ai/dsh-tool-browser — agent-side headful Chromium tools plus the
// user-facing shared view for the DeepSeek Harness Web GUI.
//
// One browser instance per server process. Agent tools (browser_*) and the
// human in the web GUI operate the SAME Chrome instance: the GUI streams CDP
// screencast JPEG frames over /api/browser/ws and forwards mouse/keyboard/
// touch input back into the browser via the DevTools Input domain.
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { readFileSync, mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { BrowserManager, vkFor, isPrintableKey } from "./cdp.mjs";

/** Stable Cordis plugin name. */
const name = "browser-share";
/** Services required before the browser routes and tools can mount. */
const inject = ["tools", "webServer", "connection"];

const Config = z.object({
  /** Default viewport (CSS px) applied to the shared browser. */
  viewportWidth: z.natural().default(1280),
  viewportHeight: z.natural().default(800),
  /** JPEG quality for screencast frames. */
  frameQuality: z.number().min(10).max(95).default(58),
  /** Broadcast cadence (ms) for the latest screencast frame. */
  frameIntervalMs: z.natural().default(66),
  /** Max screencast frame dimension. 1024 keeps the ~880px panel crisp while
   *  cutting JPEG decode cost by ~36% vs 1280 (big factor in UI jank). */
  frameMaxDimension: z.natural().default(1024)
});

const WIDGET_URL = "/api/browser/widget.js";
const STATUS_URL = "/api/browser/status";
const WS_URL = "/api/browser/ws";
const MJPEG_URL = "/api/browser/mjpeg";
const PUBLISH_URL = "/publish";
const SHOTS_PREFIX = "/api/browser/shots/";

// ---------------------------------------------------------------------------
// Singleton browser state (one shared Chrome per server process)
// ---------------------------------------------------------------------------
let manager = null;
const clients = new Set();
let lastFrame = null;
let broadcastTimer = null;
let lastStatusJson = null;
let activeHeadful = true;
let frameIntervalMs = 66;
let frameQuality = 58;
let frameMaxDimension = 1280;
/** Human input mode: "view" (default, watch-only; user input dropped) or
 *  "operate" (user drives the browser; agent write tools refuse to run so the
 *  two never fight over the same controls). */
let viewMode = "view";
let profileDir = "";

function statusInfo() {
  if (!manager) {
    return {
      running: false,
      clients: clients.size,
      headful: activeHeadful,
      mode: viewMode
    };
  }
  return {
    running: true,
    pid: manager.chrome?.pid,
    headless: manager.headless,
    clients: clients.size,
    chrome: manager.binary,
    headful: activeHeadful,
    mode: viewMode,
    profileDir,
    viewport: manager.viewport ? { width: manager.viewport.width, height: manager.viewport.height } : undefined
  };
}

/**
 * Recursively drop undefined/NaN/Infinity so every object crossing the harness
 * tool-output boundary is lossless JSON (dsh rejects keys whose value is
 * undefined — e.g. CDP's `subtype` on a number result — with
 * "value is not lossless JSON").
 */
function cleanJson(value) {
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(cleanJson(item));
    return out;
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) {
      const item = value[key];
      if (item === undefined || (typeof item === "number" && !Number.isFinite(item))) continue;
      out[key] = cleanJson(item);
    }
    return out;
  }
  return value;
}

async function pageInfoSafe() {
  try {
    return await manager.pageInfo();
  } catch {
    return { title: "", url: "" };
  }
}

function broadcastStatus() {
  const status = statusInfo();
  lastStatusJson = JSON.stringify({ type: "status", ...status });
  if (clients.size === 0) return status;
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(lastStatusJson);
      } catch {
        /* ignore */
      }
    }
  }
  return status;
}

// --- MJPEG live stream (browser-native viewing; much smoother than canvas) ---
const mjpegClients = new Set();
let lastJpeg = null;
let lastMpegPush = 0;
const MPEG_BOUNDARY = "frame";

function mimeFrame(buf) {
  return Buffer.concat([
    Buffer.from(`--${MPEG_BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${buf.length}\r\n\r\n`),
    buf,
    Buffer.from("\r\n")
  ]);
}

function pushMpeg(buffer) {
  lastJpeg = buffer;
  const now = Date.now();
  if (now - lastMpegPush < 50) return; // throttle ~20fps; latest frame kept for the next push
  lastMpegPush = now;
  const frame = mimeFrame(buffer);
  for (const res of [...mjpegClients]) {
    if (res.writableEnded) {
      mjpegClients.delete(res);
      continue;
    }
    // Drop-on-backpressure is fine for live video: the client always sees the newest frame.
    res.write(frame);
  }
}

function startMpeg(res) {
  res.writeHead(200, {
    "content-type": `multipart/x-mixed-replace; boundary=${MPEG_BOUNDARY}`,
    "cache-control": "no-store",
    "connection": "keep-alive",
    "x-accel-buffering": "no"
  });
  mjpegClients.add(res);
  if (lastJpeg) {
    try {
      res.write(mimeFrame(lastJpeg));
    } catch {
      /* ignore */
    }
  }
  res.on("close", () => mjpegClients.delete(res));
}

function endMpeg() {
  lastJpeg = null;
  for (const res of [...mjpegClients]) {
    try {
      res.end();
    } catch {
      /* ignore */
    }
  }
  mjpegClients.clear();
}

// --- viewer echo: instant visual feedback + live cursor ----------------------
function broadcast(obj) {
  if (clients.size === 0) return;
  const payload = JSON.stringify(obj);
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

let lastCursorAt = 0;
function broadcastCursor(x, y) {
  const now = Date.now();
  if (now - lastCursorAt < 40) return; // ~25 Hz is plenty for a smooth cursor
  lastCursorAt = now;
  broadcast({ type: "cursor", x, y });
}

// --- plugin distribution: zero-dependency STORE-only ZIP builder -------------
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function zipStore(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6);  // flags
    lh.writeUInt16LE(0, 8);  // method = store
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(f.data.length, 18);
    lh.writeUInt32LE(f.data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    local.push(lh, name, f.data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(f.data.length, 20);
    ch.writeUInt32LE(f.data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + f.data.length;
  }
  const centralSize = central.reduce((s, p) => s + p.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, ...central, eocd]);
}

let pluginZipCache = null;
function buildPluginZip() {
  if (pluginZipCache) return pluginZipCache;
  const base = fileURLToPath(new URL("..", import.meta.url));
  const read = (p) => readFileSync(join(base, p));
  const files = [
    ["dsh-tool-browser/README.md", read("README.md")],
    ["dsh-tool-browser/manifest.json", read("manifest.json")],
    ["dsh-tool-browser/lib/index.js", read("lib/index.js")],
    ["dsh-tool-browser/lib/cdp.mjs", read("lib/cdp.mjs")],
    ["dsh-tool-browser/client/widget.js", read("client/widget.js")],
    ["dsh-tool-browser/client/publish.html", read("client/publish.html")],
    ["dsh-tool-browser/client/install.sh", read("client/install.sh")]
  ];
  pluginZipCache = zipStore(files.map(([name, data]) => ({ name, data })));
  return pluginZipCache;
}

async function ensureBrowser(opts = {}) {
  if (manager) {
    broadcastStatus();
    if (opts.url) await navigate(opts.url);
    return manager;
  }
  const viewport = {
    width: opts.width ?? 1280,
    height: opts.height ?? 800
  };
  activeHeadful = opts.headful !== false;
  profileDir = process.env.DSH_BROWSER_PROFILE_DIR ?? join(homedir(), ".dsh", "browser-profile");
  manager = await BrowserManager.launch({
    headful: activeHeadful,
    userDataDir: profileDir,
    viewport
  });
  manager.onFrame((frame) => {
    if (frame.type === "frame") {
      lastFrame = { type: "frame", data: frame.data, width: frame.width, height: frame.height, timestamp: frame.timestamp };
      pushMpeg(Buffer.from(frame.data, "base64"));
    } else {
      // browser exited
      lastFrame = null;
      manager = null;
      stopBroadcast();
      endMpeg();
      broadcastStatus();
    }
  });
  try {
    await manager.startScreencast({
      quality: frameQuality,
      maxWidth: frameMaxDimension,
      maxHeight: frameMaxDimension
    });
  } catch {
    /* screencast is best-effort; screenshots still work */
  }
  startBroadcast();
  bindNavRefresh(manager);
  await broadcastNavState();
  if (opts.url) await navigate(opts.url);
  await broadcastStatus();
  return manager;
}

function startBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setInterval(() => {
    if (!lastFrame || clients.size === 0) return;
    const jpeg = Buffer.from(lastFrame.data, "base64");
    const header = Buffer.alloc(9);
    header[0] = 1; // binary frame marker
    header.writeUInt32BE(lastFrame.width, 1);
    header.writeUInt32BE(lastFrame.height, 5);
    const payload = Buffer.concat([header, jpeg]);
    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
  }, frameIntervalMs);
  if (broadcastTimer.unref) broadcastTimer.unref();
}

function stopBroadcast() {
  if (broadcastTimer) {
    clearInterval(broadcastTimer);
    broadcastTimer = null;
  }
}

async function requireBrowser() {
  if (!manager) throw new Error("browser is not running — call browser_launch first");
  return manager;
}

async function navigate(url) {
  const m = await requireBrowser();
  const info = await m.navigate(url);
  broadcastTitle(info);
  broadcastNavState();
  return info;
}

async function restartScreencast(m) {
  if (!m || m.screencastActive) return;
  try {
    await m.startScreencast({ quality: frameQuality, maxWidth: frameMaxDimension, maxHeight: frameMaxDimension });
  } catch {
    /* best-effort */
  }
}

async function broadcastTabsNow(m) {
  try {
    const tabs = await m.listTabs();
    const payload = JSON.stringify({ type: "tabs", activeId: m.pageTargetId, tabs });
    for (const client of clients) {
      if (client.readyState === 1) {
        try {
          client.send(payload);
        } catch {
          /* ignore */
        }
      }
    }
    const active = tabs.find((t) => t.id === m.pageTargetId);
    if (active) broadcastTitle({ title: active.title, url: active.url });
    bindNavRefresh(m);
    await broadcastNavState();
    return tabs;
  } catch {
    return [];
  }
}

function broadcastTitle(info) {
  const payload = JSON.stringify({ type: "title", title: info.title, url: info.url });
  for (const client of clients) {
    if (client.readyState === 1) {
      try {
        client.send(payload);
      } catch {
        /* ignore */
      }
    }
  }
}

async function broadcastNavState() {
  if (!manager) return;
  try {
    const h = await manager.history();
    broadcast({
      type: "nav",
      canGoBack: h.currentIndex > 0,
      canGoForward: h.currentIndex < h.entries.length - 1
    });
  } catch {
    /* ignore */
  }
}

// Re-bind the active session's frameNavigated listener so back/forward
// availability stays fresh after in-page navigation and tab switches.
let navUnsub = null;
function bindNavRefresh(m) {
  if (!m) return;
  try {
    if (navUnsub) {
      navUnsub();
      navUnsub = null;
    }
    navUnsub = m.onEvent("Page.frameNavigated", () => {
      broadcastNavState();
    });
  } catch {
    /* ignore */
  }
}

function shotDir(workspace) {
  const dir = join(workspace, "browser-shots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function workspaceOf(exec) {
  return exec?.agent?.session?.header?.cwd ?? process.cwd();
}

// ---------------------------------------------------------------------------
// Tool helpers
// ---------------------------------------------------------------------------
function renderJson(_args, value) {
  return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

const VIEWPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { width: { type: "number" }, height: { type: "number" } }
};

/**
 * While the human is in "operate" mode (driving the shared browser), the agent
 * must not grab the controls — that is the whole point of the mode split.
 * Write tools (click/type/key/navigate) refuse loudly; read-only tools keep
 * working so the agent can still watch and answer.
 */
function assertAgentCanWrite() {
  if (viewMode === "operate") {
    throw new Error(
      "用户正在操作共享浏览器（用户操作模式）。为防止与用户抢操作，Agent 暂不能点击/输入/导航。" +
      "请等待用户切回仅观看模式后重试（用 browser_status 查看当前 mode）。"
    );
  }
}

const STATUS_PROPERTIES = {
  running: { type: "boolean", required: true },
  pid: { type: "number" },
  headless: { type: "boolean" },
  clients: { type: "number", required: true },
  chrome: { type: "string" },
  headful: { type: "boolean" },
  mode: { type: "string" },
  profileDir: { type: "string" },
  viewport: VIEWPORT_SCHEMA,
  url: { type: "string" },
  title: { type: "string" }
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
// Client files (widget.js / publish.html) are served through an mtime cache so
// front-end edits take effect on the next page load WITHOUT restarting dsh web.
// Only server-side code in lib/ still needs a restart to load.
const clientFileCache = new Map();
function readClientFile(rel) {
  const p = fileURLToPath(new URL(rel, import.meta.url));
  let mtime = 0;
  try {
    mtime = statSync(p).mtimeMs;
  } catch {
    /* file missing */
  }
  const entry = clientFileCache.get(p);
  if (!entry || entry.mtime !== mtime) {
    const fresh = { mtime, src: readFileSync(p, "utf8") };
    clientFileCache.set(p, fresh);
    return fresh.src;
  }
  return entry.src;
}

function apply(ctx, config) {
  frameIntervalMs = config.frameIntervalMs;
  frameQuality = config.frameQuality;
  frameMaxDimension = config.frameMaxDimension;

  // --- HTTP routes ----------------------------------------------------------
  const rejected = (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection === undefined) return false;
    res.statusCode = rejection;
    res.end();
    return true;
  };

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: STATUS_URL,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const info = statusInfo();
      if (info.running) Object.assign(info, await pageInfoSafe());
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(info));
    }
  }), `browser-share: GET ${STATUS_URL}`);

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: WIDGET_URL,
    handler: async (req, res) => {
      // widget.js is static client code with no secrets: served anonymously so
      // the public /publish page can inject the panel shell for everyone. The
      // control channel (WS), status and MJPEG stay behind the fence.
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });
      res.end(readClientFile("../client/widget.js"));
    }
  }), `browser-share: GET ${WIDGET_URL}`);

  // Public landing page: statically served WITHOUT auth so anyone can read the
  // intro; the embedded widget still requires the token-carrying link to drive
  // the shared browser (WS/status routes keep their fence checks).
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: PUBLISH_URL,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(readClientFile("../client/publish.html"));
    }
  }), `browser-share: GET ${PUBLISH_URL}`);

  // Plugin distribution endpoints: let ANY dsh harness install this plugin.
  const PLUGIN_PREFIX = "/plugin";
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: `${PLUGIN_PREFIX}/download`,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const zip = buildPluginZip();
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="dsh-tool-browser-2.1.0.zip"',
        "content-length": String(zip.length),
        "cache-control": "no-cache"
      });
      res.end(zip);
    }
  }), `browser-share: GET ${PLUGIN_PREFIX}/download`);

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: `${PLUGIN_PREFIX}/readme`,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const readme = readFileSync(fileURLToPath(new URL("../README.md", import.meta.url)), "utf8");
      res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-cache" });
      res.end(readme);
    }
  }), `browser-share: GET ${PLUGIN_PREFIX}/readme`);

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: `${PLUGIN_PREFIX}/manifest`,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const manifest = readFileSync(fileURLToPath(new URL("../manifest.json", import.meta.url)), "utf8");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(manifest);
    }
  }), `browser-share: GET ${PLUGIN_PREFIX}/manifest`);

  // One-command installer script for other harnesses.
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: `${PLUGIN_PREFIX}/install.sh`,
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const script = readFileSync(fileURLToPath(new URL("../client/install.sh", import.meta.url)), "utf8");
      res.writeHead(200, { "content-type": "text/x-shellscript; charset=utf-8", "cache-control": "no-cache" });
      res.end(script);
    }
  }), `browser-share: GET ${PLUGIN_PREFIX}/install.sh`);

  // Repo distribution: a complete git tarball + landing page so anyone can
  // pull the whole source and push it to their own GitHub.
  const REPO_DIR = process.env.DSH_REPO_DIR ?? "/home/dsh/repo-dl";
  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/repo",
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const page = join(REPO_DIR, "index.html");
      if (!existsSync(page)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("repo page not configured (DSH_REPO_DIR)");
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      res.end(readFileSync(page));
    }
  }), "browser-share: GET /repo");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: "/repo/download",
    handler: (req, res) => {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.statusCode = 405;
        res.end();
        return;
      }
      const tarball = join(REPO_DIR, "dsh-tool-browser-repo.tar.gz");
      if (!existsSync(tarball)) {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("repo tarball not configured (DSH_REPO_DIR)");
        return;
      }
      res.writeHead(200, {
        "content-type": "application/gzip",
        "content-disposition": 'attachment; filename="dsh-tool-browser-repo.tar.gz"',
        "content-length": String(statSync(tarball).size),
        "cache-control": "no-cache"
      });
      res.end(readFileSync(tarball));
    }
  }), "browser-share: GET /repo/download");

  ctx.effect(() => ctx.webServer.register({
    kind: "exact",
    path: MJPEG_URL,
    handler: (req, res) => {
      if (rejected(req, res)) return;
      if (req.method !== "GET") {
        res.statusCode = 405;
        res.end();
        return;
      }
      startMpeg(res);
    }
  }), `browser-share: GET ${MJPEG_URL}`);

  ctx.effect(() => ctx.webServer.register({
    kind: "prefix",
    path: SHOTS_PREFIX,
    handler: async (req, res) => {
      if (rejected(req, res)) return;
      const name = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname.slice(SHOTS_PREFIX.length));
      if (name.includes("/") || name.includes("\\") || name.includes("..")) {
        res.statusCode = 400;
        res.end();
        return;
      }
      const root = process.env.DSH_WORKSPACE ?? process.cwd();
      const file = join(shotDir(root), name);
      if (!existsSync(file)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-cache" });
      res.end(readFileSync(file));
    }
  }), `browser-share: GET ${SHOTS_PREFIX}*`);

  // --- WebSocket share route -------------------------------------------------
  const wss = new WebSocketServer({ noServer: true });
  let inputQueue = [];
  let draining = false;
  let dragGesture = null; // HTML5 draggable gesture state { draggable, started, data, pressX, pressY }

  function pushInput(msg) {
    // Coalesce consecutive mouse moves into the latest position so a drag is
    // [press -> (moves merged) -> release]: no backlog, no lag, and releases
    // are never queued behind a pile of stale moves.
    if (msg.kind === "mouse" && msg.op === "mouseMoved") {
      const last = inputQueue[inputQueue.length - 1];
      if (last && last.kind === "mouse" && last.op === "mouseMoved") {
        last.x = msg.x;
        last.y = msg.y;
        last.buttons = msg.buttons ?? 0;
        last.modifiers = msg.modifiers ?? 0;
        return;
      }
    }
    inputQueue.push(msg);
    drainInput();
  }

  async function drainInput() {
    if (draining) return;
    draining = true;
    while (inputQueue.length > 0) {
      const msg = inputQueue.shift();
      try {
        await onInput(msg);
      } catch {
        /* ignore */
      }
    }
    draining = false;
  }

  async function evalInPage(m, expression) {
    const result = await m.session.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });
    if (result.exceptionDetails) return undefined;
    return result.result?.value;
  }

  // CDP Input.dispatchMouseEvent.button is a string enum ("left"|"middle"|
  // "right"|"back"|"forward"); widget/PO events deliver numeric e.button.
  const BUTTON_MAP = { 0: "left", 1: "middle", 2: "right", 3: "back", 4: "forward" };
  function normButton(b) {
    if (typeof b === "string") return b;
    return BUTTON_MAP[b] ?? "left";
  }

  function rejectUpgrade(socket, status) {
    const reason = status === 401 ? "Unauthorized" : "Forbidden";
    const body = reason.toLowerCase();
    socket.end([
      `HTTP/1.1 ${String(status)} ${reason}`,
      "Connection: close",
      "Content-Type: text/plain; charset=utf-8",
      `Content-Length: ${String(Buffer.byteLength(body))}`,
      "",
      body
    ].join("\r\n"));
  }

  async function onInput(msg) {
    const m = manager;
    if (!m) return;
    const params = msg;
    try {
      switch (msg.kind) {
        case "mouse": {
          const btnOf = (b) => (b & 1) ? "left" : (b & 2) ? "right" : (b & 4) ? "middle" : "none";
          const common = {
            x: params.x,
            y: params.y,
            modifiers: params.modifiers ?? 0,
            buttons: params.buttons ?? 0,
            // moves during a press-drag need the held button or CDP drops them
            button: btnOf(params.buttons ?? 0)
          };
          switch (params.op) {
            case "mousePressed":
              dragGesture = { draggable: false, started: false, data: null, pressX: params.x, pressY: params.y };
              await m.session.send("Input.dispatchMouseEvent", {
                type: "mousePressed",
                ...common,
                button: normButton(params.button),
                clickCount: params.clickCount ?? 1
              });
              // Detect a native HTML5 draggable under the cursor (async, so a
              // plain click is never delayed by the probe).
              if (params.button !== "right" && params.button !== 2) {
                evalInPage(m, `(() => { const el = document.elementFromPoint(${Math.round(params.x)}, ${Math.round(params.y)}); const s = el && el.closest ? (el.closest('[draggable]') || (el.draggable ? el : null)) : null; return !!s; })()`)
                  .then((d) => {
                    if (dragGesture && !dragGesture.started) dragGesture.draggable = d === true;
                  })
                  .catch(() => {});
              }
              break;
            case "mouseReleased": {
              if (dragGesture?.started && dragGesture.draggable && dragGesture.data) {
                // HTML5 DnD: drop at the release point, then notify dragend.
                await m.session.send("Input.dispatchDragEvent", { type: "drop", x: Math.round(params.x), y: Math.round(params.y), data: dragGesture.data }).catch(() => {});
                evalInPage(m, `(() => { const dt = window.__dshDragDT__; const s = window.__dshDragSrc__; if (s && dt) s.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt })); window.__dshDragDT__ = null; window.__dshDragSrc__ = null; return true; })()`).catch(() => {});
                dragGesture = null;
              } else {
                await m.session.send("Input.dispatchMouseEvent", {
                  type: "mouseReleased",
                  ...common,
                  button: normButton(params.button),
                  clickCount: params.clickCount ?? 1
                });
              }
              break;
            }
            case "mouseMoved": {
              const buttons = params.buttons ?? 0;
              if (buttons > 0 && dragGesture?.draggable) {
                if (!dragGesture.started) {
                  // Start the native-style drag: let the page populate a real
                  // DataTransfer via dragstart, read its payload, then drive
                  // dragEnter/dragOver with Input.dispatchDragEvent.
                  dragGesture.started = true;
                  const info = await evalInPage(m, `(async () => { const el = document.elementFromPoint(${Math.round(dragGesture.pressX)}, ${Math.round(dragGesture.pressY)}); const s = el && el.closest ? (el.closest('[draggable]') || (el.draggable ? el : null)) : null; if (!s) return null; const dt = new DataTransfer(); if (!s.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))) return { canceled: true }; window.__dshDragDT__ = dt; window.__dshDragSrc__ = s; const items = []; for (let i = 0; i < dt.items.length; i++) { const mime = dt.items[i].type; let data = ''; try { data = dt.getData(mime); } catch (e) {} items.push({ mimeType: mime, data }); } return { canceled: false, items }; })()`);
                  if (info && info.canceled !== true) {
                    dragGesture.data = { items: info?.items ?? [], dragOperationsMask: 1 };
                    await m.session.send("Input.dispatchDragEvent", { type: "dragEnter", x: Math.round(params.x), y: Math.round(params.y), data: dragGesture.data }).catch(() => {});
                    await m.session.send("Input.dispatchDragEvent", { type: "dragOver", x: Math.round(params.x), y: Math.round(params.y), data: dragGesture.data }).catch(() => {});
                  } else {
                    // dragstart was canceled or source vanished -> plain mouse path
                    dragGesture.draggable = false;
                    await m.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...common });
                  }
                } else {
                  await m.session.send("Input.dispatchDragEvent", { type: "dragOver", x: Math.round(params.x), y: Math.round(params.y), data: dragGesture.data }).catch(() => {});
                }
              } else {
                await m.session.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...common });
              }
              break;
            }
            case "mouseWheel":
              await m.session.send("Input.dispatchMouseEvent", {
                type: "mouseWheel",
                ...common,
                deltaX: params.deltaX ?? 0,
                deltaY: params.deltaY ?? 0
              });
              break;
            default:
              break;
          }
          break;
        }
        case "key": {
          const key = params.key ?? "";
          const code = params.code ?? "";
          const modifiers = params.modifiers ?? 0;
          const vk = vkFor(key, code);
          const vkFields = vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {};
          if (params.op === "char") {
            await m.session.send("Input.dispatchKeyEvent", { type: "char", key, code, text: key, unmodifiedText: key });
          } else if (params.op === "keyDown") {
            const isPrintable = isPrintableKey(key) && (modifiers & 7) === 0; // no ctrl/meta/alt
            if (isPrintable) {
              await m.session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers, ...(params.repeat ? { repeat: true } : {}) });
            } else if (key === "Enter") {
              await m.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, ...vkFields, ...(params.repeat ? { repeat: true } : {}) });
              await m.session.send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", unmodifiedText: "\r" });
            } else {
              await m.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, ...vkFields, ...(params.repeat ? { repeat: true } : {}) });
            }
          } else if (params.op === "keyUp") {
            await m.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, ...vkFields });
          }
          break;
        }
        case "touch": {
          const touchPoints = (params.points ?? []).map((point, index) => ({
            x: point.x,
            y: point.y,
            id: point.id ?? index,
            radiusX: point.radiusX ?? 2,
            radiusY: point.radiusY ?? 2,
            force: point.force ?? 1
          }));
          const op = params.op === "touchEnd" ? "touchEnd" : params.op === "touchMove" ? "touchMove" : "touchStart";
          await m.session.send("Input.dispatchTouchEvent", { type: op, touchPoints });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.error("[dsh-tool-browser] input forwarding failed", error);
    }
  }

  function sendNotice(wsClient, text) {
    try {
      wsClient.send(JSON.stringify({ type: "notice", text }));
    } catch {
      /* ignore */
    }
  }

  async function handleClientMessage(msg, wsClient) {
    switch (msg.type) {
      case "hello":
      case "status":
        broadcastStatus();
        break;
      case "url": {
        if (!manager) {
          try {
            await ensureBrowser({ url: msg.url });
          } catch (error) {
            sendNotice(wsClient, `启动浏览器失败: ${error.message}`);
          }
        } else {
          try {
            const info = await navigate(msg.url);
            sendNotice(wsClient, `已打开 ${info.url}`);
          } catch (error) {
            sendNotice(wsClient, `打开失败: ${error.message}`);
          }
        }
        break;
      }
      case "cmd": {
        try {
          switch (msg.command) {
            case "open":
              await ensureBrowser({ url: msg.url });
              sendNotice(wsClient, "浏览器已启动，画面即将出现");
              break;
            case "close":
              if (manager) {
                const m = manager;
                manager = null;
                lastFrame = null;
                stopBroadcast();
                endMpeg();
                await m.close();
                broadcastStatus();
                sendNotice(wsClient, "浏览器已关闭");
              }
              break;
            case "refresh": {
              const m = await requireBrowser();
              const info = await m.pageInfo();
              if (info.url) await navigate(info.url);
              break;
            }
            case "screenshot": {
              const m = await requireBrowser();
              const data = await m.screenshot({ format: "png" });
              const dir = shotDir(process.env.DSH_WORKSPACE ?? process.cwd());
              const stamp = new Date().toISOString().replace(/[:.]/g, "-");
              const file = join(dir, `browser-${stamp}.png`);
              writeFileSync(file, Buffer.from(data, "base64"));
              sendNotice(wsClient, `截图已保存: ${file}`);
              break;
            }
            case "resize": {
              const m = await requireBrowser();
              const w = Math.max(320, Math.min(2560, Math.round(Number(msg.width) || 1280)));
              const h = Math.max(240, Math.min(1600, Math.round(Number(msg.height) || 800)));
              await m.applyViewport({ width: w, height: h });
              await broadcastStatus();
              sendNotice(wsClient, `页面视口已调整为 ${w}×${h}`);
              break;
            }
            default:
              break;
          }
        } catch (error) {
          sendNotice(wsClient, `操作失败: ${error.message}`);
        }
        break;
      }
      case "eval": {
        // Authorized clients may read shared-page state (same trust level as
        // the agent's browser_eval). Expression must be self-contained.
        try {
          const m = await requireBrowser();
          const value = await evalInPage(m, msg.expression ?? "null");
          let safe;
          try {
            safe = JSON.stringify(value);
          } catch {
            safe = String(value);
          }
          wsClient.send(JSON.stringify({ type: "evalResult", id: msg.id ?? null, value: safe }));
        } catch (error) {
          wsClient.send(JSON.stringify({ type: "evalResult", id: msg.id ?? null, error: error.message }));
        }
        break;
      }
      case "tabs": {
        try {
          const m = await requireBrowser();
          switch (msg.command) {
            case "list":
              wsClient.send(JSON.stringify({ type: "tabsResult", id: msg.id ?? null, activeId: m.pageTargetId, tabs: await m.listTabs() }));
              break;
            case "new": {
              const tab = await m.openTab(msg.url ?? "about:blank");
              await m.switchToTab(tab.id);
              await restartScreencast(m);
              await broadcastTabsNow(m);
              sendNotice(wsClient, `新标签已打开: ${tab.title || tab.url}`);
              break;
            }
            case "activate": {
              await m.switchToTab(msg.id);
              await restartScreencast(m);
              await broadcastTabsNow(m);
              sendNotice(wsClient, "已切换到标签");
              break;
            }
            case "close": {
              await m.closeTab(msg.id);
              await restartScreencast(m);
              await broadcastTabsNow(m);
              sendNotice(wsClient, "标签已关闭");
              break;
            }
            default:
              break;
          }
        } catch (error) {
          sendNotice(wsClient, `标签操作失败: ${error.message}`);
        }
        break;
      }
      case "nav": {
        try {
          const m = await requireBrowser();
          switch (msg.command) {
            case "history": {
              const h = await m.history();
              wsClient.send(JSON.stringify({
                type: "nav",
                command: "history",
                currentIndex: h.currentIndex,
                entries: h.entries.map((e) => ({ id: e.id, url: e.url, title: e.title ?? "", userTypedURL: e.userTypedURL ?? "" }))
              }));
              break;
            }
            case "back": {
              const info = await m.back();
              broadcastTitle(info);
              await broadcastNavState();
              sendNotice(wsClient, info.moved ? "已后退" : "已经是第一页");
              break;
            }
            case "forward": {
              const info = await m.forward();
              broadcastTitle(info);
              await broadcastNavState();
              sendNotice(wsClient, info.moved ? "已前进" : "已经是最后一页");
              break;
            }
            case "goto": {
              const info = await m.goToHistoryEntry(msg.entryId);
              broadcastTitle(info);
              await broadcastNavState();
              break;
            }
            default:
              break;
          }
        } catch (error) {
          sendNotice(wsClient, `历史操作失败: ${error.message}`);
        }
        break;
      }
      case "mode":
        // Human flips between watch-only ("view", default) and operating the
        // browser ("operate"). In "view", input is dropped (below); in
        // "operate", agent write tools refuse (assertAgentCanWrite).
        viewMode = msg.mode === "operate" ? "operate" : "view";
        broadcastStatus();
        sendNotice(wsClient, viewMode === "operate" ? "已切换到用户操作模式" : "已切换到仅观看模式");
        break;
      case "input": {
        // Watch-only mode: never forward human input (defense in depth — also
        // drops forged clients that bypass the widget's own gating).
        if (viewMode === "view") return;
        // Instant viewer feedback: echo the action and track the live cursor so
        // humans see input register even before the next video frame arrives.
        if (msg.kind === "mouse") {
          if (msg.op === "mouseMoved") {
            broadcastCursor(msg.x, msg.y);
          } else if (msg.op === "mousePressed" || msg.op === "mouseReleased") {
            broadcast({ type: "echo", kind: "mouse", op: msg.op, x: msg.x, y: msg.y, button: msg.button ?? "left" });
          }
        } else if (msg.kind === "key") {
          if (msg.op === "keyDown") broadcast({ type: "echo", kind: "key", key: msg.key });
        } else if (msg.kind === "touch") {
          broadcast({ type: "echo", kind: "touch", op: msg.op, points: msg.points ?? [] });
        }
        pushInput(msg);
        break;
      }
      default:
        break;
    }
  }

  ctx.effect(() => {
    const route = {
      path: WS_URL,
      handler: (req, socket, head) => {
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          rejectUpgrade(socket, rejection);
          return;
        }
        wss.handleUpgrade(req, socket, head, (wsClient) => {
          clients.add(wsClient);
          broadcastStatus();
          if (lastFrame) {
            try {
              const jpeg = Buffer.from(lastFrame.data, "base64");
              const header = Buffer.alloc(9);
              header[0] = 1;
              header.writeUInt32BE(lastFrame.width, 1);
              header.writeUInt32BE(lastFrame.height, 5);
              wsClient.send(Buffer.concat([header, jpeg]));
            } catch {
              /* ignore */
            }
          }
          wsClient.on("message", (raw) => {
            let msg;
            try {
              msg = JSON.parse(String(raw));
            } catch {
              return;
            }
            handleClientMessage(msg, wsClient);
          });
          wsClient.on("close", () => {
            clients.delete(wsClient);
            broadcastStatus();
          });
          wsClient.on("error", () => {
            clients.delete(wsClient);
          });
        });
      }
    };
    const unregister = ctx.webServer.registerUpgrade(route);
    return async () => {
      unregister();
      for (const client of clients) client.terminate();
      clients.clear();
      await new Promise((resolve2) => wss.close(resolve2));
    };
  }, `browser-share: WS ${WS_URL}`);

  // --- index injection: the shared-view widget ------------------------------
  ctx.on("webserver/index-inject", (table) => {
    table.push({ kind: "script-src", placement: "body", src: WIDGET_URL });
  });

  // --- tools -----------------------------------------------------------------
  ctx.tools.register(defineTool({
    name: "browser_launch",
    description: "Launch the shared headful browser (a real Chrome instance). After launch the user sees the live screen in the Web GUI's \"共享浏览器\" panel and can operate it together with you. Idempotent: if already running, returns the current status and optionally navigates to `url`. Coordinates used by browser_click are CSS pixels of the viewport.",
    parameters: {
      url: { type: "string", description: "Optional URL to open immediately after launch." },
      width: { type: "integer", description: "Viewport width in CSS pixels (default 1280)." },
      height: { type: "integer", description: "Viewport height in CSS pixels (default 800)." },
      headful: { type: "boolean", description: "Request a headed (not headless) window when a display exists; on servers without X it falls back to headless=new — the shared screen is identical either way." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: STATUS_PROPERTIES },
      render: renderJson
    },
    async execute(args) {
      await ensureBrowser({
        url: args.url,
        width: args.width,
        height: args.height,
        headful: args.headful
      });
      const info = statusInfo();
      if (info.running) Object.assign(info, await pageInfoSafe());
      return cleanJson(info);
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_navigate",
    description: "Navigate the shared browser to `url` and wait for the page load.",
    parameters: {
      url: { type: "string", required: true, description: "Absolute URL to open." },
      timeoutMs: { type: "integer", description: "Optional load timeout in milliseconds." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        url: { type: "string", required: true },
        title: { type: "string", required: true },
        viewport: VIEWPORT_SCHEMA
      } },
      render: renderJson
    },
    async execute(args) {
      assertAgentCanWrite();
      return cleanJson(await navigate(args.url));
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_click",
    description: "Click at viewport-CSS-pixel coordinates (x, y) in the shared browser. Take a screenshot (browser_screenshot) or evaluate layout via browser_eval to locate targets.",
    parameters: {
      x: { type: "number", required: true, description: "Horizontal CSS pixel from the viewport top-left." },
      y: { type: "number", required: true, description: "Vertical CSS pixel from the viewport top-left." },
      button: { type: "string", enum: ["left", "right", "middle"], description: "Mouse button (default left)." },
      clickCount: { type: "integer", description: "1 or 2 for double click (default 1)." },
      modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] }, description: "Modifier keys held during the click." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        x: { type: "number", required: true },
        y: { type: "number", required: true },
        viewport: VIEWPORT_SCHEMA
      } },
      render: renderJson
    },
    async execute(args) {
      assertAgentCanWrite();
      const m = await requireBrowser();
      let modifiers = 0;
      for (const mod of args.modifiers ?? []) modifiers |= { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[mod];
      const clickCount = args.clickCount ?? 1;
      if (clickCount === 2) {
        await m.click(args.x, args.y, { modifiers, button: args.button ?? "left" });
        await m.click(args.x, args.y, { modifiers, button: args.button ?? "left" });
      } else {
        await m.click(args.x, args.y, { modifiers, button: args.button ?? "left" });
      }
      return cleanJson({ x: args.x, y: args.y, viewport: { ...m.viewport } });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_type",
    description: "Type `text` into the focused element of the shared browser. Combine with browser_click to focus an input first.",
    parameters: {
      text: { type: "string", required: true, description: "Text to type." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { typed: { type: "integer", required: true } } },
      render: renderJson
    },
    async execute(args) {
      assertAgentCanWrite();
      const m = await requireBrowser();
      await m.typeText(args.text);
      return cleanJson({ typed: String(args.text).length });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_key",
    description: "Press a named key in the shared browser (Enter, Tab, Backspace, Delete, Escape, ArrowUp/Left/Down/Right, Home, End, PageUp, PageDown, F1..F12, Space, or a single character).",
    parameters: {
      key: { type: "string", required: true, description: "Key name as reported by DOM KeyboardEvent.key (e.g. \"Enter\", \"Tab\", \"ArrowDown\", \"a\")." },
      modifiers: { type: "array", items: { type: "string", enum: ["Alt", "Control", "Meta", "Shift"] }, description: "Modifier keys held during the press." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { key: { type: "string", required: true } } },
      render: renderJson
    },
    async execute(args) {
      assertAgentCanWrite();
      const m = await requireBrowser();
      let modifiers = 0;
      for (const mod of args.modifiers ?? []) modifiers |= { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[mod];
      const key = args.key;
      const CODE_MAP = { " ": "Space", Space: "Space", Enter: "Enter", Backspace: "Backspace", Tab: "Tab", Delete: "Delete", Escape: "Escape", ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight", Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown" };
      const code = /^[a-z]$/i.test(key) ? "Key" + key.toUpperCase() : CODE_MAP[key] ?? (key.length === 1 ? "None" : key);
      if (isPrintableKey(key)) {
        // keyDown WITHOUT text — the char event carries the text; putting text
        // on both double-inserts ("aabbcc").
        await m.session.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
        await m.session.send("Input.dispatchKeyEvent", { type: "char", key, code: "None", text: key, modifiers });
        await m.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
      } else {
        const vk = vkFor(key, code);
        const vkFields = vk !== undefined ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {};
        if (key === "Enter") {
          await m.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, ...vkFields });
          await m.session.send("Input.dispatchKeyEvent", { type: "char", key, code, text: "\r", unmodifiedText: "\r" });
          await m.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, ...vkFields });
        } else {
          await m.session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, modifiers, ...vkFields });
          await m.session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, ...vkFields });
        }
      }
      return cleanJson({ key });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_screenshot",
    description: "Capture the current page of the shared browser as a PNG file and return its path plus a download URL. Read the image with the read_image tool to see what the browser shows. Coordinates for browser_click come from the viewport dimensions in the result.",
    parameters: {
      path: { type: "string", description: "Optional absolute or workspace-relative output path (.png). Defaults to browser-shots/browser-<timestamp>.png." },
      fullPage: { type: "boolean", description: "Capture the full scrollable page height (default false)." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        path: { type: "string", required: true },
        url: { type: "string", required: true },
        bytes: { type: "number" },
        viewport: VIEWPORT_SCHEMA
      } },
      render: renderJson
    },
    async execute(args, exec) {
      const workspace = workspaceOf(exec);
      const m = await requireBrowser();
      const data = await m.screenshot({ format: "png", fullPage: args.fullPage ?? false });
      let file;
      if (args.path) {
        file = isAbsolute(args.path) ? args.path : resolve(workspace, args.path);
        if (extname(file).toLowerCase() !== ".png") file += ".png";
        mkdirSync(dirname(file), { recursive: true });
      } else {
        const dir = shotDir(workspace);
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        file = join(dir, `browser-${stamp}.png`);
      }
      const buffer = Buffer.from(data, "base64");
      writeFileSync(file, buffer);
      return cleanJson({
        path: file,
        url: `${SHOTS_PREFIX}${file.split(/[\\/]/).pop()}`,
        bytes: buffer.length,
        viewport: { ...m.viewport }
      });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_eval",
    description: "Run a JavaScript expression in the shared browser page and return its JSON value. Useful to read state, click by selector (document.querySelector(...).click()), or compute bounding boxes: JSON.stringify([...document.querySelectorAll('a,button,input,textarea')].map(e => ({tag:e.tagName, text:(e.innerText||e.value||'').slice(0,40), rect:e.getBoundingClientRect().toJSON()}))).",
    parameters: {
      expression: { type: "string", required: true, description: "JavaScript expression to evaluate in the page." },
      awaitPromise: { type: "boolean", description: "Await promises returned by the expression (default true)." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        type: { type: "string" },
        subtype: { type: "string" },
        value: { type: "string", description: "JSON-serialized result value; null when the value cannot be serialized." },
        description: { type: "string" }
      } },
      render: renderJson
    },
    async execute(args) {
      const m = await requireBrowser();
      const result = await m.eval(args.expression, { awaitPromise: args.awaitPromise ?? true });
      return cleanJson({
        type: result.type,
        subtype: result.subtype,
        value: result.value === undefined ? "undefined" : typeof result.value === "string" ? result.value : JSON.stringify(result.value),
        description: result.description
      });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_status",
    description: "Return the current state of the shared browser: running, pid, headless, connected viewers, viewport, and the current page title/url.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: STATUS_PROPERTIES },
      render: renderJson
    },
    async execute() {
      const info = statusInfo();
      if (info.running) Object.assign(info, await pageInfoSafe());
      return cleanJson(info);
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_close",
    description: "Close the shared browser. The user's shared-view panel returns to its idle state.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: { closed: { type: "boolean", required: true } } },
      render: renderJson
    },
    async execute() {
      if (!manager) return { closed: true };
      const m = manager;
      manager = null;
      lastFrame = null;
      stopBroadcast();
      await m.close();
      broadcastStatus();
      return cleanJson({ closed: true });
    }
  }));

  const TAB_LIST_SCHEMA = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string" }, url: { type: "string" }, title: { type: "string" } }
    }
  };

  ctx.tools.register(defineTool({
    name: "browser_tab_new",
    description: "Open a new tab in the shared browser and make it active (screencast, input and eval follow the active tab). Returns the new tab's id/url/title and the active tab id.",
    parameters: {
      url: { type: "string", description: "URL to open in the new tab (default about:blank)." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string", required: true },
        url: { type: "string" },
        title: { type: "string" },
        activeId: { type: "string" },
        tabCount: { type: "number" }
      } },
      render: renderJson
    },
    async execute(args) {
      const m = await requireBrowser();
      const tab = await m.openTab(args.url ?? "about:blank");
      await m.switchToTab(tab.id);
      await restartScreencast(m);
      const tabs = await broadcastTabsNow(m);
      return cleanJson({ ...tab, activeId: m.pageTargetId, tabCount: tabs.length });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_tab_list",
    description: "List all open tabs of the shared browser plus the active tab id.",
    parameters: {},
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        activeId: { type: "string" },
        tabs: TAB_LIST_SCHEMA
      } },
      render: renderJson
    },
    async execute() {
      const m = await requireBrowser();
      return cleanJson({ activeId: m.pageTargetId, tabs: await m.listTabs() });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_tab_activate",
    description: "Switch the shared browser to the given tab id; screencast/input/eval all follow the active tab.",
    parameters: {
      id: { type: "string", required: true, description: "Tab id from browser_tab_list." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        id: { type: "string" },
        url: { type: "string" },
        title: { type: "string" },
        viewport: VIEWPORT_SCHEMA
      } },
      render: renderJson
    },
    async execute(args) {
      const m = await requireBrowser();
      const info = await m.switchToTab(args.id);
      await restartScreencast(m);
      await broadcastTabsNow(m);
      return cleanJson({ id: args.id, ...info });
    }
  }));

  ctx.tools.register(defineTool({
    name: "browser_tab_close",
    description: "Close a tab by id. If it was the active tab, switch to the first remaining tab (or reopen a blank one).",
    parameters: {
      id: { type: "string", required: true, description: "Tab id from browser_tab_list." }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {
        closed: { type: "boolean", required: true },
        activeId: { type: "string" },
        tabs: TAB_LIST_SCHEMA
      } },
      render: renderJson
    },
    async execute(args) {
      const m = await requireBrowser();
      const closed = await m.closeTab(args.id);
      await restartScreencast(m);
      const tabs = await broadcastTabsNow(m);
      return cleanJson({ closed, activeId: m.pageTargetId, tabs });
    }
  }));

  // --- cleanup ---------------------------------------------------------------
  ctx.effect(() => async () => {
    stopBroadcast();
    if (manager) {
      const m = manager;
      manager = null;
      await m.close().catch(() => {});
    }
  }, "browser-share: dispose browser");
}

export { Config, apply, inject, name };