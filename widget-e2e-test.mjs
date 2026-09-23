#!/usr/bin/env node
/**
 * widget-e2e-test.mjs
 * ------------------------------------------------------------------
 * 真实浏览器端到端测试脚本：DeepSeek harness shared-browser 插件（浏览器 Widget）
 *
 * 依赖：仅 Node 内置模块 + 'ws' 包
 * 用法：node widget-e2e-test.mjs [widget.js 路径]
 *       不传参时默认读取脚本所在目录下的 client/widget.js
 *       可用环境变量 CHROME_PATH 指定 Chrome/Edge/Chromium 可执行文件
 *
 * 流程：
 *   1. 启动一个临时 HTTP 服务器，提供 / 与 /widget.js
 *   2. 拉起无头浏览器（--remote-debugging-port=0），从 stderr 解析 DevTools 端口
 *   3. 通过 CDP HTTP 接口（PUT /json/new?<url>）打开页面 target
 *   4. 通过 WebSocket 连接 target，Runtime.evaluate 断言 Widget DOM 结构
 *   5. 输出 [PASS]/[FAIL]，全部通过退出码 0，否则 1
 *   6. 清理：关闭 target、杀掉浏览器进程、删除临时目录、关闭 HTTP 服务器
 * ------------------------------------------------------------------
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// ------------------------------------------------------------------
// 基础常量
// ------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// 默认被测 widget 文件：脚本同目录下的 client/widget.js
const DEFAULT_WIDGET_REL = path.join('client', 'widget.js');

// 需要断言的选择器集合（第一个为根节点，其余为根节点内部必须存在的元素）
const SELECTORS = [
  '#dsh-browser-widget-root',
  '.dbw-navbar',
  '.dbw-fab',
  '[data-role="mode"]',
  '[data-role="tabs"]',
  '[data-role="grip"]',
];

// 等待页面渲染 / Widget 挂载的最长时间
const RENDER_TIMEOUT_MS = 15000;
// 等待浏览器启动并输出 DevTools 端口的最长时间
const BROWSER_BOOT_TIMEOUT_MS = 30000;

// ------------------------------------------------------------------
// 断言工具
// ------------------------------------------------------------------

let failed = 0;
let passed = 0;

/** 记录并打印一条断言结果 */
function check(name, ok, extra = '') {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
  }
  const tag = ok ? '[PASS]' : '[FAIL]';
  console.log(`${tag} ${name}${extra ? ` — ${extra}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// 全局资源句柄（供清理函数使用）
// ------------------------------------------------------------------

let httpServer = null;
let httpPort = 0;
let chromeProc = null;
let userDataDir = null;
let devtoolsPort = null;
let targetId = null;
let cdp = null;

// ------------------------------------------------------------------
// 1. 极简 HTTP 服务器
// ------------------------------------------------------------------

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>widget e2e test</title>
</head>
<body>
  <div id="page-host"></div>
  <script src="/widget.js" defer></script>
</body>
</html>
`;

/**
 * 启动本地静态服务器：
 *   GET /            -> 测试用 HTML 页面（引用 /widget.js）
 *   GET /widget.js   -> 被测 widget 文件内容
 */
function startHttpServer(widgetCode) {
  return new Promise((resolve, reject) => {
    httpServer = http.createServer((req, res) => {
      let pathname = '/';
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      } catch {
        pathname = req.url || '/';
      }

      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE_HTML);
        return;
      }

      if (pathname === '/widget.js') {
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(widgetCode);
        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
    });

    httpServer.on('error', reject);
    // 监听 127.0.0.1 的随机空闲端口
    httpServer.listen(0, '127.0.0.1', () => {
      const addr = httpServer.address();
      httpPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(httpPort);
    });
  });
}

// ------------------------------------------------------------------
// 2. 查找并启动浏览器
// ------------------------------------------------------------------

/** 在常见安装位置中查找 Chrome / Edge / Chromium 可执行文件 */
function findBrowserBinary() {
  const candidates = [];

  if (process.env.CHROME_PATH) {
    candidates.push(process.env.CHROME_PATH);
  }

  if (process.platform === 'win32') {
    candidates.push(
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    );
  } else {
    candidates.push(
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
    );
  }

  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) return c;
    } catch {
      /* 忽略单个候选路径的检查错误 */
    }
  }
  return null;
}

/**
 * 启动无头浏览器，并从 stderr 中解析 DevTools 监听端口。
 * 返回 { proc, port }
 */
async function launchBrowser(binaryPath) {
  // 每次测试使用独立的临时用户数据目录，避免污染真实 profile
  userDataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dbw-e2e-'));

  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ];

  chromeProc = spawn(binaryPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const port = await waitForDevToolsPort(chromeProc, BROWSER_BOOT_TIMEOUT_MS);
  return { proc: chromeProc, port };
}

/** 从浏览器 stderr 中解析 "DevTools listening on ws://127.0.0.1:<port>/..." */
function waitForDevToolsPort(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const DEVTOOLS_RE = /DevTools listening on ws:\/\/[^:]+:(\d+)\//;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      proc.stderr.off('data', onStderr);
      proc.off('exit', onExit);
      proc.off('error', onError);
      fn(value);
    };

    const onStderr = (chunk) => {
      buffer += chunk.toString('utf8');
      const m = buffer.match(DEVTOOLS_RE);
      if (m) {
        finish(resolve, Number(m[1]));
        return;
      }
      // 防止缓冲区无限增长
      if (buffer.length > 128 * 1024) {
        buffer = buffer.slice(-16 * 1024);
      }
    };

    const onExit = (code, signal) => {
      finish(reject, new Error(`浏览器进程提前退出 (code=${code}, signal=${signal})`));
    };

    const onError = (err) => {
      finish(reject, new Error(`无法启动浏览器进程: ${err.message}`));
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(`等待 DevTools 端口超时（${timeoutMs}ms）`));
    }, timeoutMs);

    proc.stderr.on('data', onStderr);
    proc.once('exit', onExit);
    proc.once('error', onError);
  });
}

// ------------------------------------------------------------------
// 3. 极简 CDP 客户端（基于 ws）
// ------------------------------------------------------------------

/** 建立 CDP WebSocket 连接，返回带 send/on/close 的简易客户端 */
function connectCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false });
    let nextId = 0;
    const pending = new Map();
    const listeners = new Set();

    const onOpenError = (err) => reject(err);

    ws.once('error', onOpenError);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          rej(new Error(`${msg.method || 'CDP'} 错误: ${msg.error.message}`));
        } else {
          res(msg.result);
        }
        return;
      }

      if (msg.method) {
        for (const fn of listeners) {
          try {
            fn(msg);
          } catch {
            /* 忽略监听器异常 */
          }
        }
      }
    });

    ws.once('open', () => {
      ws.off('error', onOpenError);

      const client = {
        /** 发送 CDP 命令并等待结果 */
        send(method, params = {}) {
          return new Promise((res, rej) => {
            const id = ++nextId;
            pending.set(id, { resolve: res, reject: rej });
            try {
              ws.send(JSON.stringify({ id, method, params }));
            } catch (err) {
              pending.delete(id);
              rej(err);
            }
          });
        },
        /** 注册 CDP 事件监听 */
        on(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        /** 关闭连接 */
        close() {
          try {
            ws.close();
          } catch {
            /* 忽略 */
          }
        },
      };

      resolve(client);
    });
  });
}

/** 在页面中执行表达式并取回值（按值返回） */
async function evaluate(client, expression) {
  const res = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    const desc =
      res.exceptionDetails.exception?.description ||
      res.exceptionDetails.text ||
      '未知异常';
    throw new Error(`页面内求值异常: ${desc}`);
  }
  return res.result ? res.result.value : undefined;
}

// ------------------------------------------------------------------
// 4. 通过 CDP HTTP 接口打开页面 target
// ------------------------------------------------------------------

/** 等待 DevTools HTTP 端点就绪（/json/version） */
async function waitForDevToolsHttp(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch (err) {
      lastErr = err;
    }
    await sleep(150);
  }
  throw new Error(`DevTools HTTP 端点不可用: ${lastErr ? lastErr.message : '超时'}`);
}

/** 使用 PUT /json/new?<url> 新建页面 target */
async function openTarget(port, url) {
  const endpoint = `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`;
  const res = await fetch(endpoint, { method: 'PUT' });
  if (!res.ok) {
    throw new Error(`创建 target 失败: HTTP ${res.status}`);
  }
  const info = await res.json();
  if (!info || !info.webSocketDebuggerUrl) {
    throw new Error('创建 target 失败: 响应中缺少 webSocketDebuggerUrl');
  }
  return info;
}

/** 关闭页面 target（优先 CDP HTTP 接口） */
async function closeTarget(port, id) {
  if (!port || !id) return;
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${id}`);
  } catch {
    /* 忽略关闭失败 */
  }
}

// ------------------------------------------------------------------
// 5. 页面内断言表达式
// ------------------------------------------------------------------

/**
 * 在页面上下文中检查根节点与内部选择器，返回：
 * { readyState, rootExists, results: { [selector]: boolean }, foundCount, total }
 */
function buildProbeExpression() {
  return `(() => {
    const SELECTORS = ${JSON.stringify(SELECTORS)};
    const ROOT_SELECTOR = '#dsh-browser-widget-root';
    const root = document.getElementById('dsh-browser-widget-root');
    const results = {};
    let foundCount = 0;

    for (const sel of SELECTORS) {
      let ok = false;
      if (sel === ROOT_SELECTOR) {
        ok = !!root;
      } else {
        ok = !!(root && root.querySelector(sel));
      }
      results[sel] = ok;
      if (ok) foundCount += 1;
    }

    return {
      readyState: document.readyState,
      rootExists: !!root,
      results,
      foundCount,
      total: SELECTORS.length,
    };
  })()`;
}

/** 轮询页面直到 Widget 渲染完成或超时，返回最后一次探针快照 */
async function waitForWidget(client, timeoutMs) {
  const expr = buildProbeExpression();
  const deadline = Date.now() + timeoutMs;
  let snapshot = null;

  while (Date.now() < deadline) {
    snapshot = await evaluate(client, expr);
    if (snapshot && snapshot.rootExists && snapshot.foundCount === snapshot.total) {
      return snapshot;
    }
    await sleep(250);
  }
  return snapshot;
}

// ------------------------------------------------------------------
// 6. 清理
// ------------------------------------------------------------------

async function cleanup() {
  // 关闭页面 target
  if (devtoolsPort && targetId) {
    await closeTarget(devtoolsPort, targetId);
    targetId = null;
  }

  // 关闭 CDP WebSocket
  if (cdp) {
    try {
      cdp.close();
    } catch {
      /* 忽略 */
    }
    cdp = null;
  }

  // 结束浏览器进程
  if (chromeProc && chromeProc.exitCode === null && chromeProc.signalCode === null) {
    try {
      chromeProc.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
    await new Promise((resolve) => {
      const t = setTimeout(resolve, 3000);
      chromeProc.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }
  chromeProc = null;

  // 删除临时用户数据目录
  if (userDataDir) {
    try {
      await fsp.rm(userDataDir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
    userDataDir = null;
  }

  // 关闭 HTTP 服务器
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer = null;
  }
}

// ------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------

async function main() {
  // ---- 解析被测 widget 文件路径 ----
  const widgetArg = process.argv[2];
  const widgetPath = widgetArg
    ? path.resolve(process.cwd(), widgetArg)
    : path.join(SCRIPT_DIR, DEFAULT_WIDGET_REL);

  console.log(`[INFO] 被测 widget 文件: ${widgetPath}`);

  let widgetCode;
  try {
    widgetCode = await fsp.readFile(widgetPath, 'utf8');
  } catch (err) {
    check(`读取 widget 文件 (${widgetPath})`, false, err.message);
    return;
  }
  check(`读取 widget 文件 (${widgetPath})`, true, `${widgetCode.length} 字节`);

  // ---- 启动本地 HTTP 服务器 ----
  await startHttpServer(widgetCode);
  const pageUrl = `http://127.0.0.1:${httpPort}/`;
  check('启动本地 HTTP 服务器', httpPort > 0, `监听 ${pageUrl}`);

  // ---- 查找浏览器可执行文件 ----
  const binary = findBrowserBinary();
  if (!binary) {
    check('定位 Chrome/Edge/Chromium 可执行文件', false, '可通过环境变量 CHROME_PATH 指定');
    return;
  }
  check('定位 Chrome/Edge/Chromium 可执行文件', true, binary);

  // ---- 启动浏览器 ----
  const launched = await launchBrowser(binary);
  devtoolsPort = launched.port;
  check('启动无头浏览器并获取 DevTools 端口', Number.isInteger(devtoolsPort) && devtoolsPort > 0, `端口 ${devtoolsPort}`);

  // ---- 等待 DevTools HTTP 端点就绪 ----
  await waitForDevToolsHttp(devtoolsPort);
  check('DevTools HTTP 端点就绪', true, `http://127.0.0.1:${devtoolsPort}`);

  // ---- 打开页面 target ----
  const targetInfo = await openTarget(devtoolsPort, pageUrl);
  targetId = targetInfo.id;
  check('通过 PUT /json/new 打开页面 target', !!targetInfo.webSocketDebuggerUrl, targetInfo.id);

  // ---- 连接 target 的 WebSocket ----
  cdp = await connectCdp(targetInfo.webSocketDebuggerUrl);
  check('建立 CDP WebSocket 连接', true);

  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  check('启用 Runtime / Page 域', true);

  // ---- 等待页面加载完成 ----
  try {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5000);
      const off = cdp.on((msg) => {
        if (msg.method === 'Page.loadEventFired') {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    const state = await evaluate(cdp, 'document.readyState');
    check('页面加载完成', state === 'complete' || state === 'interactive', `readyState=${state}`);
  } catch (err) {
    check('页面加载完成', false, err.message);
  }

  // ---- 等待 Widget 渲染并采集快照 ----
  const snapshot = await waitForWidget(cdp, RENDER_TIMEOUT_MS);

  if (!snapshot) {
    check('Widget DOM 探针执行', false, '未取回任何快照');
    return;
  }

  // ---- 逐条断言 ----
  check(
    "document.getElementById('dsh-browser-widget-root') 存在",
    snapshot.rootExists === true,
  );

  for (const sel of SELECTORS) {
    if (sel === '#dsh-browser-widget-root') continue; // 根节点已单独断言
    check(`根节点内包含元素 ${sel}`, snapshot.results?.[sel] === true);
  }

  // ---- 输出统计 ----
  const foundCount = Number(snapshot.foundCount) || 0;
  const total = Number(snapshot.total) || SELECTORS.length;
  console.log(`[INFO] 找到的选择器数量: ${foundCount}/${total}`);
}

// ------------------------------------------------------------------
// 入口：保证清理一定会执行，并按结果设置退出码
// ------------------------------------------------------------------

const HARD_TIMEOUT_MS = 120000;
const hardTimer = setTimeout(() => {
  console.error('[FAIL] 全局超时，强制退出');
  cleanup().finally(() => process.exit(1));
}, HARD_TIMEOUT_MS);
hardTimer.unref?.();

try {
  await main();
} catch (err) {
  check('测试执行过程中未抛出异常', false, err?.stack || String(err));
} finally {
  clearTimeout(hardTimer);
  await cleanup();
}

console.log('');
console.log(`[SUMMARY] 通过 ${passed} 项，失败 ${failed} 项`);

if (failed === 0 && passed > 0) {
  console.log('[RESULT] 全部断言通过 ✅');
  process.exit(0);
} else {
  console.log('[RESULT] 存在失败断言 ❌');
  process.exit(1);
}