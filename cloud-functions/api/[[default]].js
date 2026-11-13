/**
 * HGhub · EdgeOne Makers 云函数入口 —— /api/*
 *
 * Makers 按文件路径路由：本文件接管 /api/*（播放解析、上游反代）。
 * 实际逻辑在 cloud-functions/lib/handler.js，由 /api/*、/proxy/*、/health
 * 三个入口共享（/proxy/* 必须单独一个入口，否则线上不进函数、会落到静态兜底）。
 */
import { handle } from '../lib/handler.js';

export async function onRequest(context) {
  return handle(context && context.request);
}

export { __test__ } from '../lib/handler.js';
