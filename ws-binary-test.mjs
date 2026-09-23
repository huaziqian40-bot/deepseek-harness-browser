/**
 * ws-binary-test.mjs
 * dsh-tool-browser 插件 WebSocket 二进制协议「回环测试」脚本
 *
 * 用法：node ws-binary-test.mjs
 * 依赖：仅 Node 内置模块 + ws
 *
 * 协议约定（服务端 -> 客户端）：
 *   1) 二进制帧：[0x01][width uint32BE][height uint32BE] + JPEG 负载
 *   2) JSON：{type:'status', running:true, mode:'view'}
 *   3) JSON：{type:'echo', kind:'mouse', op:'mousePressed', x:100, y:200, button:'left'}
 *   4) JSON：{type:'cursor', x:120, y:240}
 */

import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

// 一个 1x1 的合法 JPEG（base64 内嵌），用于构造二进制帧负载
const JPEG_1X1_BASE64 =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const JPEG_PAYLOAD = Buffer.from(JPEG_1X1_BASE64, 'base64');

// 二进制帧头长度：1 字节 magic + 4 字节宽 + 4 字节高
const HEADER_LEN = 9;
const MAGIC = 0x01;

// 期望的宽高（1x1）
const EXPECT_WIDTH = 1;
const EXPECT_HEIGHT = 1;

// 等待消息的整体超时（毫秒）
const TIMEOUT_MS = 3000;

// ---------------------------------------------------------------------------
// 断言工具
// ---------------------------------------------------------------------------

let failCount = 0;

/**
 * 打印一条断言结果；失败时累加失败计数。
 * @param {boolean} ok 断言是否成立
 * @param {string} desc 描述
 */
function check(ok, desc) {
  if (ok) {
    console.log(`[PASS] ${desc}`);
  } else {
    failCount++;
    console.log(`[FAIL] ${desc}`);
  }
}

/**
 * 构造二进制帧：9 字节头 + JPEG 负载
 * @param {number} width
 * @param {number} height
 * @returns {Buffer}
 */
function buildBinaryFrame(width, height) {
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt8(MAGIC, 0); // magic byte
  header.writeUInt32BE(width, 1); // 宽（大端）
  header.writeUInt32BE(height, 5); // 高（大端）
  return Buffer.concat([header, JPEG_PAYLOAD]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  // ---- 1. 启动本地 WebSocket 服务端（临时端口） ----
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const { port } = server.address();
  console.log(`[INFO] 本地 WebSocket 服务已启动: ws://127.0.0.1:${port}`);

  // 服务端收到 hello 后按协议顺序推送 1 个二进制帧 + 3 条 JSON
  server.on('connection', (ws) => {
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return; // 本测试中客户端只发文本 JSON
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return; // 非法 JSON 直接忽略
      }
      if (!msg || msg.type !== 'hello') return;

      // 二进制帧
      ws.send(buildBinaryFrame(EXPECT_WIDTH, EXPECT_HEIGHT));
      // 三条 JSON 消息
      ws.send(JSON.stringify({ type: 'status', running: true, mode: 'view' }));
      ws.send(
        JSON.stringify({
          type: 'echo',
          kind: 'mouse',
          op: 'mousePressed',
          x: 100,
          y: 200,
          button: 'left',
        }),
      );
      ws.send(JSON.stringify({ type: 'cursor', x: 120, y: 240 }));
    });
  });

  // ---- 2. 建立客户端连接并发送 hello ----
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  const received = []; // { data: Buffer, isBinary: boolean }

  client.on('message', (data, isBinary) => {
    received.push({
      data: Buffer.isBuffer(data) ? data : Buffer.from(data),
      isBinary,
    });
  });
  client.on('error', (err) => {
    console.log(`[FAIL] 客户端连接错误: ${err.message}`);
    failCount++;
  });

  await once(client, 'open');
  client.send(JSON.stringify({ type: 'hello' }));

  // ---- 3. 等待 4 条消息（1 二进制 + 3 JSON），带超时 ----
  const deadline = Date.now() + TIMEOUT_MS;
  while (received.length < 4 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }

  // ---- 4. 断言：二进制帧 ----
  const binaryMsg = received.find((m) => m.isBinary);
  check(Boolean(binaryMsg), '收到 1 个二进制帧');

  if (binaryMsg) {
    const buf = binaryMsg.data;
    check(buf.length >= HEADER_LEN, `二进制帧长度 >= ${HEADER_LEN}（实际 ${buf.length}）`);

    // magic byte
    check(buf.length >= 1 && buf.readUInt8(0) === MAGIC, 'magic byte 为 0x01');

    if (buf.length >= HEADER_LEN) {
      const width = buf.readUInt32BE(1);
      const height = buf.readUInt32BE(5);
      check(width === EXPECT_WIDTH, `宽度解码正确（期望 ${EXPECT_WIDTH}，实际 ${width}）`);
      check(height === EXPECT_HEIGHT, `高度解码正确（期望 ${EXPECT_HEIGHT}，实际 ${height}）`);

      // JPEG 负载
      const payload = buf.subarray(HEADER_LEN);
      check(payload.length > 0, `JPEG 负载非空（长度 ${payload.length}）`);
      check(
        payload.length >= 2 && payload[0] === 0xff && payload[1] === 0xd8,
        'JPEG 负载以 FF D8 开头（SOI）',
      );
      check(
        payload.length >= 2 &&
          payload[payload.length - 2] === 0xff &&
          payload[payload.length - 1] === 0xd9,
        'JPEG 负载以 FF D9 结尾（EOI）',
      );
      check(payload.equals(JPEG_PAYLOAD), 'JPEG 负载与预期字节完全一致');
    }
  }

  // ---- 5. 断言：三条 JSON 消息 ----
  const textMsgs = [];
  for (const m of received) {
    if (m.isBinary) continue;
    try {
      textMsgs.push(JSON.parse(m.data.toString('utf8')));
    } catch {
      // 解析失败的 JSON 不加入列表，后面断言会体现
    }
  }

  check(textMsgs.length === 3, `收到 3 条合法 JSON 消息（实际 ${textMsgs.length}）`);

  // status
  const statusMsg = textMsgs.find((m) => m && m.type === 'status');
  check(Boolean(statusMsg), '存在 type=status 的 JSON 消息');
  if (statusMsg) {
    check(statusMsg.running === true, 'status.running === true');
    check(statusMsg.mode === 'view', "status.mode === 'view'");
  }

  // echo
  const echoMsg = textMsgs.find((m) => m && m.type === 'echo');
  check(Boolean(echoMsg), '存在 type=echo 的 JSON 消息');
  if (echoMsg) {
    check(echoMsg.kind === 'mouse', "echo.kind === 'mouse'");
    check(echoMsg.op === 'mousePressed', "echo.op === 'mousePressed'");
    check(echoMsg.x === 100, 'echo.x === 100');
    check(echoMsg.y === 200, 'echo.y === 200');
    check(echoMsg.button === 'left', "echo.button === 'left'");
  }

  // cursor
  const cursorMsg = textMsgs.find((m) => m && m.type === 'cursor');
  check(Boolean(cursorMsg), '存在 type=cursor 的 JSON 消息');
  if (cursorMsg) {
    check(cursorMsg.x === 120, 'cursor.x === 120');
    check(cursorMsg.y === 240, 'cursor.y === 240');
  }

  // ---- 6. 清理资源 ----
  try {
    client.close();
  } catch {
    /* 忽略关闭异常 */
  }
  await new Promise((resolve) => server.close(resolve));

  // ---- 7. 汇总退出码 ----
  if (failCount === 0) {
    console.log('[DONE] 全部断言通过 ✅');
    process.exit(0);
  } else {
    console.log(`[DONE] 存在 ${failCount} 条断言失败 ❌`);
    process.exit(1);
  }
}

// 顶层异常统一处理，保证退出码为 1
main().catch((err) => {
  console.log(`[FAIL] 测试执行异常: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});