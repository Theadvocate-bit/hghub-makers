/**
 * 路由入口：/health
 *
 * 文件即路由：cloud-functions/health.js -> /health（不带扩展名）。
 */
import { onRequest } from './_lib/handler.js';

export { onRequest };
