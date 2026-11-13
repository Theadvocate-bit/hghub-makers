# hghub-makers

把 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)（HGhub 复刻：竖屏短剧网页 + 播放解析代理）改造到 **EdgeOne Makers** 上部署。

上游靠**两个常驻 Python 进程 + openssl 命令行**跑在一台服务器上；本仓库改成
**静态前端 + 单个 catch-all 云函数**，全部无状态、无第三方依赖、无需 openssl。

> 产品形态、上游接口、解密协议均来自 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)，版权归上游作者。
> 本仓库只做 serverless 适配与工程化整理。

当前版本：**1.3.1**

---

## 这次修了什么

### 影响播放的硬伤

| 问题 | 说明 | 修复 |
|---|---|---|
| **代理线路其实不生效** | `/proxy/m3u8` 只转发清单，清单里的 `#EXT-X-KEY` 和分片仍是 `tp*.drleao.cn` 的绝对地址，浏览器拿到后照样直连被墙的 CDN，于是「切到代理线路」只是清单走了一次代理 | 新增 `rewriteManifest()`，把清单内所有 URI（key / 分片 / 嵌套清单 / `EXT-X-MAP`）改写成 `/proxy/{key,ts,m3u8}?url=…`，整条链路留在函数里 |
| 分片不支持 Range | 代理整段下载，播放器无法局部读取/拖动 | 透传 `Range`，回 `206 + Content-Range + Accept-Ranges` |
| 上游超时 → HTML 500 | 前端 `r.json()` 直接抛 `Unexpected token`，用户只看到「加载失败」 | `onRequest` 全包 try/catch，统一返回 JSON + CORS，超时给 504 |
| 分片/清单无缓存头 | 每次起播都重新走一遍函数 | 清单 `no-cache`，分片 `max-age=86400`，封面 `max-age=604800, immutable` |
| 解密失败也当图片返回 | 把密文当 `image/jpeg` 塞回去，浏览器显示破图 | 校验文件头，非图片返回 `415`，让前端走三级兜底 |

### 交互硬伤

| 问题 | 说明 | 修复 |
|---|---|---|
| **榜单点不动** | 榜单条目字段是 `video_id`，前端只读 `id`，`openDetail(NaN)` | 统一用 `vidOf()` 读取（兼容 `id` / `video_id`） |
| **分享链接指向别人站点** | 写死 `https://sp1.45678.eu.org/` | 改为当前站点 `location.origin + pathname` |
| 分享的集数永远是第 1 集 | 分享按钮固定 `ep=1` | 按当前播放集 / 本地进度取 |
| 深链 `ep=1` 不自动播 | 文案说「直接开播」，实际只停在详情 | `ep >= 1` 都直接起播 |
| 一次点击触发 3 次 | 内联 `onclick` + 直接监听 + 文档级委托三处绑定，并发请求互相刷掉（分类点完 0 张卡） | 只保留一个文档级委托，删掉全部内联 `onclick` |
| 详情右侧栏点收藏会顺带播放 | 点事件冒泡到 `#dCover` | 判断 `closest('.detail-rail')`；并修正 rail 自带 `data-fav` 导致的二次切换 |
| 看第 150 集打开详情只显示 1–30 | 选集分段固定从 1 开始 | 分段自动跳到当前集所在区间 |
| 进度写入风暴 | `timeupdate` 里 `%5===0` 会在一秒内连写 4 次 | 4 秒节流 + 暂停/隐藏/卸载时强制落盘 |
| 起播失败永久黑屏 | 取播放地址失败只 catch 掉，没有任何提示 | 卡片上盖「点击重试」覆盖层，分页失败 3 秒自动重试 2 次 |
| 分页竞态 | 旧请求回来把新列表刷空、把 loading 提前置 false | 每次分页一个状态快照 + `gen` 令牌，过期响应直接丢弃 |
| 图片空 `src` | `#dCoverImg src=""` 会再请求一次当前页面 | 无封面时不写 `src` |
| `poster` 与封面重复拉取 | 同一张封面被 `<img>` 和 `video poster` 各拉一次 | 去掉 poster，封面图在视频下层 |
| IntersectionObserver 泄漏 | 每次刷新 feed 都重新 observe，旧节点永不解绑 | 重载时 `disconnect()` 并重建 |
| 已移除的帖子页仍留代码 | 底部导航早没入口，代码还在跑 | 删除 posts 相关视图与请求 |

### 其他完善

- 视觉：底部信息与右侧操作栏改为同一行 flex 底对齐，删掉靠 `getBoundingClientRect` 反复量算的 `alignShare()`。
- 无障碍：图标按钮补 `aria-label` / `aria-pressed`，弹窗 `role="dialog" aria-modal`，`Esc` 逐层关闭，卡片可键盘回车打开，`prefers-reduced-motion` 生效。
- 移动端：浏览器**后退键**先关弹窗而不是退出站点；URL 同步 `?v=&ep=`，可直接分享/刷新恢复。
- 缓存：浏览器 HTTP 缓存接管封面（省掉原来 Cache API + 二次 fetch 的一整套）。
- 配置：版本号、APK 地址、hls.js 兜底 CDN 都收在 `app.js` 顶部常量；hls.js 缺失时按需异步加载，不再靠内联 `<script>`。

---

## 目录结构

```
hghub-makers/
├── index.html                  # 页面结构（无内联脚本/样式）
├── styles.css                  # 样式
├── app.js                      # 前端逻辑（单文件 IIFE，按功能分区）
├── hls.min.js                  # 本地 hls.js
├── favicon.svg
├── cloud-functions/
│   ├── api/[[default]].js      # 入口：/api/*（播放解析、上游反代）
│   ├── proxy/[[default]].js    # 入口：/proxy/*（HLS 中转、封面解密）
│   ├── health.js               # 入口：/health
│   └── lib/handler.js          # 共享处理逻辑（三个入口都转到这里）
├── server/dev.mjs              # 本地预览：静态优先 + 函数路由
├── scripts/
│   ├── selftest.mjs            # 离线单测（不联网）
│   └── livetest.mjs            # 联网联调（真实上游 + CDN）
├── edgeone.json                # outputDirectory / maxDuration / 缓存头
└── package.json
```

> **静态文件必须放在仓库根目录。** Makers 的静态根就是仓库根（`outputDirectory`
> 默认 `.`），没有「`public/` 即静态根」这层约定。早期版本把前端放在 `public/`，
> 结果函数接口全部 200、而 `/app.js`、`/styles.css`、`/` 一律 404 —— 因为
> `cloud-functions/` 是按目录约定识别的，与静态根无关。
> 现在 `edgeone.json` 里显式写了 `"outputDirectory": "."`，避免控制台里残留的
> 输出目录设置再把路径带偏；`server/dev.mjs` 也改成以仓库根为静态根，本地与线上一致。

前端拆成 HTML / CSS / JS 三个文件，`index.html` 从 1585 行降到 300 行左右：
样式和脚本可以分别走 HTTP 缓存，改文案不用重新下载 100KB 内联脚本。

---

## 承接的路由

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/play` | POST / GET | 服务端调上游 playback，返回 HLS 清单地址（上游要求 body 为 `{}`） |
| `/proxy/m3u8` | GET | 拉清单 → **重写内部 URI** → 带 CORS 返回 |
| `/proxy/key` | GET | 拉 AES 密钥并转发 |
| `/proxy/ts` | GET | 拉分片并转发（支持 Range） |
| `/proxy/img` | GET | 拉加密封面 → AES-128-CBC 解密 → 返回真图片（LRU + 浏览器长缓存） |
| `/api/prefip` | GET | 代拉 Cloudflare 优选 IP（电信/联通/移动） |
| `/api/up/*`、`/api/*` | GET/POST | 同源反代到上游 `huangguoai.com`，查询串原样透传 |
| `/health` | GET | 健康检查（版本、运行时长、图片缓存占用） |
| `/`、`/app.js`、`/styles.css`、`/hls.min.js` | GET | 静态托管（不进函数） |

转发类接口只放行白名单域名（`.hzjvlo.cn` / `.drleao.cn` / `.aluxvl.cn` / `huangguoai.com`），
并显式拒绝 `localhost`、`127.*`、`10.*`、`192.168.*`、`172.16–31.*`、`169.254.*` 等内网地址。

---

## 部署

1. 登录 [EdgeOne Makers 控制台](https://console.tencentcloud.com/edgeone/makers)。
2. 新建项目 → 从 Git 仓库导入 → 选本仓库。
3. 构建配置：**构建命令留空，输出目录填 `.`**（`edgeone.json` 里也已经声明了，
   控制台留空即可；如果控制台被手动改成 `public` / `dist`，会覆盖不生效导致静态 404）。
4. `cloud-functions/` 会自动识别为函数目录，不需要额外配置。
5. 部署完成后访问分配的域名，先自查一遍：

```bash
curl -sI https://你的域名/           | head -1   # 200
curl -sI https://你的域名/app.js     | grep -i content-type   # text/javascript
curl -s  https://你的域名/health                  # {"ok":true,...}
```

CLI：

```bash
npm i -g edgeone
edgeone login
edgeone pages deploy
```

---

## 本地开发

```bash
npm run preview      # http://localhost:8787（PORT=8788 可改端口）
npm test             # 离线单测：清单重写 / 白名单 / 解密 / 路由契约，21 项
npm run test:live    # 联网联调：真实上游 + CDN，11 项
```

`npm test` 不联网、秒级返回，适合每次改完就跑。
`npm run test:live` 会真实拉一次清单、密钥、分片和封面（约 2–3MB），用于确认上游接口没变。

---

## 关键技术点

**为什么要重写 m3u8**：代理存在的意义就是「浏览器连不上 CDN 时也能播」。只转发清单
不重写 URI，浏览器解析清单后仍会去连 `tp2.drleao.cn`——代理等于白做。重写后所有请求
都回到同源 `/proxy/*`，由函数代取，签名参数原样保留。

**为什么封面要在服务端解密**：上游图床下发的「封面」不是图片，而是一串 AES 密文
（没有 JPEG/PNG 文件头），浏览器当 `<img src>` 永远显示不出来。上游协议公开
（`crypto-image-protocol.js`）：AES-128-CBC、无填充、key/iv 写死。原项目用 `openssl enc`
子进程，serverless 不允许起子进程，这里换 `node:crypto` 的
`createDecipheriv('aes-128-cbc', …)` + `setAutoPadding(false)`，解出 `ffd8ff` 真 JPEG。

**两个服务为什么能合并**：8080 播放代理和 8081 Web 反代都是纯转发 + 解密，无状态、
互不依赖（8081 原本只是把 `/proxy/*` 再转发给 8080）。合并成一个 catch-all 后少一跳内网转发。

**前端为什么只用一套事件绑定**：内联 `onclick` + `addEventListener` + 文档级委托三套并存时，
同一次点击会跑 2–3 次，`loadCats()` 并发的结果互相覆盖，表现就是「点了没反应」。
现在只有一个委托入口，`data-*` 决定行为。

---

## 已知限制

- 上游 `playback` 返回的 `cdn.authKey`（`x-cdn-auth`）目前不需要也能取到清单/分片；如某天
  CDN 开始强制校验，需要在 `handleMedia` 里补这个请求头。
- 分类 25/26/27 在上游当前是空的（只有 24 有内容），前端会显示「该分类暂无内容」。
- 榜单接口只返回前 20 名且不支持翻页。
- 本地账号仅存在 `localStorage`，不参与任何服务端校验，用途是记录收藏/历史归属。
- 静态根是仓库根，所以 `package.json`、`README.md`、`scripts/`、`server/` 这些开发期文件
  在线上也能被直接下载（不含任何凭证）。介意的话可以加一步 `buildCommand` 把白名单文件
  拷到 `dist/` 再令 `outputDirectory: "dist"`，但那时要重新确认 `cloud-functions/` 是否
  仍在仓库根被识别 —— 现阶段优先保证「能跑通」，故保持根目录直出。

---

## 许可与致谢

- 前端形态、解析逻辑、产品设计全部来自 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)。
- 本仓库仅做 EdgeOne Makers 的 serverless 适配与工程整理。
- 数据与播放源来自上游 `huangguoai.com`，仅供学习研究，请勿用于商业用途。
