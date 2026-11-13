#!/usr/bin/env node
/**
 * 自测：直接调用云函数的 onRequest，不需要起服务器。
 *
 *   node scripts/selftest.mjs
 *
 * 覆盖：播放解析、上游反代、封面 AES 解密、HLS 中转、优选 IP、
 *       白名单拦截、OPTIONS 预检。会真实访问上游与 CDN，需要联网。
 */
import { onRequest } from '../cloud-functions/api/[[default]].js';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? '  ' + detail : ''}`);
}

function req(path, { method = 'GET', body = null } = {}) {
  const url = new URL(path, 'http://localhost');
  return new Request(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: method === 'GET' ? undefined : body,
  });
}

async function call(path, opts) {
  const res = await onRequest({ request: req(path, opts), params: {}, env: {} });
  return res;
}

console.log('\n  HGhub Makers 自测\n');

// 1. OPTIONS 预检
{
  const res = await call('/api/play', { method: 'OPTIONS' });
  check('OPTIONS 预检返回 204', res.status === 204);
}

// 2. 播放解析
let m3u8 = '';
{
  const res = await call('/api/play', { method: 'POST', body: JSON.stringify({ id: 12, ep: 1 }) });
  const data = await res.json();
  const d = data.data ?? data;
  m3u8 = d.streams?.main || '';
  check('POST /api/play 拿到 HLS 清单', res.status === 200 && !!m3u8, m3u8 ? '' : 'streams.main 为空');
}

// 3. 上游反代（列表分页）
{
  const res = await call('/api/videos?page=1');
  const data = await res.json();
  const items = data.data?.items || data.items || [];
  check('GET /api/videos 反代上游', res.status === 200 && items.length > 0, `${items.length} 条`);
}

// 4. 封面 AES 解密
{
  const list = await (await call('/api/videos?page=1')).json();
  const cover = (list.data?.items || list.items || [])[0]?.cover;
  const res = await call('/proxy/img?url=' + encodeURIComponent(cover));
  const buf = Buffer.from(await res.arrayBuffer());
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  check('GET /proxy/img 解出真 JPEG', res.status === 200 && isJpeg, `type=${res.headers.get('Content-Type')}`);
}

// 5. HLS 清单中转
if (m3u8) {
  const res = await call('/proxy/m3u8?url=' + encodeURIComponent(m3u8));
  const text = await res.text();
  check(
    'GET /proxy/m3u8 中转清单',
    res.status === 200 && text.includes('#EXTM3U'),
    res.headers.get('Content-Type'),
  );
}

// 6. 优选 IP
{
  const res = await call('/api/prefip?isp=ct');
  const data = await res.json();
  const n = (data.data?.ips || []).length;
  check('GET /api/prefip 优选 IP', res.status === 200, `${n} 个`);
}

// 7. 白名单拦截
{
  const res = await call('/proxy/m3u8?url=' + encodeURIComponent('https://evil.com/a.m3u8'));
  check('非白名单主机被拒(403)', res.status === 403);
}

// 8. 缺参数
{
  const res = await call('/api/play', { method: 'POST', body: JSON.stringify({}) });
  check('POST /api/play 缺 id 返回 400', res.status === 400);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n  ${results.length - failed}/${results.length} 通过\n`);
process.exit(failed ? 1 : 0);
