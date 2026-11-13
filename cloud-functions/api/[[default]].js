/**
 * HGhub 复刻版 · EdgeOne Makers 云函数（catch-all）
 *
 * 路由：cloud-functions/api/[[default]].js  ->  /api/* 以及 /proxy/*
 * （Makers 静态资源优先；/ 与 /hls.min.js 走 public/ 静态托管，不进这里）
 *
 * 这是原项目 proxy/server.py(8080) + web/server.py(8081) 两个 stdlib Python
 * 服务合并成的单函数。原版靠「两个常驻进程 + openssl 命令行」工作，在
 * serverless 里都不可用，因此：
 *   - 两个服务合并成一个 catch-all（反正它们只做转发/解密，无状态）
 *   - 封面 AES 解密从 `openssl enc` 子进程换成 node:crypto（见 decryptCover）
 *
 * 它做四件事：
 *   1. POST /api/play    —— 服务端调上游 playback，拿 HLS 清单地址
 *   2. GET  /proxy/*     —— 服务端拉 m3u8 / key / ts 再带 CORS 转发，
 *                           浏览器只跟本站说话，不直连被挡的 CDN 域名
 *   3. GET  /proxy/img   —— 拉加密封面 -> AES-128-CBC 解密 -> 返回图片
 *   4. GET|POST /api/*   —— 同源反代到上游 huangguoai.com（含 /api/up/*、
 *                           /api/edge/*、/api/prefip）
 *
 * 全部响应带 CORS 头；转发类接口只放行白名单域名，防止被当任意代理滥用。
 */

import crypto from 'node:crypto';

const UPSTREAM = 'https://huangguoai.com';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

/* ---------------- 白名单 ---------------- */

// /proxy/*（m3u8/key/ts）允许中转的主机。清单在 yd-lphu-long.hzjvlo.cn，
// 密钥和 ts 在 tp*.drleao.cn，所以浏览器直连这些域即使 API 正常也播不了。
const PROXY_HOSTS = new Set([
  'huangguoai.com',
  'huangguoai.ai',
  'pic.drleao.cn',
  'yd-lphu-long.hzjvlo.cn',
  'tp1.drleao.cn',
  'tp4.drleao.cn',
  'tp8.drleao.cn',
]);
const PROXY_SUFFIXES = ['.hzjvlo.cn', '.drleao.cn'];

// /proxy/img 允许的图床主机
const IMG_HOSTS = new Set([
  'pic.drleao.cn',
  'new.drleao.cn',
  'image.drleao.cn',
  'new2.drleao.cn',
  'pic.aluxvl.cn',
  'huangguoai.com',
]);

/* ---------------- 封面解密 ---------------- */
// 上游图床 pic.drleao.cn 下发的封面是 AES 加密字节，不是图片；浏览器直接当
// <img src> 永远显示不出来。解密协议是上游公开的前端协议
// （crypto-image-protocol.js）：AES-128-CBC，无填充，key/iv 写死（本就是公开
// 给浏览器的，写死安全）。

const IMG_KEY = Buffer.from('f5d965df75336270', 'utf8'); // 16 字节
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'utf8'); // 16 字节

function decryptCover(bytes) {
  if (!bytes.length || bytes.length % 16 !== 0) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV);
    decipher.setAutoPadding(false);
    return Buffer.concat([decipher.update(bytes), decipher.final()]);
  } catch {
    return null;
  }
}

function sniffImage(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return 'image/png';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp';
  if (b.length >= 6) {
    const sig = b.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return 'application/octet-stream';
}

/* ---------------- 封面 LRU 缓存 ---------------- */
// 同一张封面只解密一次。serverless 实例会复用，缓存仍能命中热图。
const IMG_CACHE = new Map();
const IMG_CACHE_LIMIT = 200;

function cacheGet(key) {
  if (!IMG_CACHE.has(key)) return null;
  const v = IMG_CACHE.get(key);
  IMG_CACHE.delete(key);
  IMG_CACHE.set(key, v); // move to end (most recent)
  return v;
}

function cachePut(key, value) {
  if (IMG_CACHE.has(key)) IMG_CACHE.delete(key);
  IMG_CACHE.set(key, value);
  while (IMG_CACHE.size > IMG_CACHE_LIMIT) {
    IMG_CACHE.delete(IMG_CACHE.keys().next().value); // evict oldest
  }
}

/* ---------------- 优选 IP 缓存 ---------------- */
// cf.090227.xyz 是别人测好的 Cloudflare 优选 IP 列表（/ct 电信 /cu 联通
// /cmcc 移动）。浏览器跨域拉会被 CORS 挡，所以由函数代拉解析成 JSON。
const PREFIP_TTL = 600_000;
let prefipCache = { at: 0, data: null };

async function prefipList(isp) {
  try {
    const res = await fetch('https://cf.090227.xyz/' + isp, { headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) return [];
    const text = await res.text();
    return [...text.matchAll(/(\d+\.\d+\.\d+\.\d+)\s*#/g)].map((m) => m[1]);
  } catch {
    return [];
  }
}

async function prefipAll() {
  const now = Date.now();
  if (prefipCache.data && now - prefipCache.at < PREFIP_TTL) return prefipCache.data;
  const [ct, cu, cmcc] = await Promise.all([prefipList('ct'), prefipList('cu'), prefipList('cmcc')]);
  prefipCache = { at: now, data: { ct, cu, cmcc } };
  return prefipCache.data;
}

/* ---------------- 上游请求 ---------------- */

async function upstreamFetch(url, { method = 'GET', body = null, headers = {}, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': USER_AGENT, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ctype = res.headers.get('content-type') || 'text/plain';
    return { status: res.status, buf, ctype };
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 响应辅助 ---------------- */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, x-cdn-auth',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(obj, status = 200) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json; charset=UTF-8', ...CORS },
  });
}

function raw(status, body, contentType, extraHeaders = {}) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return new Response(buf, {
    status,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      ...CORS,
      ...extraHeaders,
    },
  });
}

function hostAllowed(host, hosts, suffixes) {
  host = (host || '').toLowerCase();
  return hosts.has(host) || suffixes.some((s) => host.endsWith(s));
}

/* ---------------- 主处理 ---------------- */

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // ---- 健康检查 ----
  if (path === '/health') return json({ status: 'ok' });

  // ---- 播放解析：服务端调上游 playback ----
  // 注意：上游要求 body 是空 JSON 对象，带上 id/ep 反而会被拒（"播放参数无效"）。
  if (path === '/api/play' && method === 'POST') {
    let payload = {};
    try {
      payload = await request.json();
    } catch {
      payload = {};
    }
    const videoId = parseInt(payload.id, 10);
    const ep = parseInt(payload.ep ?? 1, 10) || 1;
    if (!Number.isFinite(videoId)) return json({ status: 0, msg: 'invalid id' }, 400);

    const target = `${UPSTREAM}/api/videos/${videoId}/episodes/${ep}/playback`;
    const { status, buf } = await upstreamFetch(target, { method: 'POST', body: '{}' });
    if (status !== 200) return json({ status: 0, msg: `upstream HTTP ${status}` }, status);
    // 原样返回上游响应（含 data 包装），前端两种形状都兼容。
    return raw(200, buf, 'application/json; charset=UTF-8');
  }

  // ---- HLS / 封面 中转 ----
  const isProxyPath =
    path === '/proxy' || path === '/proxy/m3u8' || path === '/proxy/key' || path === '/proxy/ts';
  if (isProxyPath && method === 'GET') {
    const target = url.searchParams.get('url') || '';
    return relayMedia(target);
  }
  if (path === '/proxy/img' && method === 'GET') {
    return proxyImage(url.searchParams.get('url') || '');
  }

  // ---- 优选 IP ----
  if (path === '/api/prefip' && method === 'GET') {
    const isp = url.searchParams.get('isp') || 'auto';
    const lists = await prefipAll();
    const data =
      isp in lists
        ? { isp, ips: lists[isp] }
        : { isp: 'auto', ips: lists.ct, ct: lists.ct, cu: lists.cu, cmcc: lists.cmcc };
    return json({ status: 1, data });
  }

  // ---- 同源反代到上游 huangguoai.com ----
  // 覆盖：/api/up/*、/api/edge/*，以及直接的 /api/videos、/api/search、
  // /api/ranks、/api/posts、/api/site/*、/api/videos/:id、/api/videos/:id/comments。
  // 查询串原样透传（分页 ?page= / cate_id= / q= 都不截断）。
  if (path === '/api' || path.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'POST') return json({ status: 0, msg: 'method not allowed' }, 405);
    let target;
    if (path.startsWith('/api/up/')) {
      target = `${UPSTREAM}/api/${path.slice('/api/up/'.length)}`;
    } else if (path.startsWith('/api/edge/')) {
      target = UPSTREAM + path;
    } else {
      target = UPSTREAM + path;
    }
    if (url.search) target += url.search;

    let body;
    if (method === 'POST') body = await request.text();
    const { status, buf, ctype } = await upstreamFetch(target, {
      method,
      body: body && body.length ? body : null,
    });
    return raw(status, buf, ctype || 'application/octet-stream');
  }

  return json({ status: 0, msg: 'not found' }, 404);
}

/* ---- m3u8 / key / ts 中转：按扩展名 + content-type 修 Content-Type ---- */
async function relayMedia(target) {
  if (!/^https?:\/\//.test(target)) return json({ status: 0, msg: 'url must be http(s)' }, 400);
  const host = safeHost(target);
  if (!hostAllowed(host, PROXY_HOSTS, PROXY_SUFFIXES))
    return json({ status: 0, msg: `host not allowed: ${host}` }, 403);

  const { status, buf, ctype } = await upstreamFetch(target, { timeoutMs: 30000 });

  // 清单地址后面带 ?auth_key=... 签名，判断后缀前要先去掉查询串。
  const urlPath = safePath(target).toLowerCase();
  let out = ctype || 'application/octet-stream';
  if (urlPath.endsWith('.m3u8') || /mpegurl/.test(ctype) || /x-mpegurl/.test(ctype))
    out = 'application/vnd.apple.mpegurl';
  else if (urlPath.endsWith('.ts')) out = 'video/MP2T';
  else if (urlPath.endsWith('.key') || target.includes('crypt.key')) out = 'application/octet-stream';

  return raw(status, buf, out);
}

/* ---- 封面：拉取 -> AES 解密 -> 返回图片（带 LRU 缓存） ---- */
async function proxyImage(target) {
  if (!/^https?:\/\//.test(target)) return json({ status: 0, msg: 'url must be http(s)' }, 400);
  const host = safeHost(target);
  if (!IMG_HOSTS.has(host)) return json({ status: 0, msg: `image host not allowed: ${host}` }, 403);

  const cacheKey = crypto.createHash('sha256').update(target).digest('hex');
  const hit = cacheGet(cacheKey);
  if (hit) return raw(200, hit.buf, hit.ctype);

  const { status, buf } = await upstreamFetch(target, { timeoutMs: 20000 });
  if (status !== 200) return json({ status: 0, msg: `upstream HTTP ${status}` }, status);

  // 绝大多数封面是 AES 密文：解密出合法图片就返回图片；已是明文（或解密失败）
  // 就原样返回，浏览器自己判断（部分旧图可能是明文）。
  const plain = decryptCover(buf);
  if (plain) {
    const kind = sniffImage(plain);
    if (kind !== 'application/octet-stream') {
      cachePut(cacheKey, { buf: plain, ctype: kind });
      return raw(200, plain, kind);
    }
  }
  let ctype = sniffImage(buf);
  if (ctype === 'application/octet-stream') ctype = 'image/jpeg';
  cachePut(cacheKey, { buf, ctype });
  return raw(200, buf, ctype);
}

/* ---- 小工具 ---- */
function safeHost(u) {
  try {
    return new URL(u).hostname;
  } catch {
    return '';
  }
}
function safePath(u) {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
}
