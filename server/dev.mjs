#!/usr/bin/env node
/**
 * 本地预览：模拟 EdgeOne Makers 的「静态资源优先 + catch-all 云函数」路由。
 *
 *   npm run preview      # http://localhost:8787  （PORT=xxxx 可改端口）
 *
 * 路由规则和线上保持一致：
 *   - /api、/api/*、/proxy、/proxy/*、/health  ->  cloud-functions/api/[[default]].js
 *   - 其余路径按静态文件处理，**静态根就是仓库根目录**（Makers 不认 public/，
 *     线上的 /app.js 取的是仓库根的 app.js），找不到时无扩展名的路径回 index.html
 *
 * 只用 Node 内置模块，无第三方依赖。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest } from '../cloud-functions/_lib/handler.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_ROOT = ROOT;
const PORT = Number(process.env.PORT) || 8787;

/** 只在开发期使用、不该被当成静态资源对外暴露的目录/文件 */
const HIDDEN_DIRS = new Set(['.git', '.github', '.edgeone', 'node_modules', 'cloud-functions', 'server', 'scripts']);
const HIDDEN_FILES = new Set(['package-lock.json', '.gitignore', '.env']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const FUNCTION_PREFIXES = ['/api', '/api/', '/proxy', '/proxy/', '/health'];

function isFunctionPath(pathname) {
  return FUNCTION_PREFIXES.some((p) => (p.endsWith('/') ? pathname.startsWith(p) : pathname === p || pathname.startsWith(p + '/')));
}

function isHidden(rel) {
  const segs = rel.split('/').filter(Boolean);
  if (!segs.length) return false;
  if (HIDDEN_DIRS.has(segs[0])) return true;
  if (HIDDEN_FILES.has(segs[segs.length - 1])) return true;
  return segs.some((s) => s.startsWith('.'));
}

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const init = { method: req.method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(req.method) && body) init.body = body;
  return new Request(url, init);
}

async function sendFunction(req, res, started) {
  const response = await onRequest({ request: await toRequest(req), params: {}, env: {} });
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(req.method === 'HEAD' ? undefined : buf);
  console.log(`  ${req.method} ${new URL(req.url, 'http://localhost').pathname} -> ${res.statusCode} (fn, ${Date.now() - started}ms)`);
}

async function sendStatic(req, res, pathname, started) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.statusCode = 400;
    return res.end('Bad Request');
  }

  if (isHidden(rel)) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404 Not Found: ' + rel);
  }

  let filePath = path.join(STATIC_ROOT, rel);
  // 目录穿越防护：拼出来的路径必须仍在静态根里
  if (path.relative(STATIC_ROOT, filePath).startsWith('..')) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }

  let info = await stat(filePath).catch(() => null);
  if (info && info.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }

  // 找不到静态文件：无扩展名的路径（就是访问首页）回 index.html，其余 404
  if (!info) {
    if (path.extname(rel)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('404 Not Found: ' + rel);
    }
    filePath = path.join(STATIC_ROOT, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('index.html 不存在（静态根 = 仓库根目录）');
    }
  }

  const data = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  res.setHeader('Content-Length', String(data.length));
  res.setHeader('Cache-Control', 'no-store'); // 本地开发不缓存，改完刷新就生效
  res.end(req.method === 'HEAD' ? undefined : data);

  if (pathname !== '/favicon.ico') {
    console.log(`  ${req.method} ${pathname} -> 200 (static, ${Date.now() - started}ms)`);
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const { pathname } = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS' && isFunctionPath(pathname)) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Range, x-cdn-auth',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    });
    return res.end();
  }

  try {
    if (isFunctionPath(pathname)) await sendFunction(req, res, started);
    else await sendStatic(req, res, pathname, started);
  } catch (err) {
    console.error('[dev]', req.method, pathname, err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status: 0, msg: 'dev server error', detail: String((err && err.message) || err) }));
    } else {
      res.end();
    }
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`\n  端口 ${PORT} 已被占用，换一个：PORT=8788 npm run preview\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, () => {
  console.log(`\n  HGhub Makers 本地预览 -> http://localhost:${PORT}\n`);
});
