/* ============================================================================
 *  server.mjs —— browser-server 部署：Node.js 后台（物理 + HTTP/SSE 数据接口）
 *
 *  架构：
 *      浏览器（panel 仪表 / 输入）
 *          │  GET  /api/stream   ← SSE 20 Hz 推送 InstrumentSuite 帧
 *          │  POST /api/command  → 控制命令（旋钮/按钮/故障注入）
 *          ▼
 *      Node.js：JadeChamber + FlightControl + InstrumentSuite（唯一真相源）
 *
 *  同时提供静态文件：仓库根作为 Web 根，因此 /panel/* 与 /connection/* 都可访问。
 *
 *  启动：node connection/browser-server/server.mjs
 *        PORT=8091 node connection/browser-server/server.mjs
 * ========================================================================== */
'use strict';

import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SimCore } from '../shared/sim-core.mjs';
import {
  REPO_ROOT, serveStatic, sendJson, readJsonBody,
} from '../shared/static-server.mjs';

/* ---- 直接加载 physics/（CommonJS），不复制物理代码 ---- */
const require = createRequire(import.meta.url);
const { JadeChamber } = require('../../physics/jade-chamber.js');
const {
  FlightControl, CRAB_LIMITS, psiToBearing,
} = require('../../physics/flight-control.js');
const { InstrumentSuite } = require('../../physics/instruments.js');

const physics = { JadeChamber, FlightControl, InstrumentSuite, CRAB_LIMITS, psiToBearing };

const PORT = Number(process.env.PORT) || 8091;
const HOST = process.env.HOST || '0.0.0.0';
const TICK_MS = 50;

/* ---- 仿真会话（服务器是唯一真相源） ---- */
const sim = new SimCore(physics, {
  terrainPreset: process.env.TERRAIN || 'flat',
});

/* ========================================================================== *
 *  SSE 客户端
 * ========================================================================== */
const clients = new Set();

function sseSend(res, event, data) {
  try {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch (error) {
    return false;
  }
}

function openStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  res.write('retry: 1000\n\n');

  clients.add(res);
  sseSend(res, 'hello', {
    mode: 'browser-server',
    transport: 'sse',
    protocol: 1,
    tickHz: Math.round(1000 / TICK_MS),
    endpoint: '/api/stream',
    serverTime: Date.now(),
    terrainPreset: sim.frame ? sim.frame.meta.terrainPreset : 'flat',
  });
  if (sim.frame) sseSend(res, 'frame', sim.frame);

  req.on('close', () => {
    clients.delete(res);
  });
  res.on('error', () => {
    clients.delete(res);
  });
}

function broadcast(frame) {
  const payload = `event: frame\ndata: ${JSON.stringify(frame)}\n\n`;
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    /* 慢客户端丢弃旧帧，绝不无限堆积 */
    if (client.writableLength > 2_000_000) continue;
    try { client.write(payload); }
    catch (error) { clients.delete(client); }
  }
}

/* ========================================================================== *
 *  仿真主循环
 * ========================================================================== */
let lastTick = performance.now();
setInterval(() => {
  const now = performance.now();
  const dt = Math.min(0.25, Math.max(0, (now - lastTick) / 1000));
  lastTick = now;
  try {
    const frame = sim.step(dt || TICK_MS / 1000);
    broadcast(frame);
  } catch (error) {
    console.error('[sim] step failed:', error);
  }
}, TICK_MS);

/* SSE 心跳：防止代理/浏览器把长时间无数据的连接判死 */
setInterval(() => {
  for (const client of clients) {
    if (client.writableEnded || client.destroyed) {
      clients.delete(client);
      continue;
    }
    try { client.write(': keep-alive\n\n'); }
    catch (error) { clients.delete(client); }
  }
}, 15_000);

/* ========================================================================== *
 *  HTTP 路由
 * ========================================================================== */
async function handleApi(req, res, pathname) {
  /* CORS 预检（同源部署时用不到，但便于独立前端联调） */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    res.end();
    return;
  }

  if (req.method === 'GET' && pathname === '/api/hello') {
    sendJson(res, 200, {
      mode: 'browser-server',
      transport: 'sse+http',
      protocol: 1,
      tickHz: Math.round(1000 / TICK_MS),
      physics: 'node',
      terrainPreset: sim.frame ? sim.frame.meta.terrainPreset : 'flat',
      clients: clients.size,
      serverTime: Date.now(),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/frame') {
    sendJson(res, 200, sim.frame || { type: 'error', message: 'not ready' });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/stream') {
    openStream(req, res);
    return;
  }

  if (req.method === 'POST' && (pathname === '/api/command' || pathname === '/api/commands')) {
    try {
      const body = await readJsonBody(req);
      const commands = Array.isArray(body) ? body
        : Array.isArray(body.commands) ? body.commands
        : [body];
      const results = sim.applyCommands(commands);
      const failed = results.filter(r => !r.ok);
      sendJson(res, failed.length ? 207 : 200, {
        ok: failed.length === 0,
        seq: sim.frame ? sim.frame.seq : 0,
        results,
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error.message || error) });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: 'unknown api: ' + pathname });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (error) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname).catch(error => {
      sendJson(res, 500, { ok: false, error: String(error.message || error) });
    });
    return;
  }

  /* 默认首页 */
  if (pathname === '/' || pathname === '') {
    res.writeHead(302, {
      Location: '/connection/browser-server/index.html',
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  if (!serveStatic(req, res, { root: REPO_ROOT, pathname })) {
    res.writeHead(405); res.end('Method Not Allowed');
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('══════════ Jade Chamber · browser-server ══════════');
  console.log(`  UI      http://${shown}:${PORT}/connection/browser-server/`);
  console.log(`  Physics node ${process.version} · ${path.relative(REPO_ROOT, process.cwd()) || '.'}`);
  console.log(`  SSE     /api/stream    (${Math.round(1000 / TICK_MS)} Hz)`);
  console.log(`  Command /api/command   (POST JSON)`);
  console.log(`  Terrain ${sim.frame ? sim.frame.meta.terrainPreset : 'flat'}`);
  console.log('════════════════════════════════════════════════════');
});

function shutdown() {
  console.log('\n[server] shutting down…');
  for (const client of clients) {
    try { client.end(); } catch (error) { /* ignore */ }
  }
  clients.clear();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
