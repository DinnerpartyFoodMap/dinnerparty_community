// 皮肤包登记与校验（纯函数，Node 测试可直接引用）。皮肤包由 packs.js 在构建时收集：
// src/skins/packs/<id>/skin.json + 同目录下的图片；以下划线开头的目录（_template）不登记。
import { SKIN_SLOTS } from './slots.js';

export const DEFAULT_SKIN_ID = 'default';
const SKIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// 美术按 PNG 交付；保留其他位图格式的兼容，不再加载 SVG。
const SKIN_IMAGE_FILE = /\.(png|jpe?g|webp|gif)$/i;
// CSS 值只允许颜色、阴影、尺寸会用到的字符：不能借皮肤注入 url()、分号或其他声明
const SAFE_CSS_VALUE = /^[#(),.%/\w\s+-]{1,200}$/;
const UNSAFE_CSS_WORD = /url|expression|image-set|attr|@/i;

const packs = new Map();
const listeners = new Set();

function getPath(object, key) {
    return key.split('.').reduce((value, part) => (value && typeof value === 'object' ? value[part] : undefined), object);
}

function numberIn(value, min, max) {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : undefined;
}

function cssValue(value) {
    if (typeof value !== 'string') return undefined;
    const text = value.trim();
    return SAFE_CSS_VALUE.test(text) && !UNSAFE_CSS_WORD.test(text) ? text : undefined;
}

function imageUrl(value, assets) {
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const file = value.trim().replace(/^\.\//, '');
    return SKIN_IMAGE_FILE.test(file) && Object.prototype.hasOwnProperty.call(assets, file) ? assets[file] : undefined;
}

// 对象型槽位：可以只写图片路径，其余字段取默认值
function withImage(value, assets, build) {
    const spec = typeof value === 'string' ? { image: value } : value;
    if (!spec || typeof spec !== 'object') return undefined;
    const image = imageUrl(spec.image, assets);
    return image ? Object.freeze(build(spec, image)) : undefined;
}

const pick = (value, min, max, fallback) => (value === undefined ? fallback : numberIn(value, min, max) ?? fallback);

const NORMALIZERS = {
    color: (value) => cssValue(value),
    shadow: (value) => cssValue(value),
    size: (value) => cssValue(value),
    px: (value, assets, def) => numberIn(value, 0, def.max ?? 200),
    percent: (value) => numberIn(value, 0, 100),
    enum: (value, assets, def) => (def.values.includes(value) ? value : undefined),
    image: (value, assets) => imageUrl(value, assets),
    frame: (value, assets) => withImage(value, assets, (spec, image) => ({
        image,
        slice: pick(spec.slice, 1, 500, 30),
        width: pick(spec.width, 1, 100, 15),
        outset: pick(spec.outset, 0, 100, 0),
        repeat: ['stretch', 'repeat', 'round', 'space'].includes(spec.repeat) ? spec.repeat : 'stretch'
    })),
    ornament: (value, assets) => withImage(value, assets, (spec, image) => ({
        image,
        width: pick(spec.width, 1, 200, 40),
        height: pick(spec.height, 1, 200, 40),
        x: pick(spec.x, -200, 200, 0),
        y: pick(spec.y, -200, 200, -20)
    })),
    pedestal: (value, assets) => withImage(value, assets, (spec, image) => ({
        image,
        width: pick(spec.width, 1, 120, 48),
        height: pick(spec.height, 1, 120, 48),
        y: pick(spec.y, -60, 60, 0)
    })),
    avatarFrame: (value, assets) => withImage(value, assets, (spec, image) => ({
        image,
        scale: pick(spec.scale, 1, 2, 1.3)
    }))
};

function normalizeSlots(source, assets, warn, where) {
    const values = {};
    if (!source || typeof source !== 'object') return values;
    for (const def of SKIN_SLOTS) {
        const raw = getPath(source, def.key);
        if (raw === undefined || raw === null || raw === '') continue;
        // 模板里留着默认参数、还没放图片的对象型槽位视为没填
        if (typeof raw === 'object' && !raw.image) continue;
        const value = NORMALIZERS[def.type](raw, assets, def);
        if (value === undefined) warn(`${where}: ${def.key} is invalid or its image is missing; keeping the default`);
        else values[def.key] = value;
    }
    return values;
}

/**
 * 校验一个皮肤包：只保留已知槽位里有效的值，图片换成构建后的地址。
 * @param {{ id: string, manifest: object, assets: Record<string, string>, warn?: (message: string) => void }} pack
 */
export function normalizeSkinPack({ id, manifest, assets = {}, warn = () => {} }) {
    if (!SKIN_ID_PATTERN.test(id || '') || id === DEFAULT_SKIN_ID) {
        warn(`skipped pack folder "${id}": use lowercase letters, digits and hyphens, and not "default"`);
        return null;
    }
    const data = manifest && typeof manifest === 'object' ? manifest : {};
    if (data.id && data.id !== id) warn(`${id}/skin.json: id differs from the folder name; using the folder name`);
    return Object.freeze({
        id,
        name: typeof data.name === 'string' && data.name.trim() ? data.name.trim() : id,
        description: typeof data.description === 'string' ? data.description.trim() : '',
        preview: imageUrl(data.preview, assets) || '',
        values: Object.freeze(normalizeSlots(data, assets, warn, id)),
        darkValues: Object.freeze(normalizeSlots(data.dark, assets, warn, `${id}.dark`))
    });
}

/** 当前模式下各槽位的值：深色模式叠加 dark 覆盖，再处理 inherit */
export function resolveSkinSlots(skin, { dark = false } = {}) {
    if (!skin) return {};
    const merged = dark ? { ...skin.values, ...skin.darkValues } : { ...skin.values };
    for (const def of SKIN_SLOTS) {
        if (merged[def.key] === undefined && def.inherit && merged[def.inherit] !== undefined) merged[def.key] = merged[def.inherit];
    }
    return merged;
}

/**
 * 把 import.meta.glob 的结果按皮肤目录分组。
 * @param {Record<string, object>} manifests  './packs/<id>/skin.json' → 内容
 * @param {Record<string, string>} files      './packs/<id>/<path>' → 构建后的地址
 */
export function collectPacks(manifests, files) {
    const result = [];
    for (const [file, manifest] of Object.entries(manifests || {})) {
        const match = /^\.\/packs\/([^/]+)\/skin\.json$/.exec(file);
        if (!match || match[1].startsWith('_')) continue;
        const prefix = `./packs/${match[1]}/`;
        const assets = {};
        for (const [path, url] of Object.entries(files || {})) {
            if (path.startsWith(prefix) && SKIN_IMAGE_FILE.test(path)) assets[path.slice(prefix.length)] = url;
        }
        result.push({ id: match[1], manifest, assets });
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
}

export function registerSkinPacks(list, { warn = (message) => console.warn('[skins]', message) } = {}) {
    for (const pack of list || []) {
        const skin = normalizeSkinPack({ ...pack, warn });
        if (skin) packs.set(skin.id, skin);
    }
    listeners.forEach((listener) => listener());
}

export function getSkin(id) {
    return packs.get(id) || null;
}

/** 本次构建里带有素材的皮肤（不含默认样式） */
export function listSkins() {
    return [...packs.values()];
}

export function subscribeSkinRegistry(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

export function clearSkinPacksForTesting() {
    packs.clear();
}
