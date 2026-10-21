// 皮肤：npm run test:skins
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIN_SLOTS, SKIN_SLOT_KEYS, ALL_SKIN_CSS_VARS } from '../../../src/skins/slots.js';
import { normalizeSkinPack, resolveSkinSlots, collectPacks, registerSkinPacks, clearSkinPacksForTesting, getSkin } from '../../../src/skins/registry.js';
import { skinCssVariables, applySkinToRoot } from '../../../src/skins/apply.js';
import { activateSkin, getActiveSkinId, getRequestedSkinId, skinSlot, subscribeSkin } from '../../../src/skins/skinStore.js';
import { nativeImageSource, nativeSkinChrome, nativeSkinIcon } from '../../../src/skins/nativeSkin.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const packsDir = path.join(root, 'src/skins/packs');

// 槽位定义自洽
assert.equal(new Set(SKIN_SLOT_KEYS).size, SKIN_SLOT_KEYS.length, '槽位不重复');
assert.equal(new Set(ALL_SKIN_CSS_VARS).size, ALL_SKIN_CSS_VARS.length, 'CSS 变量不重复');
for (const slot of SKIN_SLOTS) {
    if (slot.inherit) assert.ok(SKIN_SLOT_KEYS.includes(slot.inherit), `${slot.key} 继承的槽位存在`);
    if (slot.texture) assert.equal(slot.type, 'image', `${slot.key} 底纹是图片`);
    if (slot.cssVar) assert.match(slot.cssVar, /^--skin-[a-z-]+$/);
}

// 校验：只保留已知槽位里的有效值，图片换成构建后的地址
const warnings = [];
const assets = { 'card.png': '/assets/card.png', 'icons/nav.png': '/assets/nav.png', 'frame.png': '/assets/frame.png', 'dark-card.png': '/assets/dark-card.png', 'pedestal.png': '/assets/pedestal.png', 'preview.png': '/assets/preview.png' };
const skin = normalizeSkinPack({
    id: 'sakura',
    warn: (message) => warnings.push(message),
    assets,
    manifest: {
        id: 'other', name: ' 樱花 ', preview: './preview.png',
        unknownSection: { color: 'red' },
        placeCard: {
            background: '#FFF8FB', borderColor: 'rgba(226, 120, 159, 0.6)', borderWidth: 2, radius: 99, shadow: '0 6px 20px rgba(0,0,0,.2)',
            texture: './card.png', textureSize: '160px auto', frame: { image: 'frame.png', slice: 24, width: 12, repeat: 'bogus' }
        },
        cardActions: { navigate: 'icons/nav.png', share: 'missing.png', buttonBackground: 'red; background: url(x)' },
        toolbar: { borderColor: 'url(javascript:alert(1))', texture: 'card.png', selectedPedestal: 'pedestal.png', ornamentStart: { image: null, width: 40 } },
        expanded: { panel: { borderColor: '#123456' } },
        markers: { clusterCountX: 120, clusterCountY: 40, labelBackground: 'color-mix(in srgb, var(--theme-primary) 20%, white)' },
        dark: { placeCard: { background: '#2B2533', texture: 'dark-card.png' } }
    }
});
assert.equal(skin.id, 'sakura', '以目录名为准');
assert.equal(skin.name, '樱花');
assert.equal(skin.preview, '/assets/preview.png');
assert.deepEqual(skin.values['placeCard.frame'], { image: '/assets/frame.png', slice: 24, width: 12, outset: 0, repeat: 'stretch' });
assert.equal(skin.values['placeCard.radius'], undefined, '超出范围的数值丢弃');
assert.equal(skin.values['placeCard.texture'], '/assets/card.png');
assert.equal(skin.values['cardActions.navigate'], '/assets/nav.png');
assert.equal(skin.values['cardActions.share'], undefined, '找不到的图片保持默认');
assert.equal(skin.values['cardActions.buttonBackground'], undefined, '不能借 CSS 值注入声明');
assert.equal(skin.values['toolbar.borderColor'], undefined, '不能注入 url()');
assert.deepEqual(skin.values['toolbar.selectedPedestal'], { image: '/assets/pedestal.png', width: 48, height: 48, y: 0 }, '对象型槽位可以只写图片');
assert.equal(skin.values['toolbar.ornamentStart'], undefined, '模板里没放图片的对象型槽位视为没填');
assert.equal(skin.values['markers.clusterCountX'], undefined);
assert.equal(skin.values['markers.labelBackground'], 'color-mix(in srgb, var(--theme-primary) 20%, white)');
assert.ok(!Object.keys(skin.values).some((key) => key.startsWith('unknownSection')));
assert.ok(warnings.some((message) => message.includes('cardActions.share')));
assert.ok(warnings.some((message) => message.includes('id differs')));
assert.ok(!warnings.some((message) => message.includes('ornamentStart')), '没放图片的模板槽位不提示');
assert.equal(normalizeSkinPack({ id: 'default', manifest: {} }), null, 'default 留给默认样式');
assert.equal(normalizeSkinPack({ id: 'Bad_Name', manifest: {} }), null);

// 旧 SVG 引用不能混入位图皮肤：预览、图标、对象型装饰与深色覆盖都回退默认
const svgSkin = normalizeSkinPack({
    id: 'old-svg',
    manifest: {
        preview: 'old.svg', cardActions: { navigate: 'old.svg' },
        toolbar: { ornamentStart: { image: 'old.svg' } },
        dark: { markers: { place: 'old.svg' } }
    },
    assets: { 'old.svg': '/assets/old.svg' }
});
assert.equal(svgSkin.preview, '', 'SVG 预览不加载');
assert.deepEqual(svgSkin.values, {}, 'SVG 图标和装饰回退默认');
assert.deepEqual(svgSkin.darkValues, {}, '深色模式也不加载 SVG');

// 深色覆盖与继承：搜索框与菜单面板沿用底栏的底纹与边框
const light = resolveSkinSlots(skin, { dark: false });
const dark = resolveSkinSlots(skin, { dark: true });
assert.equal(light['placeCard.background'], '#FFF8FB');
assert.equal(dark['placeCard.background'], '#2B2533');
assert.equal(dark['placeCard.texture'], '/assets/dark-card.png');
assert.equal(dark['placeCard.borderColor'], 'rgba(226, 120, 159, 0.6)', '深色没覆盖的沿用浅色');
assert.equal(light['expanded.search.texture'], '/assets/card.png', '搜索框延续底栏底纹');
assert.equal(light['expanded.panel.texture'], '/assets/card.png');
assert.equal(light['expanded.panel.borderColor'], '#123456', '自己填了就不继承');
assert.equal(light['expanded.search.background'], undefined, '底色不继承');
assert.deepEqual(resolveSkinSlots(null), {});

// CSS 变量：iOS 液态玻璃上不输出任何底纹
const webVars = skinCssVariables(light, { platform: 'web' });
assert.equal(webVars['--skin-card-texture'], 'url("/assets/card.png")');
assert.equal(webVars['--skin-toolbar-texture'], 'url("/assets/card.png")');
assert.equal(webVars['--skin-card-border-width'], '2px');
assert.equal(webVars['--skin-pedestal'], 'url("/assets/pedestal.png")');
assert.equal(webVars['--skin-pedestal-y'], '0px');
assert.equal(webVars['--skin-marker-count-y'], '40%');
const iosVars = skinCssVariables(light, { platform: 'ios' });
for (const slot of SKIN_SLOTS.filter((item) => item.texture)) assert.equal(iosVars[slot.cssVar], undefined, `iOS 不输出 ${slot.cssVar}`);
assert.equal(iosVars['--skin-card-bg'], '#FFF8FB', 'iOS 只是不换底纹，颜色照常（玻璃表面由 overlay.css 固定）');
assert.equal(iosVars['--skin-pedestal'], 'url("/assets/pedestal.png")', '选中底座不是底纹');
assert.equal(skinCssVariables(light, { platform: 'android' })['--skin-card-texture'], 'url("/assets/card.png")', '安卓在玻璃上叠底纹');
assert.equal(skinCssVariables({ 'cardActions.navigate': 'a"b.png' })['--skin-card-texture'], undefined, '没有 cssVar 的槽位不写变量');

// 写入根元素：切回默认时全部清掉
function fakeRoot() {
    const props = new Map();
    const attrs = new Map();
    return {
        props, attrs,
        style: { setProperty: (name, value) => props.set(name, value), removeProperty: (name) => props.delete(name) },
        setAttribute: (name, value) => attrs.set(name, value),
        removeAttribute: (name) => attrs.delete(name)
    };
}
const element = fakeRoot();
element.style.setProperty('--theme-primary', '#E2789F');
applySkinToRoot(element, 'sakura', light, { platform: 'web' });
assert.equal(element.attrs.get('data-skin'), 'sakura');
assert.ok(element.attrs.has('data-skin-pedestal'));
assert.equal(element.props.get('--skin-card-bg'), '#FFF8FB');
applySkinToRoot(element, null, {}, { platform: 'web' });
assert.ok(!element.attrs.has('data-skin') && !element.attrs.has('data-skin-pedestal'));
assert.deepEqual([...element.props.keys()], ['--theme-primary'], '只清皮肤变量');

// 收集皮肤包：按目录分组，下划线开头的目录不登记
const collected = collectPacks({
    './packs/_template/skin.json': { name: 'template' },
    './packs/b-skin/skin.json': { name: 'B' },
    './packs/a-skin/skin.json': { name: 'A' }
}, {
    './packs/a-skin/icon.png': '/assets/a.png',
    './packs/a-skin/deep/dir/t.png': '/assets/t.png',
    './packs/a-skin/old.svg': '/assets/old.svg',
    './packs/a-skinx/other.png': '/assets/x.png',
    './packs/_template/x.png': '/assets/tpl.png'
});
assert.deepEqual(collected.map((pack) => pack.id), ['a-skin', 'b-skin']);
assert.deepEqual(collected[0].assets, { 'icon.png': '/assets/a.png', 'deep/dir/t.png': '/assets/t.png' });

// 当前皮肤：还没有素材的皮肤先显示默认样式，素材登记后自动换上
clearSkinPacksForTesting();
let notified = 0;
const unsubscribe = subscribeSkin(() => { notified += 1; });
activateSkin('later');
assert.equal(getRequestedSkinId(), 'later');
assert.equal(getActiveSkinId(), 'default');
assert.equal(skinSlot('markers.place'), undefined);
registerSkinPacks([{ id: 'later', manifest: { markers: { place: 'm.png' } }, assets: { 'm.png': '/assets/m.png' } }], { warn: () => {} });
assert.equal(getActiveSkinId(), 'later');
assert.equal(skinSlot('markers.place'), '/assets/m.png');
activateSkin('default');
assert.equal(skinSlot('markers.place'), undefined);
assert.ok(notified >= 3);
activateSkin('default');
const before = notified;
activateSkin('default');
assert.equal(notified, before, '没有变化不通知');
unsubscribe();
assert.ok(getSkin('later'));

// PNG 直接交给原生：兼容构建内联 data URL 和 App 包内地址，不依赖画布或异步转换
const png = 'data:image/png;base64,iVBORw0KGgo=';
assert.equal(nativeImageSource(png), png);
assert.equal(nativeImageSource('capacitor://localhost/assets/nav.png'), 'capacitor://localhost/assets/nav.png');
assert.equal(nativeImageSource('https://example.com/nav.svg'), undefined);
assert.equal(nativeImageSource('data:image/svg+xml;base64,PHN2Zz4='), undefined);
registerSkinPacks([{
    id: 'png-native',
    manifest: {
        iconRendering: 'template', toolbar: { icons: { more: 'nav.png' }, ornamentStart: 'frame.png', selectedPedestal: 'pedestal.png' },
        account: { avatarFrame: { image: 'frame.png', scale: 1.5 } }
    },
    assets: { 'nav.png': png, 'frame.png': 'capacitor://localhost/assets/frame.png', 'pedestal.png': png }
}]);
activateSkin('png-native');
assert.deepEqual(nativeSkinIcon('toolbar.icons.more'), { image: png, imageTemplate: true });
assert.deepEqual(nativeSkinIcon('toolbar.icons.search'), {}, '没有 PNG 时保留 SF Symbol');
assert.deepEqual(nativeSkinChrome(), {
    avatarFrame: { image: 'capacitor://localhost/assets/frame.png', scale: 1.5 },
    ornamentStart: { image: 'capacitor://localhost/assets/frame.png', width: 40, height: 40, x: 0, y: -20 },
    pedestal: { image: png, width: 48, height: 48, y: 0 }
});
activateSkin('default');
assert.deepEqual(nativeSkinChrome(), {}, '切回默认皮肤时清除 PNG 装饰');

// 模板列出全部槽位（新增槽位时同步模板）
const template = JSON.parse(fs.readFileSync(path.join(packsDir, '_template/skin.json'), 'utf8'));
const objectSlots = new Set(SKIN_SLOTS.filter((item) => ['frame', 'ornament', 'pedestal', 'avatarFrame'].includes(item.type)).map((item) => item.key));
const templateKeys = [];
(function flatten(object, prefix) {
    for (const [key, value] of Object.entries(object)) {
        const full = prefix ? `${prefix}.${key}` : key;
        if (!prefix && ['_readme', 'id', 'name', 'description', 'preview', 'dark'].includes(key)) continue;
        if (value && typeof value === 'object' && !objectSlots.has(full)) flatten(value, full);
        else templateKeys.push(full);
    }
})(template, '');
assert.deepEqual([...templateKeys].sort(), [...SKIN_SLOT_KEYS].sort(), '模板与槽位清单一致');

// 仓库里的皮肤包：id 合规、引用的图片存在、后端目录已登记
const catalog = JSON.parse(fs.readFileSync(path.join(root, '../backend/modules/skins/catalog.json'), 'utf8')).skins.map((entry) => entry.id);
const packs = fs.readdirSync(packsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('_')).map((entry) => entry.name);
for (const id of packs) {
    const dir = path.join(packsDir, id);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));
    const files = {};
    (function walk(current) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const file = path.join(current, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (/\.(png|jpe?g|webp|gif)$/i.test(entry.name)) files[path.relative(dir, file).split(path.sep).join('/')] = file;
        }
    })(dir);
    const problems = [];
    const normalized = normalizeSkinPack({ id, manifest, assets: files, warn: (message) => problems.push(message) });
    assert.ok(normalized, `皮肤目录 ${id} 合规`);
    assert.deepEqual(problems, [], `${id} 的槽位都有效`);
    assert.ok(catalog.includes(id), `${id} 需要在 backend/modules/skins/catalog.json 登记`);
}
const withoutAssets = catalog.filter((id) => !packs.includes(id));
if (withoutAssets.length) console.log(`提示：后端已登记但前端还没有素材的皮肤：${withoutAssets.join('、')}（兑换后显示默认样式）`);

console.log(`Skin tests passed (${SKIN_SLOTS.length} slots, ${packs.length} packs, ${catalog.length} catalog entries).`);
