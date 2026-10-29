/* ============================================================================
 *  static-server.mjs —— 零依赖静态文件服务（两种部署共用）
 *
 *  根目录 = 仓库根（jadec/），因此一个 URL 空间里同时提供：
 *      /panel/...                 组件库（panel/scripts、panel/styles）
 *      /connection/...            本目录
 *      /connection/browser-only/  纯浏览器入口
 *      /connection/browser-server/ 服务器入口
 *
 *  这样 panel/ 与 connection/ 的相对路径都能直接 import，无需拷贝。
 * ========================================================================== */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '../..');
/* panel/ 是 jadec/ 的兄弟目录：一个 URL 空间内把它挂到 /panel/ */
export const PROJECT_ROOT = path.resolve(REPO_ROOT, '..');
export const PANEL_ROOT = path.join(PROJECT_ROOT, 'panel');

const MOUNTS = [
  { prefix: '/panel/', root: PANEL_ROOT },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function safeResolve(root, pathname) {
  let rel = pathname.replace(/^\/+/, '');
  if (!rel) rel = 'index.html';
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{root?:string, pathname?:string}} [options]
 * @returns {boolean} 是否已经处理
 */
export function serveStatic(req, res, options = {}) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const pathname = options.pathname
    || decodeURIComponent(new URL(req.url, 'http://localhost').pathname);

  let root = options.root || REPO_ROOT;
  let lookup = pathname;
  /* /panel/* 挂载到兄弟目录 panel/ */
  for (const mount of MOUNTS) {
    if (pathname.startsWith(mount.prefix)) {
      root = mount.root;
      lookup = '/' + pathname.slice(mount.prefix.length);
      break;
    }
  }

  let full = safeResolve(root, lookup);
  if (!full) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return true;
  }

  try {
    let stat = fs.statSync(full);
    if (stat.isDirectory()) {
      full = path.join(full, 'index.html');
      stat = fs.statSync(full);
    }
    if (!stat.isFile()) throw new Error('not a file');

    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    fs.createReadStream(full)
      .on('error', () => res.destroy())
      .pipe(res);
    return true;
  } catch (error) {
    const isNotFound = error && (error.code === 'ENOENT' || error.code === 'ENOTDIR');
    res.writeHead(isNotFound ? 404 : 500, {
      'Content-Type': 'text/plain; charset=utf-8',
    });
    res.end(isNotFound ? `404 Not Found: ${pathname}` : '500 Internal Server Error');
    return true;
  }
}

/** 最小 JSON 响应工具 */
export function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

/** 读取请求体（限制 1 MB） */
export function readJsonBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch (error) { reject(new Error('JSON 解析失败: ' + error.message)); }
    });
    req.on('error', reject);
  });
}
