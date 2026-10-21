// 皮肤可替换的位置（槽位）。skin.json 按 key 的点路径填写，没填或填错的槽位保持默认样式。
// 每个槽位的用途、建议尺寸见 doc/README.md；packs/_template/skin.json 列出了全部槽位（test:skins 保证两边一致）。
//
// type：
//   color / shadow / size  CSS 值（颜色、box-shadow、background-size），不能含 url()、分号、花括号等
//   px / percent           数字
//   enum                   values 里的一个字符串
//   image                  皮肤目录里的图片文件（相对 skin.json 的路径）
//   frame / ornament / pedestal / avatarFrame  带图片的对象（也可以只写图片路径，其余取默认值）
// texture: true  底纹：iOS 液态玻璃上从不叠加（保持玻璃通透），其他平台照常使用
// inherit        没填时沿用另一个槽位（底栏展开后的搜索框、菜单面板延续底栏的底纹与边框）
// icon: true     功能图标：iconRendering 为 template 时按单色图标处理，跟随文字颜色（浅色 / 深色模式各自取色），
//                其余图片（表情、头像、标记、装饰）始终按原色显示
// native         iOS 原生 SwiftUI 控件也使用这个槽位（见 nativeSkin.js）；底纹与底色永远不交给原生（液态玻璃保持通透）
// cssVar         写到根元素上的 CSS 变量；组件以 var(--skin-…, 原来的值) 读取，未设置时就是原样

const slot = (key, type, extra = {}) => Object.freeze({ key, type, ...extra });
const icon = (key) => slot(key, 'image', { icon: true, native: true });

export const ICON_RENDERINGS = Object.freeze(['original', 'template']);

export const SKIN_SLOTS = Object.freeze([
    // 功能图标的画法：original 原色（默认），template 单色、跟随文字颜色
    slot('iconRendering', 'enum', { values: ICON_RENDERINGS }),

    // 地点卡外框
    slot('placeCard.background', 'color', { cssVar: '--skin-card-bg' }),
    slot('placeCard.borderColor', 'color', { cssVar: '--skin-card-border-color' }),
    slot('placeCard.borderWidth', 'px', { cssVar: '--skin-card-border-width', max: 12 }),
    slot('placeCard.radius', 'px', { cssVar: '--skin-card-radius', max: 40 }),
    slot('placeCard.shadow', 'shadow', { cssVar: '--skin-card-shadow' }),
    slot('placeCard.texture', 'image', { cssVar: '--skin-card-texture', texture: true }),
    slot('placeCard.textureSize', 'size', { cssVar: '--skin-card-texture-size' }),
    slot('placeCard.frame', 'frame'),

    // 评分条：四档表情 + 还没有评价
    slot('rating.strongYes', 'image', { native: true }),
    slot('rating.aboveAverage', 'image', { native: true }),
    slot('rating.belowAverage', 'image', { native: true }),
    slot('rating.strongNo', 'image', { native: true }),
    slot('rating.none', 'image', { native: true }),

    // 卡片操作按钮
    icon('cardActions.navigate'),
    icon('cardActions.share'),
    icon('cardActions.favorite'),
    icon('cardActions.favoriteActive'),
    icon('cardActions.edit'),
    icon('cardActions.create'),
    icon('cardActions.details'),
    icon('cardActions.close'),
    slot('cardActions.buttonBackground', 'color', { cssVar: '--skin-action-bg' }),
    slot('cardActions.buttonBorderColor', 'color', { cssVar: '--skin-action-border-color' }),

    // 底部功能栏
    slot('toolbar.background', 'color', { cssVar: '--skin-toolbar-bg' }),
    slot('toolbar.borderColor', 'color', { cssVar: '--skin-toolbar-border-color' }),
    slot('toolbar.texture', 'image', { cssVar: '--skin-toolbar-texture', texture: true }),
    slot('toolbar.textureSize', 'size', { cssVar: '--skin-toolbar-texture-size' }),
    slot('toolbar.selectedColor', 'color', { cssVar: '--skin-toolbar-selected-color', native: true }),
    slot('toolbar.selectedPedestal', 'pedestal', { native: true }),
    slot('toolbar.ornamentStart', 'ornament', { native: true }),
    slot('toolbar.ornamentEnd', 'ornament', { native: true }),
    icon('toolbar.icons.more'),
    icon('toolbar.icons.favorites'),
    icon('toolbar.icons.journey'),
    icon('toolbar.icons.add'),
    icon('toolbar.icons.addCancel'),
    icon('toolbar.icons.search'),
    icon('toolbar.icons.alongRoute'),
    icon('toolbar.icons.locate'),
    icon('toolbar.icons.login'),

    // 底栏展开状态：搜索框、更多功能 / 账号菜单面板
    slot('expanded.search.background', 'color', { cssVar: '--skin-search-bg' }),
    slot('expanded.search.borderColor', 'color', { cssVar: '--skin-search-border-color', inherit: 'toolbar.borderColor' }),
    slot('expanded.search.texture', 'image', { cssVar: '--skin-search-texture', texture: true, inherit: 'toolbar.texture' }),
    slot('expanded.search.textureSize', 'size', { cssVar: '--skin-search-texture-size', inherit: 'toolbar.textureSize' }),
    slot('expanded.panel.background', 'color', { cssVar: '--skin-panel-bg' }),
    slot('expanded.panel.borderColor', 'color', { cssVar: '--skin-panel-border-color', inherit: 'toolbar.borderColor' }),
    slot('expanded.panel.texture', 'image', { cssVar: '--skin-panel-texture', texture: true, inherit: 'toolbar.texture' }),
    slot('expanded.panel.textureSize', 'size', { cssVar: '--skin-panel-texture-size', inherit: 'toolbar.textureSize' }),
    // “更多功能”各行的图标（网页面板默认没有图标，皮肤提供时显示在文字前；iOS 原生抽屉代替 SF Symbol）
    icon('expanded.panel.icons.alongRoute'),
    icon('expanded.panel.icons.random'),
    icon('expanded.panel.icons.journey'),
    icon('expanded.panel.icons.dinners'),
    icon('expanded.panel.icons.poster'),
    icon('expanded.panel.icons.admin'),
    icon('expanded.panel.icons.guide'),

    // 账号入口：住民自己的头像始终保留
    slot('account.defaultAvatar', 'image', { native: true }),
    slot('account.avatarFrame', 'avatarFrame', { native: true }),

    // 标记点与聚合点
    slot('markers.place', 'image'),
    slot('markers.avoid', 'image'),
    slot('markers.cluster', 'image'),
    slot('markers.clusterCountColor', 'color', { cssVar: '--skin-marker-count-color' }),
    slot('markers.clusterCountX', 'percent', { cssVar: '--skin-marker-count-x' }),
    slot('markers.clusterCountY', 'percent', { cssVar: '--skin-marker-count-y' }),
    slot('markers.labelBackground', 'color', { cssVar: '--skin-marker-label-bg' }),
    slot('markers.labelBorderColor', 'color', { cssVar: '--skin-marker-label-border' }),
    slot('markers.labelTextColor', 'color', { cssVar: '--skin-marker-label-color' })
]);

export const SKIN_SLOT_KEYS = Object.freeze(SKIN_SLOTS.map((item) => item.key));

export function findSlot(key) {
    return SKIN_SLOTS.find((item) => item.key === key) || null;
}

/** 这个槽位在当前皮肤下是否按单色图标（跟随文字颜色）显示 */
export function isTemplateIcon(key, slots) {
    const def = findSlot(key);
    return !!(def && def.icon && slots && slots.iconRendering === 'template');
}

// 选中底座由 CSS 伪元素绘制，拆成几个变量
export const PEDESTAL_CSS_VARS = Object.freeze(['--skin-pedestal', '--skin-pedestal-width', '--skin-pedestal-height', '--skin-pedestal-y']);

/** 所有可能写到根元素上的 CSS 变量（切换皮肤时先全部清掉） */
export const ALL_SKIN_CSS_VARS = Object.freeze([
    ...SKIN_SLOTS.filter((item) => item.cssVar).map((item) => item.cssVar),
    ...PEDESTAL_CSS_VARS
]);
