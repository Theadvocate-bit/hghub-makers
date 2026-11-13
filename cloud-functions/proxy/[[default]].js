/**
 * 路由入口：/proxy/*
 *
 * 这一层必须单独存在：Makers 按目录生成路由，只写 api/[[default]].js 的话
 * /proxy/* 不会进函数，会落到静态兜底返回 index.html（表现为「返回的是 HTML」）。
 *
 *   /proxy/m3u8  -> 清单（并重写内部 URI）
 *   /proxy/key   -> AES 密钥
 *   /proxy/ts    -> 分片（支持 Range）
 *   /proxy/img   -> 加密封面解密
 */
import { onRequest } from '../_lib/handler.js';

export { onRequest };
