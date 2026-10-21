// 构建时收集皮肤包：packs/<id>/skin.json 与同目录下的图片。只由 App 引入（Node 测试没有 import.meta.glob）。
import { collectPacks, registerSkinPacks } from './registry.js';

const manifests = import.meta.glob('./packs/*/skin.json', { eager: true, import: 'default' });
const files = import.meta.glob('./packs/*/**/*.{png,jpg,jpeg,webp,gif}', { eager: true, as: 'url' });

registerSkinPacks(collectPacks(manifests, files));
