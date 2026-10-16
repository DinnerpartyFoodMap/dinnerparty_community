// 测试脚本用：node --import ./scripts/support/json-modules.mjs ...
// 让 Node 像 Vite 一样直接 import JSON（src/i18n 引入文案文件时不带 with { type: 'json' }）。
import { register } from 'node:module';

register('./json-hooks.mjs', import.meta.url);
