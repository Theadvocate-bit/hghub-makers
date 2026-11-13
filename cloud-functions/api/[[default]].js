/**
 * 路由入口：/api/*
 *
 * Makers 的文件即路由：cloud-functions/api/[[default]].js -> /api/任意层级。
 * 真正的实现放在 _lib/handler.js（下划线前缀的目录不生成路由，专供入口复用）。
 */
import { onRequest } from '../_lib/handler.js';

export { onRequest };
