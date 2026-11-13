/**
 * HGhub · EdgeOne Makers 云函数入口 —— /proxy/*
 *
 * Makers 按文件路径路由：本文件接管 /proxy/*（HLS m3u8/key/ts 中转、封面解密）。
 * 这是独立的入口 —— 原来只有 api/[[default]].js 时，/proxy/* 不在 /api/ 前缀下，
 * 线上根本不进函数，落到静态兜底返回 index.html，导致视频和封面全挂。
 * 实际逻辑在 cloud-functions/lib/handler.js，与 /api/* 共享同一份。
 */
import { handle } from '../lib/handler.js';

export async function onRequest(context) {
  return handle(context && context.request);
}

export { __test__ } from '../lib/handler.js';
