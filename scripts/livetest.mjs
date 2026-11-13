#!/usr/bin/env node
/**
 * 联网联调：真实访问上游 huangguoai.com 与 CDN，验证「代理线路」整条链路可用。
 *
 *   npm run test:live
 *
 * 会消耗上游流量（约 2~3MB），需要联网。
 */
import { onRequest } from '../cloud-functions/api/[[default]].js';

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label || '值'} 不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function ok(v, label) { if (!v) throw new Error(label || '断言失败'); }

const call = (path, init) => onRequest({ request: new Request(new URL(path, 'http://localhost'), init || {}), params: {}, env: {} });
const callJson = async (path, init) => {
  const res = await call(path, init);
  const text = await res.text();
  try { return { res, body: JSON.parse(text) }; }
  catch { throw new Error(`非 JSON 响应（HTTP ${res.status}）：${text.slice(0, 120)}`); }
};

console.log('\n  HGhub Makers 联调（需要联网）\n');

let videoId = 12;
let m3u8 = '';

await test('GET /api/videos 分页列表', async () => {
  const { res, body } = await callJson('/api/videos?page=1');
  eq(res.status, 200);
  const items = body.data.items;
  ok(items.length > 0, 'items 为空');
  ok(body.data.pagination.pages > 1, '应有多页');
  videoId = items[0].id || videoId;
});

await test('GET /api/site/categories/video 分类', async () => {
  const { res, body } = await callJson('/api/site/categories/video');
  eq(res.status, 200);
  ok(body.data.items.length > 0);
  ok(body.data.items[0].id, '分类应带 id');
});

await test('POST /api/play 拿到 HLS 清单地址', async () => {
  const { res, body } = await callJson('/api/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: videoId, ep: 1 }),
  });
  eq(res.status, 200);
  m3u8 = body.data.streams.main;
  ok(m3u8 && m3u8.indexOf('http') === 0, 'streams.main 为空');
});

await test('GET /proxy/m3u8 清单被完整改写成同源地址', async () => {
  const res = await call('/proxy/m3u8?url=' + encodeURIComponent(m3u8));
  eq(res.status, 200);
  eq(res.headers.get('content-type'), 'application/vnd.apple.mpegurl');

  const text = await res.text();
  ok(text.startsWith('#EXTM3U'), '不是 m3u8');

  const uris = [];
  text.split('\n').forEach((line) => {
    const t = line.trim();
    if (!t) return;
    if (t.startsWith('#')) {
      const m = t.match(/URI="([^"]+)"/);
      if (m) uris.push(m[1]);
    } else {
      uris.push(t);
    }
  });

  ok(uris.length > 0, '清单里没有任何 URI');
  const leaked = uris.filter((u) => !u.startsWith('/proxy/'));
  eq(leaked.length, 0, `${leaked.length} 个 URI 没走代理：${leaked[0] || ''}`);
  ok(+res.headers.get('x-manifest-rewritten') > 0, '改写计数器应 > 0');

  globalThis.__manifest = text;
});

await test('代理后的密钥可取（16 字节）', async () => {
  const keyUri = (globalThis.__manifest || '').match(/URI="(\/proxy\/key\?url=[^"]+)"/);
  ok(keyUri, '清单里没有 key');
  const res = await call(keyUri[1].replace(/&amp;/g, '&'));
  eq(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  eq(buf.length, 16, 'AES-128 密钥长度');
});

await test('代理后的分片支持 Range（206）', async () => {
  const seg = (globalThis.__manifest || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/proxy/ts?url='))[0];
  ok(seg, '清单里没有分片');
  const res = await call(seg, { headers: { Range: 'bytes=0-1023' } });
  eq(res.status, 206);
  eq(res.headers.get('content-type'), 'video/MP2T');
  ok(/^bytes 0-1023\//.test(res.headers.get('content-range') || ''), 'Content-Range 头不对');
  eq(Buffer.from(await res.arrayBuffer()).length, 1024);
});

await test('GET /api/videos/:id 详情带 episodes', async () => {
  const { res, body } = await callJson('/api/videos/' + videoId);
  eq(res.status, 200);
  ok(Array.isArray(body.data.episodes) && body.data.episodes.length > 0, 'episodes 为空');
  ok(body.data.episodes[0].ep_num >= 1, 'ep_num 缺失');
});

await test('榜单字段是 video_id（前端 openDetail 依赖）', async () => {
  const { res, body } = await callJson('/api/ranks/hot');
  eq(res.status, 200);
  const first = body.data.items[0];
  ok(first.video_id, '榜单条目没有 video_id');
});

await test('GET /proxy/img 解出真 JPEG，且第二次命中缓存', async () => {
  const { body } = await callJson('/api/videos?page=1');
  const cover = body.data.items[0].cover;
  ok(cover, '封面地址为空');

  const first = await call('/proxy/img?url=' + encodeURIComponent(cover));
  eq(first.status, 200);
  const buf = Buffer.from(await first.arrayBuffer());
  ok(buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff, '解密结果不是 JPEG');

  const second = await call('/proxy/img?url=' + encodeURIComponent(cover));
  eq(second.headers.get('x-cache'), 'HIT');
  eq(second.headers.get('cache-control'), 'public, max-age=604800, immutable');
});

await test('GET /api/prefip 优选 IP', async () => {
  const { res, body } = await callJson('/api/prefip?isp=ct');
  eq(res.status, 200);
  ok(Array.isArray(body.data.ips), 'ips 不是数组');
  ok(body.data.ips.length > 0, '没有解析出 IP（上游格式可能变了）');
});

await test('上游超时不返回 HTML 500', async () => {
  // 不存在的域名路径走白名单拒绝，确认兜底错误也是 JSON
  const res = await call('/api/videos/999999999');
  ok(res.headers.get('content-type').includes('application/json'), '应为 JSON');
});

const total = passed + failures.length;
console.log(`\n  ${passed}/${total} 通过${failures.length ? '，有失败用例' : ''}\n`);
process.exit(failures.length ? 1 : 0);
