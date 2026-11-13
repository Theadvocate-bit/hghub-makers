/**
 * HGhub · EdgeOne Makers 云函数入口 —— /health
 *
 * Makers 按文件路径路由：cloud-functions/health.js 精确接管 /health。
 * 实际逻辑在 cloud-functions/lib/handler.js。
 */
import { handle } from './lib/handler.js';

export async function onRequest(context) {
  return handle(context && context.request);
}
