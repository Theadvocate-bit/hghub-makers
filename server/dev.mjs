#!/usr/bin/env node
/**
 * 本地预览：模拟 EdgeOne Makers 的「静态资源优先 + catch-all 云函数」路由。
 *
 *   npm run preview      # http://localhost:8787
 *
 * - / 与 /hls.min.js 走 public/ 静态托管（Makers 静态资源优先）
 * - /api/* 与 /proxy/* 交给 cloud-functions/api/[[default]].js 的 onRequest
 *
 * 仅用 Node 内置模块，无第三方依赖。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest } from '../cloud-functions/api/[[default]].js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  return new Request(url, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });
}

async function send(res, response) {
  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  try {
    const { pathname } = new URL(req.url, 'http://localhost');

    // Makers：函数路由（/api/*、/proxy/*）。静态资源优先，但这些路径没有静态文件。
    if (pathname.startsWith('/api/') || pathname.startsWith('/proxy') || pathname === '/health') {
      return send(res, await onRequest({ request: await toRequest(req), params: {}, env: {} }));
    }

    // 静态资源
    let filePath = path.join(PUBLIC, decodeURIComponent(pathname));
    if (!filePath.startsWith(PUBLIC)) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || info.isDirectory()) filePath = path.join(PUBLIC, 'index.html');

    const data = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(data);
    if (pathname !== '/favicon.ico') {
      console.log(`  ${req.method} ${pathname} -> ${res.statusCode} (static, ${Date.now() - started}ms)`);
    }
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
});

server.listen(PORT, () => {
  console.log(`\n  HGhub Makers 本地预览 -> http://localhost:${PORT}\n`);
});
