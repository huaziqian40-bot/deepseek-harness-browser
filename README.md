# dsh-tool-browser 2.1.0 — 共享浏览器插件 · 多标签版 (Shared Browser Multi-Tab)

让任何 DeepSeek Harness (`dsh web`) 实例获得一个 **云端共享浏览器**：
真实有头的 Chromium（Xvfb 虚拟显示），支持实时画面（二进制 JPEG 帧 + 硬件解码）、
live 光标、点击/按键/拖拽即时回显、发布页 `/publish`，以及插件一键分发（本 ZIP）。

> 配套发布页：`GET {你的地址}/publish`；插件下载：`GET {你的地址}/plugin/download`；
> 本文档：`GET {你的地址}/plugin/readme`；清单：`GET {你的地址}/plugin/manifest`。

---

## ✨ 特性

| 能力 | 说明 |
|---|---|
| 🧠 有头模式 | Chromium 真实有头运行（`DISPLAY` 指向 Xvfb），非 `--headless=new`，可过 reCAPTCHA / Cloudflare 人机验证 |
| ⚡ 实时画面 | WebSocket 二进制 JPEG 帧（非 base64），前端 `createImageBitmap` 硬件解码，约 15fps |
| 🖱️ 即时反馈 | live 光标广播（≈25Hz）、鼠标按下/松开波纹、按键高亮 —— 输入立刻可见 |
| 🤝 人机协同 | 页面右下角 🌐 面板与 Agent 共享同一浏览器实例，可同时操作 |
| 🧭 历史导航 | 前进 / 后退 / 历史记录下拉（`Page.getNavigationHistory`），跨标签独立 |
| 👁 双模式 | 默认「仅观看模式」（只留标签/截屏/紧急关闭/画面，防抢操作），一键切「用户操作模式」；操作模式下 Agent 写工具自动拒绝 |
| 📐 可拉伸 | 面板右下/右/下三处把手拖拽拉伸，页面视口随窗口同步缩放并记忆尺寸 |
| 🎯 拖拽 | 滑块/画布/JS 拖动走合并式鼠标事件（无积压、跟手）；HTML5 `draggable` 自动走 `Input.dispatchDragEvent` 原生式拖放 |
| 📦 一键分发 | `/plugin/download` 返回本插件 ZIP，任何 dsh 实例解压即装 |
| 🛡️ 授权访问 | WS / 状态 / MJPEG 走 harness token+HMAC cookie 鉴权；发布页与 widget.js 匿名可读（无密钥），匿名者无法控制浏览器 |

## 📋 环境要求

- DeepSeek Harness：`dsh web`（测试于 0.1.x / Node ≥ 20；需 ws、schemastery、sharp 等 harness 自带依赖）
- Chromium / Chrome 可执行文件（通过 `CHROME_PATH` 或插件默认探测路径指定）
- **可选但推荐**：Xvfb + 中文字体（有头模式；无 DISPLAY 时自动回退 headless）
- 磁盘：浏览器 profile 约 300MB

## 🚀 安装（一条命令 ⭐）

**从 GitHub Releases 安装**（推荐，永久地址，不依赖某个在线实例）：

```bash
curl -sL https://raw.githubusercontent.com/<你的用户名>/dsh-tool-browser/main/client/install.sh \
  | bash -s https://github.com/<你的用户名>/dsh-tool-browser/releases/latest/download
```

打 `v*` 标签时 GitHub Actions 自动打包 `dsh-tool-browser.zip` 并发布（资产名固定为
`dsh-tool-browser.zip`，install.sh 的 `latest/download` 永远指向最新版）。

**从已部署的 harness 实例安装**（`BASE` 换成该实例地址）：

```bash
curl -sL https://<BASE>/plugin/install.sh | bash -s https://<BASE>
```

脚本自动：定位 `~/.dsh/profiles/web` → 下载解压插件 → 在 `cordis.patch.yml`
追加 `browser-share` 插入补丁 → 存在 systemd 服务时重启 `dsh-web`。
也可手动（3 步）：

1. **放入插件目录**（二选一）：
   ```bash
   # 解压到 profile 的 plugins 目录（dsh web 启动时自动加载）
   unzip dsh-tool-browser-2.1.0.zip -d ~/.dsh/profiles/web/plugins/
   # 目录结构：
   #   ~/.dsh/profiles/web/plugins/dsh-tool-browser/{manifest.json, README.md,
   #     lib/{index.js,cdp.mjs}, client/{widget.js,publish.html,install.sh}}
   ```
2. **可选：有头模式**（强烈推荐，否则回退 headless）：
   ```bash
   # Debian/Ubuntu
   apt-get install -y xvfb x11-utils fonts-noto-cjk fonts-liberation
   # 启动虚拟显示 :99
   Xvfb :99 -screen 0 1600x1000x24 -ac +extension GLX +render -noreset &
   ```
   并在 `dsh web` 服务环境里加上 `DISPLAY=:99`（systemd 则在
   `dsh-web.service` 的 `Environment=` 加一行 `DISPLAY=:99`）。
3. **配置 + 重启**：在 web profile 的补丁文件（如 `cordis.patch.yml`）中可选调整：
   ```yaml
   plugins:
     browser-share:
       viewportWidth: 1280
       viewportHeight: 800
       frameQuality: 58        # JPEG 质量 10-95
       frameIntervalMs: 66     # 广播间隔(ms)，越小越流畅
       frameMaxDimension: 1280 # 帧最大边长
   ```
   然后重启 `dsh web`，用启动日志里的 URL + token 打开 `/publish` 即见发布页与共享浏览器面板。

## 🧪 验证

- 打开 `{地址}/publish` → 右下角 🌐 → ▶ 启动 → 画面出现、点击/拖动/键盘即时回显
- `curl {地址}/plugin/download -o dsh-tool-browser-2.1.0.zip && unzip -l dsh-tool-browser-2.1.0.zip`
- 仓库内自带回归测试（VM 环境）：
  - `ws-binary-test.mjs` 环回协议（二进制帧/尺寸/echo/cursor）
  - `ws-tunnel-test.mjs` 隧道往返
  - `widget-e2e-test.mjs` 真实浏览器加载页面 E2E
  - `publish-e2e-test.mjs` 发布页匿名+授权 E2E
  - `drag-experiment.mjs` / `drag-variant-test.mjs` 拖拽验证

## 🔁 无限重试（429 / 5xx 等模型 API 错误）

Harness 自带模型 API 重试（默认 5 次）。本仓库附带 `scripts/apply-retry-policy.sh`，
一条命令让所有 provider **对任何错误无限重试**：

```bash
bash <(curl -sL https://raw.githubusercontent.com/<你的用户名>/dsh-tool-browser/main/scripts/apply-retry-policy.sh)
```

备份 + 幂等 + 自动定位 `llm-pi-ai.providers`；详见 `docs/RETRY-POLICY.md`。

## 仓库结构

```
dsh-tool-browser/
├── manifest.json / package.json / README.md / LICENSE
├── lib/          # 服务端（浏览器控制 + 工具接入）
├── client/       # 前端 widget / 发布页 / 一键安装脚本
├── scripts/      # apply-retry-policy.sh（无限重试）
├── docs/         # RETRY-POLICY.md 等
└── .github/workflows/release.yml   # 打 v* 标签自动发 Release
```

## 🔒 安全说明

- 控制通道（WS `/api/browser/ws`、状态、MJPEG）均受 harness 的 Host/Origin fence +
  token 兑换 cookie + HMAC 签名保护；未授权访问返回 401/403。
- `/publish`、`/plugin/*`、`/api/browser/widget.js` 为匿名静态资源（仅客户端代码，
  不含任何密钥），匿名者可浏览发布页、下载插件，但**无法**控制共享浏览器。
- token 随 `dsh web` 进程轮换；隧道域名随 cloudflared 轮换，重启后请以启动日志为准。

## 🗂️ 目录结构

```
dsh-tool-browser/
├── manifest.json          # 插件清单（name/version/entry/config）
├── README.md              # 本文档
├── lib/
│   ├── index.js           # 服务端：路由、WS 广播、输入(含拖拽)、分发端点
│   └── cdp.mjs            # CDP 封装：启动 Chrome、screencast、JPEG 尺寸解析
└── client/
    ├── widget.js          # 注入式面板：MJPEG/WS 渲染、光标、回显
    └── publish.html       # 发布/分发落地页
```

## 📝 版本

- 2.1.0 — 6 项改进：① 🌐 悬浮球可自由拖动并记忆位置；② 前进/后退/历史记录（CDP Page.getNavigationHistory）；③ 核实 cookie/localStorage 跨启动持久化（默认保留；profile 目录改用 `os.homedir()`，关闭时优先 CDP `Browser.close` 优雅退出以免丢失未落盘写入）；④ 默认「仅观看模式」+ 一键切换「用户操作模式」（仅观看模式保留标签页/截屏/紧急关闭/画面，**无遮罩无模糊、画面始终清晰**，模式状态只在导航栏按钮显示，用户输入前端+服务端双重拦截；操作模式时 Agent 写工具 `browser_click/type/key/navigate` 拒绝执行，防抢操作）；⑤ 按钮布局仿 Edge（标签条 → 导航栏「← → ⟳ 🏠 + 圆角地址栏 + 模式切换 + 🕘 历史 + 📷 + ⏹」→ 画面）；⑥ 面板可拉伸（右下/右/下三处把手，视口随窗口 debounce 同步缩放）。
- 2.0.1 — 修复：AI 打字去重（keyDown 不再双写）、面板可拖出屏幕并记忆位置、CDP 拖动鼠标事件补 button 字段、一键安装脚本兼容默认 "[]" 补丁（自动重写/备份/幂等）。
- 2.0.0 — 多标签版：多标签页（新开/切换/关闭，画面随活动标签走）+ 修复 agent 控制浏览器（tool 输出 lossless JSON）+ 有头共享浏览器 + 实时画面 + 拖拽 + 发布/分发页。
- 1.0.0 — 首个可分发版本：有头共享浏览器 + 实时画面 + 拖拽 + 发布/分发页。
