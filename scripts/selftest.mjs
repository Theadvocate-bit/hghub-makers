#!/usr/bin/env node
/**
 * 离线自测：不访问网络，直接测云函数的纯逻辑 + 路由契约。
 *
 *   npm test
 *
 * 联网联调另有 `npm run test:live`（真实走上游/CDN）。
 */
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequest, __test__ } from '../cloud-functions/_lib/handler.js';
import * as entryApi from '../cloud-functions/api/[[default]].js';
import * as entryProxy from '../cloud-functions/proxy/[[default]].js';
import * as entryHealth from '../cloud-functions/health.js';

const FUNCTIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cloud-functions');
const ROOT = path.resolve(FUNCTIONS_DIR, '..');

const { rewriteManifest, hostAllowed, sniffImage, decryptCover, safeUrl } = __test__;

/* ---------------- 迷你断言框架 ---------------- */

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label || '值'} 不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  if (!value) throw new Error(label || '断言失败');
}

function req(path, init) {
  return new Request(new URL(path, 'http://localhost'), init || {});
}

function call(path, init) {
  return onRequest({ request: req(path, init), params: {}, env: {} });
}

/* ---------------- 清单重写 ---------------- */

console.log('\n  HGhub Makers 离线自测\n');

test('清单：绝对地址的 key / 分片改写成同源代理', () => {
  const src = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://tp2.drleao.cn/a/crypt.key?auth_key=1",IV=0x1234',
    '#EXTINF:5.0,',
    'https://tp6.drleao.cn/a/seg0.ts?auth_key=2',
    'https://tp6.drleao.cn/a/seg1.ts',
  ].join('\n');

  const out = rewriteManifest(src, 'https://yd.hzjvlo.cn/v/a.m3u8?auth_key=0');

  eq(out.changed, 3, '改写条数');
  ok(out.text.includes('URI="/proxy/key?url=https%3A%2F%2Ftp2.drleao.cn'), 'key 应改写成 /proxy/key');
  ok(out.text.includes('/proxy/ts?url=https%3A%2F%2Ftp6.drleao.cn%2Fa%2Fseg0.ts%3Fauth_key%3D2'), 'ts 应带原始查询串');
  ok(!out.text.includes('https://tp6.drleao.cn/a/seg0.ts'), '原始 CDN 地址不应留在清单里');
  ok(out.text.startsWith('#EXTM3U'), '头部标签保留');
});

test('清单：相对路径按清单地址解析', () => {
  const src = ['#EXTM3U', '#EXTINF:4,', 'seg0.ts', 'sub/index.m3u8'].join('\n');
  const out = rewriteManifest(src, 'https://yd.hzjvlo.cn/videos/abc/a.m3u8');
  ok(out.text.includes('/proxy/ts?url=https%3A%2F%2Fyd.hzjvlo.cn%2Fvideos%2Fabc%2Fseg0.ts'), '相对 ts 解析错误');
  ok(out.text.includes('/proxy/m3u8?url=https%3A%2F%2Fyd.hzjvlo.cn%2Fvideos%2Fabc%2Fsub%2Findex.m3u8'), '嵌套清单应走 /proxy/m3u8');
});

test('清单：EXT-X-MAP 的 URI 也改写', () => {
  const src = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n';
  const out = rewriteManifest(src, 'https://a.drleao.cn/x/a.m3u8');
  ok(out.text.includes('/proxy/ts?url='), 'EXT-X-MAP 未改写');
  eq(out.changed, 1);
});

test('清单：data: / 无法解析的 URI 保持原样', () => {
  const src = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="data:text/plain;base64,AAAA"\n';
  const out = rewriteManifest(src, 'https://a.drleao.cn/x/a.m3u8');
  ok(out.text.includes('URI="data:text/plain;base64,AAAA"'), 'data URI 不应被改写');
  eq(out.changed, 0);
});

/* ---------------- 主机白名单 ---------------- */

test('白名单：放行 CDN 后缀', () => {
  ok(hostAllowed(safeUrl('https://tp9.drleao.cn/a.ts'), new Set(['huangguoai.com']), ['.drleao.cn']), 'tp9.drleao.cn 应放行');
  ok(hostAllowed(safeUrl('https://yd-lphu-long.hzjvlo.cn/a.m3u8'), new Set(), ['.hzjvlo.cn']), 'yz 域名应放行');
});

test('白名单：拦截伪造后缀与内网地址', () => {
  const hosts = new Set(['huangguoai.com']);
  const suffixes = ['.drleao.cn'];
  ok(!hostAllowed(safeUrl('https://evil.com/a.ts'), hosts, suffixes), 'evil.com 不应放行');
  ok(!hostAllowed(safeUrl('https://drleao.cn.evil.com/a.ts'), hosts, suffixes), '后缀伪造不应放行');
  ok(!hostAllowed(safeUrl('http://127.0.0.1/a.ts'), hosts, suffixes), '127.0.0.1 不应放行');
  ok(!hostAllowed(safeUrl('http://192.168.1.1/a.ts'), hosts, suffixes), '内网段不应放行');
  ok(!hostAllowed(safeUrl('http://169.254.169.254/latest/meta-data'), hosts, suffixes), '云元数据地址不应放行');
});

test('safeUrl：拒绝非 http(s)', () => {
  eq(safeUrl('file:///etc/passwd'), null);
  eq(safeUrl('javascript:alert(1)'), null);
  eq(safeUrl('not a url'), null);
  ok(!!safeUrl('https://a.drleao.cn/x'));
});

/* ---------------- 图片 ---------------- */

test('文件头嗅探', () => {
  eq(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), 'image/jpeg');
  eq(sniffImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])), 'image/png');
  eq(sniffImage(Buffer.from('RIFF0000WEBPVP8 ', 'latin1')), 'image/webp');
  eq(sniffImage(Buffer.from('GIF89a......', 'latin1')), 'image/gif');
  eq(sniffImage(Buffer.from('not-an-image')), null);
});

test('封面 AES-128-CBC 解密可逆（无填充）', () => {
  const key = Buffer.from('f5d965df75336270', 'utf8');
  const iv = Buffer.from('97b60394abc2fbe1', 'utf8');
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), crypto.randomBytes(28)]);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);

  const decrypted = decryptCover(encrypted);
  ok(decrypted, '解密返回空');
  eq(decrypted.toString('hex'), plain.toString('hex'), '解密结果');
  eq(decryptCover(Buffer.from('short')), null, '非 16 字节整数倍应返回 null');
});

/* ---------------- 路由契约 ---------------- */

await testAsync('OPTIONS 预检 -> 204 + CORS', async () => {
  const res = await call('/api/play', { method: 'OPTIONS' });
  eq(res.status, 204);
  eq(res.headers.get('access-control-allow-origin'), '*');
});

await testAsync('GET /health -> 200 JSON', async () => {
  const res = await call('/health');
  eq(res.status, 200);
  const body = await res.json();
  eq(body.status, 'ok');
  ok(body.version, '应带版本号');
});

await testAsync('未知路径 -> 404 JSON', async () => {
  const res = await call('/nope');
  eq(res.status, 404);
  const body = await res.json();
  eq(body.status, 0);
});

await testAsync('POST /api/play 缺 id -> 400', async () => {
  const res = await call('/api/play', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  eq(res.status, 400);
});

await testAsync('POST /api/play 非法 JSON -> 400（不抛 500）', async () => {
  const res = await call('/api/play', { method: 'POST', body: 'not-json' });
  eq(res.status, 400);
});

await testAsync('/api/play 用 GET 也支持 ?id=&ep=', async () => {
  const res = await call('/api/play?id=0');
  eq(res.status, 400); // id 非法，走校验分支而不是 405
});

await testAsync('/proxy/m3u8 非 http(s) url -> 400', async () => {
  const res = await call('/proxy/m3u8?url=' + encodeURIComponent('file:///etc/passwd'));
  eq(res.status, 400);
});

await testAsync('/proxy/m3u8 非白名单主机 -> 403', async () => {
  const res = await call('/proxy/m3u8?url=' + encodeURIComponent('https://evil.example.com/a.m3u8'));
  eq(res.status, 403);
});

await testAsync('/proxy/img 非白名单主机 -> 403', async () => {
  const res = await call('/proxy/img?url=' + encodeURIComponent('https://evil.example.com/a.jpg'));
  eq(res.status, 403);
});

await testAsync('/proxy/img 缺参数 -> 400', async () => {
  const res = await call('/proxy/img');
  eq(res.status, 400);
});

await testAsync('DELETE /api/videos -> 405', async () => {
  const res = await call('/api/videos', { method: 'DELETE' });
  eq(res.status, 405);
});

await testAsync('错误响应也带 CORS 头', async () => {
  const res = await call('/proxy/m3u8?url=bad');
  eq(res.status, 400);
  eq(res.headers.get('access-control-allow-origin'), '*');
});

/* ---------------- 部署路由（文件即路由） ----------------
 * Makers 按 cloud-functions 的目录结构生成路由，入口文件漏一个，整段路径就会
 * 落到静态兜底返回 index.html（200 + HTML），本地 dev server 因为直接调
 * onRequest 反而一切正常 —— 这组用例就是拦这类「本地绿、线上 404/错内容」。
 */

test('入口 api/[[default]].js -> /api/*', () => {
  ok(existsSync(path.join(FUNCTIONS_DIR, 'api', '[[default]].js')), '缺少 api/[[default]].js');
  eq(typeof entryApi.onRequest, 'function');
});

test('入口 proxy/[[default]].js -> /proxy/*', () => {
  ok(existsSync(path.join(FUNCTIONS_DIR, 'proxy', '[[default]].js')), '缺少 proxy/[[default]].js：/proxy/* 会掉进静态兜底返回 index.html');
  eq(typeof entryProxy.onRequest, 'function');
});

test('入口 health.js -> /health', () => {
  ok(existsSync(path.join(FUNCTIONS_DIR, 'health.js')), '缺少 health.js');
  eq(typeof entryHealth.onRequest, 'function');
});

test('共享实现放在 _lib 下（下划线前缀不生成路由）', () => {
  ok(existsSync(path.join(FUNCTIONS_DIR, '_lib', 'handler.js')), '缺少 _lib/handler.js');
});

test('三个入口指向同一份实现', () => {
  ok(entryApi.onRequest === onRequest, 'api 入口未复用共享实现');
  ok(entryProxy.onRequest === onRequest, 'proxy 入口未复用共享实现');
  ok(entryHealth.onRequest === onRequest, 'health 入口未复用共享实现');
});

await testAsync('前端用到的 /proxy/* 都命中了路由而不是 404', async () => {
  for (const p of ['/proxy/m3u8', '/proxy/key', '/proxy/ts', '/proxy/img']) {
    const res = await call(p + '?url=bad');
    ok(res.status !== 404, `${p} 未命中路由（返回 404，线上会掉进静态兜底）`);
  }
});

/* ---------------- 榜单标签 ↔ 上游 slug ----------------
 * 上游 /api/ranks/:type 只认 hot / recommend / potential，写错一个就返回
 * {"data":[],"msg":"榜单不存在"}，页面表现是「这个榜没数据」。
 * 这里离线比对 index.html 的标签和 app.js 的白名单，避免再出现幽灵榜单。
 */

test('榜单标签与 app.js 白名单一一对应', () => {
  const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const js = readFileSync(path.join(ROOT, 'app.js'), 'utf8');

  const at = html.indexOf('id="rankTabs"');
  ok(at > 0, 'index.html 里找不到 #rankTabs');
  const block = html.slice(at);
  const tabs = [...block.slice(0, block.indexOf('</div>')).matchAll(/data-type="([^"]+)"/g)].map((m) => m[1]);

  const decl = js.match(/RANK_TYPES\s*=\s*\{([\s\S]*?)\}/);
  ok(decl, 'app.js 里找不到 RANK_TYPES 白名单');
  const allowed = [...decl[1].matchAll(/([A-Za-z_]\w*)\s*:/g)].map((m) => m[1]);

  ok(tabs.length > 0, '没有解析到榜单标签');
  for (const t of tabs) ok(allowed.includes(t), `标签 ${t} 不在 app.js 白名单里，上游会返回「榜单不存在」`);
  for (const t of allowed) ok(tabs.includes(t), `白名单里的 ${t} 没有对应标签（死配置）`);
});

/* ---------------- 汇总 ---------------- */

const total = passed + failures.length;
console.log(`\n  ${passed}/${total} 通过${failures.length ? '，有失败用例' : ''}\n`);
process.exit(failures.length ? 1 : 0);
