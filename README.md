# hghub-makers

把 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)（HGhub 1.2.0 复刻：竖屏短剧网页 + 播放解析代理）改造到 **EdgeOne Makers** 上部署落地。

原项目靠**两个常驻 Python 进程 + openssl 命令行**跑在一台服务器上；本仓库把它改成
**静态前端 + 单个 catch-all 云函数**，全部无状态、无需常驻进程、无需 openssl，可直接部署到 EdgeOne Makers。

> 上游项目、前端页面、判定/解析逻辑全部来自 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)，
> 本仓库只做 serverless 化改造。

---

## 架构对比

| | 原项目 (hghub-clone) | 本仓库 (hghub-makers) |
|---|---|---|
| 前端 | `web/index.html` + `hls.min.js` | `public/` 静态托管（Makers CDN） |
| 播放解析代理 | `proxy/server.py`（8080，常驻） | 合并进 catch-all 函数 |
| Web 反代 / 封面解密 | `web/server.py`（8081，常驻） | 合并进 catch-all 函数 |
| 封面 AES 解密 | `openssl enc` 子进程 | `node:crypto`（serverless 无子进程） |
| 运行时 | 2 个 stdlib Python 服务 | 1 个 Node.js 云函数 |

前端 `index.html` **一行未改**：它本来就全走同源相对路径（`/api/play`、`/proxy/img`、`/api/*`），
后端换成函数后路由不变。

---

## 目录结构

```
hghub-makers/
├── public/
│   ├── index.html              # 前端（原样复用上游）
│   └── hls.min.js              # 本地 hls.js（不依赖 CDN）
├── cloud-functions/
│   └── api/
│       └── [[default]].js      # catch-all 云函数，承接全部动态路由
├── server/dev.mjs              # 本地预览（模拟 Makers 静态优先 + 函数路由）
├── scripts/selftest.mjs        # 自测（直接调函数，无需起服务）
├── edgeone.json                # Makers 配置（maxDuration + 静态缓存头）
└── package.json
```

---

## 承接的路由

catch-all 函数 `cloud-functions/api/[[default]].js` 覆盖前端用到的全部同源路径：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/play` | POST | 服务端调上游 playback，返回 HLS 清单地址（上游要求 body 为空 `{}`） |
| `/proxy/m3u8` `/proxy/key` `/proxy/ts` `/proxy` | GET | 服务端拉 HLS 清单/密钥/分片再带 CORS 转发（只放行白名单 CDN 域） |
| `/proxy/img` | GET | 拉加密封面 → AES-128-CBC 解密 → 返回真图片（带 LRU 缓存） |
| `/api/prefip` | GET | 代拉 Cloudflare 优选 IP 列表（电信/联通/移动） |
| `/api/up/*` `/api/edge/*` `/api/*` | GET/POST | 同源反代到上游 `huangguoai.com`（查询串原样透传） |
| `/health` | GET | 健康检查 |
| `/` `/hls.min.js` | GET | **静态托管**（不进函数，Makers 静态资源优先） |

转发类接口只放行白名单域名（`.drleao.cn` / `.hzjvlo.cn` / `huangguoai.com` 等），防止被当任意代理滥用。

---

## 部署

1. 登录 [EdgeOne Makers 控制台](https://console.tencentcloud.com/edgeone/makers)。
2. 新建项目 → 从 Git 仓库导入 → 选本仓库。
3. 构建配置保持默认（`public/` 为静态根，`cloud-functions/` 自动识别函数）。
4. 部署完成后访问分配的域名即可。

CLI 方式：

```bash
npm i -g edgeone
edgeone login
edgeone pages deploy
```

---

## 本地开发

```bash
npm run preview      # http://localhost:8787（模拟 Makers 静态优先 + 函数路由）
npm test             # 自测：直接调函数，覆盖全部关键路由，无需起服务
```

自测会真实访问上游与 CDN，需要联网。预期输出 `8/8 通过`。

---

## 关键改造说明

**封面为什么要在服务端解密**：上游图床 `pic.drleao.cn` 下发的封面不是图片，而是一串
AES 加密字节（无 JPEG/PNG 文件头），浏览器直接当 `<img src>` 永远显示不出来。上游自己的
解密协议是公开的（`crypto-image-protocol.js`）：AES-128-CBC、无填充、key/iv 写死。原项目用
`openssl enc` 子进程解密，但 serverless 环境不允许起子进程，本仓库改用 `node:crypto` 的
`createDecipheriv('aes-128-cbc', ...)` + `setAutoPadding(false)`，结果一致（解出 `ffd8ffe0` 真 JPEG）。

**两个服务为什么能合并**：8080 播放代理和 8081 Web 反代都是纯转发 + 解密，无状态、不互相依赖
（8081 原本只是把 `/proxy/*` 再转发给 8080）。合并成一个 catch-all 函数后，少一跳内网转发。

---

## 许可与致谢

- 前端、解析逻辑、产品形态全部来自 [vps1986/hghub-clone](https://github.com/vps1986/hghub-clone)，版权归上游作者。
- 本仓库仅做 EdgeOne Makers 的 serverless 适配。
- 数据与播放源来自上游 `huangguoai.com`，仅供学习研究，请勿用于商业用途。
