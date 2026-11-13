/**
 * HGhub · EdgeOne Makers catch-all 云函数
 *
 * 路由前缀：cloud-functions/api/[[default]].js  ->  /api/*、/proxy/*、/health
 * （Makers 静态资源优先，/、/styles.css、/app.js、/hls.min.js 由静态托管处理；
 *   静态根 = 仓库根目录，不是 public/，所以这些文件就放在仓库根）
 *
 * 它做四件事：
 *   1. POST /api/play     服务端调上游 playback，返回 HLS 清单地址
 *   2. GET  /proxy/*      服务端拉 m3u8 / key / ts 再带 CORS 转发，并把清单里的
 *                         URI 重写成同源代理地址（见 rewriteManifest）
 *   3. GET  /proxy/img    拉加密封面 -> AES-128-CBC 解密 -> 返回真图片
 *   4. GET|POST /api/*    同源反代到上游 huangguoai.com
 *
 * 结构（自上而下）：常量 -> 缓存 -> 上游请求 -> 响应工具 -> 清单重写
 *                 -> 各路由处理 -> 路由表 -> onRequest
 *
 * 注意：EdgeOne Makers 只部署本目录，故本文件保持自包含、无第三方依赖。
 */

import crypto from 'node:crypto';

/* ============================ 常量 ============================ */

const VERSION = '1.3.1';
const STARTED_AT = Date.now();
const UPSTREAM = 'https://huangguoai.com';
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Mobile Safari/537.36';

/** 各类上游请求的超时（毫秒）。serverless 单次执行有上限，必须自带超时。 */
const TIMEOUT = { api: 15000, play: 20000, media: 20000, image: 15000, prefip: 8000 };

/**
 * 媒体中转白名单。
 * 清单在 yd-lphu-long.hzjvlo.cn，密钥/分片散落在 tp1/tp2/tp4/tp8.drleao.cn
 * 等多台机器上，所以按后缀放行而不是逐个列主机（写死会被新机器打穿）。
 */
const MEDIA_HOSTS = new Set(['huangguoai.com', 'huangguoai.ai']);
const MEDIA_SUFFIXES = ['.hzjvlo.cn', '.drleao.cn'];

/** 图片中转白名单（图床）。 */
const IMG_HOSTS = new Set(['huangguoai.com', 'pic.drleao.cn', 'new.drleao.cn', 'new2.drleao.cn', 'image.drleao.cn', 'pic.aluxvl.cn']);
const IMG_SUFFIXES = ['.drleao.cn', '.aluxvl.cn'];

/** 本机/内网地址一律拒绝，避免白名单以外的 SSRF 变体。 */
const PRIVATE_HOST =
  /^(localhost|127\.|0\.0\.0\.0|10\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i;

/* ============================ 缓存 ============================ */

/** 封面 LRU：同实例内命中，省一次上游拉取 + AES 解密。 */
const IMG_CACHE_MAX_ITEMS = 300;
const IMG_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const IMG_CACHE_MAX_ENTRY = 1024 * 1024; // 单张超过 1MB 不入缓存
const imgCache = new Map();
let imgCacheBytes = 0;

function cacheGet(key) {
  const hit = imgCache.get(key);
  if (!hit) return null;
  imgCache.delete(key);
  imgCache.set(key, hit); // 移到队尾 = 最近使用
  return hit;
}

function cachePut(key, entry) {
  if (entry.buf.length > IMG_CACHE_MAX_ENTRY) return;
  const old = imgCache.get(key);
  if (old) {
    imgCache.delete(key);
    imgCacheBytes -= old.buf.length;
  }
  imgCache.set(key, entry);
  imgCacheBytes += entry.buf.length;
  while (imgCache.size > IMG_CACHE_MAX_ITEMS || imgCacheBytes > IMG_CACHE_MAX_BYTES) {
    const [k, v] = imgCache.entries().next().value;
    imgCache.delete(k);
    imgCacheBytes -= v.buf.length;
  }
}

/** 优选 IP：只在成功时缓存，失败不占坑（旧版会把空结果缓存 10 分钟）。 */
const PREFIP_TTL = 600_000;
const prefipCache = { at: 0, data: null };

/* ============================ 上游请求 ============================ */

/**
 * 统一的上游 fetch：超时、UA、二进制读取。
 * 不转发 content-encoding / content-length —— fetch 已自动解压，原值会串味。
 */
async function fetchUpstream(url, { method = 'GET', body = null, headers = {}, timeoutMs = TIMEOUT.api } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const upper = method.toUpperCase();
    const res = await fetch(url, {
      method: upper,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        ...headers,
      },
      body: upper === 'GET' || upper === 'HEAD' ? undefined : body,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, buf, headers: res.headers };
  } finally {
    clearTimeout(timer);
  }
}

/* ============================ 响应工具 ============================ */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Range, x-cdn-auth',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
};

function json(obj, status = 200, extra = {}) {
  const body = JSON.stringify(obj);
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'Content-Length': String(Buffer.byteLength(body)),
      'Cache-Control': 'no-store',
      ...CORS,
      ...extra,
    },
  });
}

/**
 * 原样返回二进制。head=true 时只回响应头（HEAD 请求不能带 body，
 * 但 Content-Length 仍然要写全量长度，否则 hls.js 会误判）。
 */
function raw(status, body, contentType, extra = {}, head = false) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body), 'utf8');
  return new Response(head ? null : buf, {
    status,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buf.length),
      ...CORS,
      ...extra,
    },
  });
}

function notFound(path) {
  return json({ status: 0, msg: 'not found', path }, 404);
}

function badRequest(msg) {
  return json({ status: 0, msg }, 400);
}

/* ============================ 主机校验 ============================ */

function safeUrl(target) {
  try {
    const u = new URL(target);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u;
  } catch {
    return null;
  }
}

function hostAllowed(u, hosts, suffixes) {
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host)) return false;
  if (hosts.has(host)) return true;
  return suffixes.some((s) => host.endsWith(s) && host.length > s.length);
}

/* ============================ 封面解密 ============================ */

/**
 * 上游图床下发的封面不是图片，而是 AES-128-CBC 密文（无填充），key/iv 写死在上游
 * 前端协议里（本来就是发给浏览器的公开值）。原项目用 `openssl enc` 子进程，
 * serverless 起不了子进程，这里换 node:crypto。
 */
const IMG_KEY = Buffer.from('f5d965df75336270', 'utf8');
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'utf8');

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
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 6) {
    const sig = b.toString('latin1', 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  return null;
}

/* ============================ 清单重写 ============================ */

/**
 * 关键修复：/proxy/m3u8 以前只做「原样转发」，清单里的 #EXT-X-KEY:URI 和分片地址
 * 仍然是 tp2.drleao.cn 这类被墙的 CDN 绝对地址，浏览器拿到清单后照样直连 CDN，
 * 于是「代理线路」实际上完全不生效（只有清单本身走代理）。
 *
 * 这里把清单内所有 URI（key / 分片 / 嵌套清单 / EXT-X-MAP / EXT-X-MEDIA）改写成
 * 同源地址 /proxy/{m3u8|key|ts}?url=<原始绝对地址>，让整条链路都留在函数里。
 */
function absolutize(uri, base) {
  try {
    return new URL(uri, base).toString();
  } catch {
    return null;
  }
}

function proxyUri(abs) {
  let path = '';
  try {
    path = new URL(abs).pathname.toLowerCase();
  } catch {
    return abs;
  }
  if (path.endsWith('.m3u8')) return '/proxy/m3u8?url=' + encodeURIComponent(abs);
  if (path.endsWith('.key')) return '/proxy/key?url=' + encodeURIComponent(abs);
  return '/proxy/ts?url=' + encodeURIComponent(abs);
}

function rewriteManifest(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let changed = 0;

  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      out.push(line);
      continue;
    }

    if (t.startsWith('#')) {
      // 标签内的 URI="..."（KEY / MAP / MEDIA / I-FRAME-STREAM-INF）
      if (t.indexOf('URI="') === -1) {
        out.push(line);
        continue;
      }
      out.push(
        line.replace(/URI="([^"]*)"/g, (whole, uri) => {
          if (/^(data|skd|blob):/i.test(uri)) return whole;
          const abs = absolutize(uri, baseUrl);
          if (!abs) return whole;
          changed++;
          return 'URI="' + proxyUri(abs) + '"';
        }),
      );
      continue;
    }

    // 普通行 = 分片或子清单地址
    const abs = absolutize(t, baseUrl);
    if (!abs) {
      out.push(line);
      continue;
    }
    changed++;
    out.push(proxyUri(abs));
  }

  return { text: out.join('\n'), changed };
}

function looksLikeManifest(buf, contentType, urlPath) {
  if (/mpegurl/i.test(contentType || '')) return true;
  if (/\.m3u8$/i.test(urlPath || '')) return true;
  return buf.length > 7 && buf.toString('latin1', 0, 7) === '#EXTM3U';
}

/* ============================ 路由处理 ============================ */

/** 播放解析：上游要求 body 为空 JSON 对象，带 id/ep 反而被判「参数无效」。 */
async function handlePlay(request, url, method) {
  let payload = {};
  if (method === 'POST') {
    try {
      const text = await request.text();
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = {};
    }
  } else {
    payload = { id: url.searchParams.get('id'), ep: url.searchParams.get('ep') };
  }

  const videoId = Number.parseInt(payload.id, 10);
  if (!Number.isFinite(videoId) || videoId <= 0) return badRequest('invalid id');
  const ep = Number.parseInt(payload.ep ?? 1, 10) || 1;
  if (ep <= 0) return badRequest('invalid ep');

  const target = `${UPSTREAM}/api/videos/${videoId}/episodes/${ep}/playback`;
  const upstream = await fetchUpstream(target, {
    method: 'POST',
    body: '{}',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    timeoutMs: TIMEOUT.play,
  });

  if (upstream.status !== 200) {
    return json({ status: 0, msg: `upstream HTTP ${upstream.status}`, id: videoId, ep }, upstream.status);
  }
  return raw(200, upstream.buf, 'application/json; charset=UTF-8', { 'Cache-Control': 'no-store' });
}

/** HLS 清单 / 密钥 / 分片中转。 */
async function handleMedia(request, url, method) {
  if (method !== 'GET' && method !== 'HEAD') return json({ status: 0, msg: 'method not allowed' }, 405);
  const head = method === 'HEAD';

  const target = url.searchParams.get('url') || '';
  const u = safeUrl(target);
  if (!u) return badRequest('url must be http(s)');
  if (!hostAllowed(u, MEDIA_HOSTS, MEDIA_SUFFIXES)) {
    return json({ status: 0, msg: `host not allowed: ${u.hostname}` }, 403);
  }

  // 透传 Range：分片偶尔要局部读取，透传后不必整段下载。
  const range = request.headers.get('range');
  const upstream = await fetchUpstream(target, {
    method,
    headers: range ? { Range: range } : {},
    timeoutMs: TIMEOUT.media,
  });

  const contentType = upstream.headers.get('content-type') || '';
  const path = u.pathname.toLowerCase();

  // ---- 清单：重写 URI ----
  // 只在 200 全量响应上重写；分段（206）不可能出现在清单请求里，一旦出现直接原样回。
  if (upstream.status === 200 && looksLikeManifest(upstream.buf, contentType, path)) {
    const text = upstream.buf.toString('utf8');
    const rewritten = text.indexOf('#EXTM3U') === 0 ? rewriteManifest(text, target) : { text, changed: 0 };
    return raw(
      upstream.status,
      rewritten.text,
      'application/vnd.apple.mpegurl',
      {
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Manifest-Rewritten': String(rewritten.changed),
      },
      head,
    );
  }

  // ---- 密钥 / 分片 ----
  let out = contentType || 'application/octet-stream';
  const extra = { 'Accept-Ranges': 'bytes' };

  if (path.endsWith('.key') || /crypt\.key/.test(path)) {
    out = 'application/octet-stream';
    extra['Cache-Control'] = 'public, max-age=3600';
  } else if (path.endsWith('.ts') || /mp2t|octet-stream|video\//.test(out)) {
    if (!/mp2t|video\//.test(out)) out = 'video/MP2T';
    extra['Cache-Control'] = 'public, max-age=86400';
  } else {
    extra['Cache-Control'] = 'public, max-age=3600';
  }

  const contentRange = upstream.headers.get('content-range');
  if (contentRange) extra['Content-Range'] = contentRange;

  return raw(upstream.status, upstream.buf, out, extra, head);
}

/** 封面：拉取 -> AES 解密 -> 校验文件头 -> 缓存 -> 返回。 */
async function handleImage(request, url) {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return json({ status: 0, msg: 'method not allowed' }, 405);
  const head = method === 'HEAD';

  const target = url.searchParams.get('url') || '';
  const u = safeUrl(target);
  if (!u) return badRequest('url must be http(s)');
  if (!hostAllowed(u, IMG_HOSTS, IMG_SUFFIXES)) {
    return json({ status: 0, msg: `image host not allowed: ${u.hostname}` }, 403);
  }

  const cacheKey = crypto.createHash('sha1').update(target).digest('hex');
  const hit = cacheGet(cacheKey);
  if (hit) {
    return raw(200, hit.buf, hit.ctype, {
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Cache': 'HIT',
    }, head);
  }

  const upstream = await fetchUpstream(target, { timeoutMs: TIMEOUT.image });
  if (upstream.status !== 200) {
    return json({ status: 0, msg: `upstream HTTP ${upstream.status}` }, upstream.status === 404 ? 404 : 502);
  }

  // 绝大多数封面是密文：解出合法图片头才认；已是明文（旧图）也放行。
  const plain = decryptCover(upstream.buf);
  const decoded = plain && sniffImage(plain);
  if (decoded) {
    cachePut(cacheKey, { buf: plain, ctype: decoded });
    return raw(200, plain, decoded, {
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Cache': 'MISS',
    }, head);
  }

  const direct = sniffImage(upstream.buf);
  if (direct) {
    cachePut(cacheKey, { buf: upstream.buf, ctype: direct });
    return raw(200, upstream.buf, direct, {
      'Cache-Control': 'public, max-age=604800, immutable',
      'X-Cache': 'MISS',
    }, head);
  }

  // 既解不出来也不是图片：明确报错，让前端走 onerror 兜底，
  // 不要像旧版那样塞一坨密文当 image/jpeg 返回。
  return json({ status: 0, msg: 'not an image' }, 415);
}

/** 优选 IP：由函数代拉 cf.090227.xyz 并解析成 JSON（浏览器直接拉会被 CORS 挡）。 */
async function prefipList(isp) {
  try {
    const res = await fetch(`https://cf.090227.xyz/${isp}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT.prefip),
    });
    if (!res.ok) return [];
    const text = await res.text();
    const ips = [...text.matchAll(/(\d{1,3}(?:\.\d{1,3}){3})\s*#/g)].map((m) => m[1]);
    return [...new Set(ips)];
  } catch {
    return [];
  }
}

async function prefipAll() {
  const now = Date.now();
  if (prefipCache.data && now - prefipCache.at < PREFIP_TTL) return prefipCache.data;

  const [ct, cu, cmcc] = await Promise.all([prefipList('ct'), prefipList('cu'), prefipList('cmcc')]);
  const data = { ct, cu, cmcc };
  // 全空说明上游挂了：不缓存，下次请求继续重试。
  if (ct.length || cu.length || cmcc.length) {
    prefipCache.at = now;
    prefipCache.data = data;
  }
  return data;
}

/** 同源反代到上游：/api/up/*、/api/edge/*、/api/videos、/api/search … 查询串原样透传。 */
async function handleApi(request, url, method) {
  if (!['GET', 'HEAD', 'POST'].includes(method)) {
    return json({ status: 0, msg: 'method not allowed' }, 405);
  }

  const path = url.pathname;
  let target;
  if (path.startsWith('/api/up/')) target = `${UPSTREAM}/api/${path.slice('/api/up/'.length)}`;
  else target = UPSTREAM + path;
  if (url.search) target += url.search;

  const headers = { Accept: 'application/json, text/plain, */*' };
  let body = null;
  if (method === 'POST') {
    body = await request.text();
    headers['Content-Type'] = request.headers.get('content-type') || 'application/json';
    if (!body) body = null;
  }

  const upstream = await fetchUpstream(target, {
    method,
    body,
    headers,
    timeoutMs: TIMEOUT.api,
  });

  return raw(
    upstream.status,
    upstream.buf,
    upstream.headers.get('content-type') || 'application/json; charset=UTF-8',
    { 'Cache-Control': 'no-store' },
    method === 'HEAD',
  );
}

function handleHealth() {
  return json({
    status: 'ok',
    version: VERSION,
    uptime: Math.round((Date.now() - STARTED_AT) / 1000),
    imageCache: { items: imgCache.size, bytes: imgCacheBytes },
    prefipCachedAt: prefipCache.at || null,
  });
}

/* ============================ 路由表 ============================ */

async function route(request, url) {
  const path = url.pathname;
  const method = request.method.toUpperCase();

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } });
  }

  if (path === '/health') return handleHealth();

  if (path === '/api/play') {
    if (method !== 'POST' && method !== 'GET') return json({ status: 0, msg: 'method not allowed' }, 405);
    return handlePlay(request, url, method);
  }

  if (path === '/proxy/img') return handleImage(request, url);

  if (path === '/proxy' || path === '/proxy/m3u8' || path === '/proxy/key' || path === '/proxy/ts' || path === '/proxy/seg') {
    return handleMedia(request, url, method);
  }

  if (path === '/api/prefip') {
    const isp = (url.searchParams.get('isp') || 'auto').toLowerCase();
    const lists = await prefipAll();
    const data =
      isp === 'ct' || isp === 'cu' || isp === 'cmcc'
        ? { isp, ips: lists[isp] }
        : { isp: 'auto', ips: lists.ct.length ? lists.ct : lists.cu.length ? lists.cu : lists.cmcc, ct: lists.ct, cu: lists.cu, cmcc: lists.cmcc };
    return json({ status: 1, data, updatedAt: prefipCache.at || null });
  }

  if (path === '/api' || path.startsWith('/api/')) return handleApi(request, url, method);

  return null;
}

/* ============================ 入口 ============================ */

export async function onRequest(context) {
  const request = context && context.request;
  if (!request) return badRequest('missing request');

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return badRequest('bad url');
  }

  try {
    const res = await route(request, url);
    return res || notFound(url.pathname);
  } catch (err) {
    // 关键：任何未捕获异常都要以 JSON + CORS 返回，否则上游超时会让前端拿到
    // 一坨 HTML 500，`r.json()` 直接抛 "Unexpected token"，用户只看到「加载失败」。
    const timeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
    console.error('[hghub]', request.method, url.pathname, timeout ? 'timeout' : err && err.message);
    return json(
      { status: 0, msg: timeout ? 'upstream timeout' : 'proxy error', detail: String((err && err.message) || err) },
      timeout ? 504 : 502,
    );
  }
}

/* 供自测脚本直接调用的内部工具（不影响 Makers 运行时） */
export const __test__ = { rewriteManifest, proxyUri, hostAllowed, sniffImage, decryptCover, safeUrl };
