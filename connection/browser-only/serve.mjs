/* ============================================================================
 *  serve.mjs —— browser-only 的静态文件服务器（零依赖）
 *
 *  为什么需要它：ES Module Worker + fetch(panel JSON) 不能从 file:// 运行。
 *  静态根 = 仓库根，因此可以直接 import panel/ 与 connection/。
 *
 *  启动：node connection/browser-only/serve.mjs
 *        PORT=8090 node connection/browser-only/serve.mjs
 * ========================================================================== */
'use strict';

import http from 'node:http';
import { REPO_ROOT, serveStatic } from '../shared/static-server.mjs';

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || '0.0.0.0';

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (error) {
    res.writeHead(400); res.end('Bad Request'); return;
  }

  if (pathname === '/' || pathname === '') {
    res.writeHead(302, { Location: '/connection/browser-only/index.html' });
    res.end();
    return;
  }

  if (!serveStatic(req, res, { root: REPO_ROOT, pathname })) {
    res.writeHead(405); res.end('Method Not Allowed');
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('══════════ Jade Chamber · browser-only ══════════');
  console.log(`  UI      http://${shown}:${PORT}/connection/browser-only/`);
  console.log('  Physics Web Worker（浏览器内，无服务器计算）');
  console.log(`  Root    ${REPO_ROOT}`);
  console.log('═════════════════════════════════════════════════');
});
