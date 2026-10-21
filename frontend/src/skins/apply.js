// 把皮肤写到根元素：CSS 变量 + data-skin 属性。默认样式不写任何变量，组件里的 var(--skin-…, 原值) 就回落到原样。
import { SKIN_SLOTS, ALL_SKIN_CSS_VARS } from './slots.js';

const cssUrl = (url) => `url("${String(url).replace(/["\\\n\r]/g, (ch) => encodeURIComponent(ch))}")`;

/**
 * 当前皮肤对应的 CSS 变量。iOS 上不输出底纹（texture）：液态玻璃保持通透，不换底纹。
 * @param {Record<string, any>} slots  resolveSkinSlots 的结果
 * @param {{ platform?: 'web'|'ios'|'android' }} options
 */
export function skinCssVariables(slots, { platform = 'web' } = {}) {
    const vars = {};
    for (const def of SKIN_SLOTS) {
        const value = slots[def.key];
        if (value === undefined) continue;
        if (def.texture && platform === 'ios') continue;
        if (def.type === 'pedestal') {
            vars['--skin-pedestal'] = cssUrl(value.image);
            vars['--skin-pedestal-width'] = `${value.width}px`;
            vars['--skin-pedestal-height'] = `${value.height}px`;
            vars['--skin-pedestal-y'] = `${value.y}px`;
            continue;
        }
        if (!def.cssVar) continue;
        if (def.type === 'image') vars[def.cssVar] = cssUrl(value);
        else if (def.type === 'px') vars[def.cssVar] = `${value}px`;
        else if (def.type === 'percent') vars[def.cssVar] = `${value}%`;
        else vars[def.cssVar] = value;
    }
    return vars;
}

/** 写入根元素；skinId 为 null 表示默认样式（清掉全部皮肤变量与属性） */
export function applySkinToRoot(root, skinId, slots, options) {
    if (!root || !root.style) return;
    const vars = skinId ? skinCssVariables(slots, options) : {};
    for (const name of ALL_SKIN_CSS_VARS) {
        if (vars[name] === undefined) root.style.removeProperty(name);
        else root.style.setProperty(name, vars[name]);
    }
    if (skinId) root.setAttribute('data-skin', skinId);
    else root.removeAttribute('data-skin');
    if (vars['--skin-pedestal']) root.setAttribute('data-skin-pedestal', '');
    else root.removeAttribute('data-skin-pedestal');
}
