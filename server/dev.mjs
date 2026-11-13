#!/usr/bin/env node
/**
 * 本地预览：模拟 EdgeOne Makers 的「静态资源优先 + catch-all 云函数」路由。
 *
 *   npm run preview      # http://localhost:8787  （PORT=xxxx 可改端口）
 *
 * 路由规则和线上保持一致：
 *   - /api、/api/*、/proxy、/proxy/*、/health  ->  cloud-functions/api/[[default]].js
 *   - 其余路径先找仓库根目录里的静态文件，找不到再回 index.html（仅限无扩展名的路径）
 *
 * 只用 Node 内置模块，无第三方依赖。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest } from '../cloud-functions/api/[[default]].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 静态资源就在仓库根目录（和 Makers 线上一致，outputDirectory 钉成 "."）。
const PUBLIC = ROOT;
// 本地预览时不该被当静态文件暴露出去的东西（工程文件/源码/配置）。
const HIDDEN = new Set([
  'cloud-functions', 'server', 'scripts', 'node_modules', '.git',
  'package.json', 'package-lock.json', 'edgeone.json', 'README.md', '.gitignore',
]);
const PORT = Number(process.env.PORT) || 8787;

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

  let filePath = path.join(PUBLIC, rel);
  // 目录穿越防护：拼出来的路径必须仍在站点根里
  if (path.relative(PUBLIC, filePath).startsWith('..')) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  // 屏蔽工程文件/源码/配置（本地预览不暴露，和线上静态根语义一致）
  const cleanRel = path.normalize(rel).replace(/^[/\\]+/, ''); // 去掉前导斜杠，否则 split 后首段为空
  const firstSeg = cleanRel.split(path.sep)[0];
  if (HIDDEN.has(firstSeg) || firstSeg.startsWith('.')) {
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('404 Not Found: ' + rel);
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
    filePath = path.join(PUBLIC, 'index.html');
    info = await stat(filePath).catch(() => null);
    if (!info) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end('index.html 不存在');
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
