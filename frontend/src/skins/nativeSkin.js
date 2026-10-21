// iOS 原生 SwiftUI 控件（工具栏、更多功能、地点卡片）使用的皮肤。
// 原生只加载三种图片地址：App 包里的网页资源（capacitor://localhost/assets/…）、data:image/png|jpeg|webp|gif，
// 以及开发时的 http(s)。PNG 直接交给原生加载，与网页共用同一套美术素材。
// 值都按当前模式取（skinStore 已合并 dark 覆盖），切换深浅色后随下一次状态快照重新下发。
// 底纹、底色与边框永远不交给原生：液态玻璃保持通透。
import { skinSlot } from './skinStore.js';
import { isTemplateIcon } from './slots.js';
import { parseColorToRgb } from '../theme/theme.js';

const RASTER_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,/i;

const isSvg = (src) => /^data:image\/svg\+xml/i.test(src) || /\.svg(?:$|[?#])/i.test(src);

function absolute(src) {
    try {
        return new URL(src, typeof window !== 'undefined' ? window.location.href : undefined).href;
    } catch (e) {
        return undefined;
    }
}

/**
 * 原生能直接加载的位图地址；不支持的 SVG 返回 undefined（原生显示 SF Symbol）。
 * @param {string} src  皮肤槽位里的图片地址（构建后的地址或 data URL）
 */
export function nativeImageSource(src) {
    if (typeof src !== 'string' || !src || isSvg(src)) return undefined;
    if (RASTER_IMAGE.test(src)) return src;
    return absolute(src);
}

/** 一个图标槽位交给原生的字段：{ image, imageTemplate }；皮肤没有这张图时为空对象（原生用原来的 SF Symbol） */
export function nativeSkinIcon(slot) {
    const image = nativeImageSource(skinSlot(slot));
    if (!image) return {};
    return { image, imageTemplate: isTemplateIcon(slot, { iconRendering: skinSlot('iconRendering') }) };
}

function hexColor(value) {
    const rgb = parseColorToRgb(value);
    return rgb ? `#${[rgb.r, rgb.g, rgb.b].map((part) => Math.round(part).toString(16).padStart(2, '0')).join('')}` : undefined;
}

/** 工具栏装饰：头像框、两端装饰、选中底座、选中色。只含有值的字段 */
export function nativeSkinChrome() {
    const skin = {};
    const frame = skinSlot('account.avatarFrame');
    const frameImage = frame && nativeImageSource(frame.image);
    if (frameImage) skin.avatarFrame = { image: frameImage, scale: frame.scale };
    for (const key of ['ornamentStart', 'ornamentEnd']) {
        const value = skinSlot(`toolbar.${key}`);
        const image = value && nativeImageSource(value.image);
        if (image) skin[key] = { image, width: value.width, height: value.height, x: value.x, y: value.y };
    }
    const pedestal = skinSlot('toolbar.selectedPedestal');
    const pedestalImage = pedestal && nativeImageSource(pedestal.image);
    if (pedestalImage) skin.pedestal = { image: pedestalImage, width: pedestal.width, height: pedestal.height, y: pedestal.y };
    const selectedColor = hexColor(skinSlot('toolbar.selectedColor'));
    if (selectedColor) skin.selectedColor = selectedColor;
    return skin;
}
