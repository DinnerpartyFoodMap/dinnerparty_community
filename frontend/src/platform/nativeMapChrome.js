// iOS 原生地图控件（SwiftUI Liquid Glass）的网页端会话。只在 iOS App 内、插件可用且系统为 iOS 26+ 时启用；
// 其余情况网页始终使用自己的工具栏。协议见 ios/App/App/NativeMapChromePlugin.swift。
//
// 控件所有权握手：capabilities / attach / 首个状态 / 首个布局全部成功 → 网页隐藏自己的工具栏 → resume 显示原生控件。
// 任何时刻只有一组可交互、在读屏树中可见。上次握手接管过的设备（expectNativeMapChrome）在握手期间先不显示 Web 工具栏，
// 避免启动时先闪一下网页工具栏再换成原生控件；不支持的设备照常立即显示 Web 工具栏。
// 地图页被其他页面盖住时只收起原生控件（setPageHidden），会话保留，回到地图页直接恢复而不重新握手。
// 运行中故障：先确认原生已隐藏（dispose 回执，或等待原生自身的健康超时）再恢复 Web，绝不仅凭超时同时启用两组。

import { getPlatform, isPluginAvailable } from './env.js';
import { onAppStateChange } from './lifecycle.js';
import { getMotionPolicy } from '../motion/policy.js';
import { subscribeOverlays, getOverlayEntries, hasNativeSuspendingOverlay } from '../components/overlay/overlayStack.js';
import { setNativeOccupiedRects } from '../map/viewport.js';
import { t } from '../i18n/index.js';

// v2 增加搜索动作与独立头像；v3 搜索展开后工具栏变为原生输入框（search 状态与事件）；
// v4 更多 / 住民 / 收藏面板改为系统 sheet（sheet 快照与事件）；v5 地点卡片也改为系统 sheet（操作按钮、正文、地图可操作）；
// v6 “更多”改为工具栏上滑展开（drawer 快照与事件），地点卡片改为两段停靠（收藏圆钮、等宽操作按钮、上滑全屏详情与图片）；
// v7 展会面板也改为两段停靠的原生卡片（exhibition 面板、标题左侧图标 image、分段正文 paragraphs）；
// v8 主题皮肤：按钮与面板行可带皮肤图片（image / imageTemplate，代替 SF Symbol），地点卡片关闭钮 closeImage，
// skin 快照（头像框、工具栏两端装饰、选中底座、选中色）。玻璃底纹与底色不下发。
// v9 卡片的副标题与地址行可点（subtitleAction / captionAction，展会地点），点按回传行 id。
// v10 操作指引（tour）：指引打开时原生控件不收起，按下发的目标画高亮圈、其余变暗、触摸交给网页，
// 目标位置随布局回传（"tour" slot 与 tour.step）；“更多功能”一步播放上滑示意并允许拖动工具栏练习（tour.drawerOpen）。
// v11 住民的地点列表面板（userPlaces，list 样式）：地点卡片点“最近修改”的住民后打开，关闭只收起列表、筛选保留。
// 版本不一致时回退 Web，避免旧 App 静默丢掉搜索框或面板。
// labels（原生自带的固定文案：读屏标签、“简介”等）旧版原生会忽略，仍用自带的中文，因此不需要升级协议版本。
// 同理，正文段落的 markdown（展会简介、信息的行内 Markdown）旧版原生忽略，仍显示纯文本 text。
export const NATIVE_CHROME_PROTOCOL = 11;
export const NATIVE_CHROME_ACTIONS = Object.freeze(['more', 'favorites', 'journey', 'add', 'search', 'alongRoute', 'account', 'locate']);
export const NATIVE_SEARCH_EVENTS = Object.freeze(['input', 'submit', 'focus', 'close']);
export const NATIVE_SEARCH_TEXT_LIMIT = 100;
export const NATIVE_SHEETS = Object.freeze(['account', 'favorites', 'place', 'exhibition', 'userPlaces']);
export const NATIVE_SHEET_EVENTS = Object.freeze(['select', 'dismiss']);
export const NATIVE_DRAWER_EVENTS = Object.freeze(['select']);
// 操作指引的目标：上滑展开更多功能（工具栏本身）
export const NATIVE_TOUR_DRAWER = 'drawer';
const SHEET_ROW_LIMIT = 300;
const SHEET_TONES = ['danger', 'muted', 'warning', 'accent'];
const SHEET_ACTION_LIMIT = 6;
const SHEET_SIZES = ['fit', 'list', 'card'];

/** A different activity is a new native card; refreshing the same activity preserves its expansion. */
export function nextNativeSheetIdentity(previous, id, entityId = null) {
    const current = previous || { id: null, token: 0, entityId: null };
    const nextEntityId = id === 'exhibition' ? entityId : null;
    if (current.id === id && (current.entityId ?? null) === nextEntityId) return current;
    return { id, entityId: nextEntityId, token: current.token + (id ? 1 : 0) };
}
const DRAWER_ROW_LIMIT = 40;
const GALLERY_GROUP_LIMIT = 4;
const GALLERY_IMAGE_LIMIT = 12;
const PARAGRAPH_LIMIT = 4;
const PLUGIN_NAME = 'NativeMapChrome';
const HEARTBEAT_MS = 1500;
// 与原生 NativeMapChromePlugin.healthTimeout（5s）对应，再留出余量
const NATIVE_SELF_HIDE_MS = 5000 + 1500;
const HANDSHAKE_TIMEOUT_MS = 2500;
const CALL_TIMEOUT_MS = 1500;
const RETRY_DELAY_MS = 3000;
// 连续失败的重试上限；原生控件稳定显示这么久后清零
const MAX_RETRIES = 6;
const STABLE_RESET_MS = 30000;

let pluginPromise = null;

function loadPlugin() {
    if (!pluginPromise) {
        // 插件代理对任意属性（包括 then）都返回方法：直接作为 Promise 结果会被当成 thenable，
        // await 永远不会完成（真机上握手因此挂起）。所以包一层普通对象再返回。
        pluginPromise = import('@capacitor/core').then(({ registerPlugin }) => ({ plugin: registerPlugin(PLUGIN_NAME) }));
        pluginPromise.catch(() => { pluginPromise = null; });
    }
    return pluginPromise;
}

// ---- 诊断：最近一次握手的状态与失败原因，显示在设置页，便于真机排查 ----
// state: idle | connecting | native | unsupported | web
const statusListeners = new Set();
let chromeStatus = Object.freeze({ state: 'idle', reason: '', retrying: false, at: 0 });

function setStatus(patch) {
    chromeStatus = Object.freeze({ ...chromeStatus, ...patch, at: Date.now() });
    statusListeners.forEach((fn) => {
        try { fn(chromeStatus); } catch (e) { /* ignore */ }
    });
}

export function getNativeChromeStatus() {
    return chromeStatus;
}

export function subscribeNativeChromeStatus(fn) {
    statusListeners.add(fn);
    return () => statusListeners.delete(fn);
}

// ---- 上次握手的明确结果（native / unsupported），记在本机供下次启动预判 ----
const OUTCOME_STORAGE_KEY = 'foodmap.nativeChrome.outcome';

function rememberOutcome(outcome) {
    try { window.localStorage.setItem(OUTCOME_STORAGE_KEY, outcome); } catch (e) { /* ignore */ }
}

/** 握手是否预计会由原生接管：没有记录时按会接管处理（不支持的设备只在第一次启动多等一次能力查询）。 */
export function expectNativeMapChrome() {
    if (chromeStatus.state === 'unsupported') return false;
    try { return window.localStorage.getItem(OUTCOME_STORAGE_KEY) !== 'unsupported'; } catch (e) { return true; }
}

function describeError(step, error) {
    const message = error && (error.message || error.code || String(error));
    return message ? `${step}: ${String(message).slice(0, 80)}` : step;
}

export function canUseNativeMapChrome() {
    return getPlatform() === 'ios' && isPluginAvailable(PLUGIN_NAME);
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), ms);
        promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const nextFrames = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

function randomId(prefix) {
    try {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
    } catch (e) { /* ignore */ }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** 只保留白名单内的动作与必要字段；桥接不传认证凭据或地点列表。 */
export function sanitizeItems(items) {
    return (Array.isArray(items) ? items : [])
        .filter((item) => item && NATIVE_CHROME_ACTIONS.includes(item.id))
        .map((item) => ({
            id: item.id,
            title: String(item.title || '').slice(0, 24),
            symbol: String(item.symbol || 'circle'),
            selected: !!item.selected,
            disabled: !!item.disabled,
            busy: !!item.busy,
            badge: item.badge == null ? undefined : String(item.badge).slice(0, 4),
            avatarURL: item.id === 'account' ? sanitizeAvatarURL(item.avatarURL) : undefined,
            ...sanitizeSkinIcon(item),
            placement: item.id === 'account' ? 'account' : (item.placement === 'floating' ? 'floating' : 'toolbar'),
            tone: item.tone === 'accent' || item.tone === 'danger' ? item.tone : undefined,
            opensOverlay: !!item.opensOverlay
        }));
}

const toCounter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

/** 原生控件自带的固定文案。imageNumber 里的 {title} / {index} 由原生替换 */
export function nativeChromeLabels() {
    return {
        mainActions: t('map:ui.mainActions'),
        expandDrawer: t('map:ui.expandMore'),
        collapseDrawer: t('map:ui.collapseMore'),
        exitSearch: t('map:ui.search.exit'),
        dismissKeyboard: t('map:ui.dismissKeyboard'),
        clearSearch: t('map:ui.search.clear'),
        close: t('common:action.close'),
        noDescription: t('map:placeDetail.noDescription'),
        intro: t('map:placeDetail.intro'),
        image: t('map:placeDetail.image'),
        imageNumber: t('map:placeDetail.imageNumber', { title: '{title}', index: '{index}' }),
        closePreview: t('map:placeDetail.closePreview')
    };
}

/** 底部搜索栏状态：只传展示所需字段。textVersion 只在网页主动改写文本时递增，原生据此决定是否覆盖输入框。 */
export function sanitizeSearch(search) {
    const s = search || {};
    return {
        expanded: !!s.expanded,
        placeholder: String(s.placeholder || t('common:action.search')).slice(0, 40),
        hint: String(s.hint || '').slice(0, 160),
        busyLabel: String(s.busyLabel || '').slice(0, 60),
        busy: !!s.busy,
        text: String(s.text || '').slice(0, NATIVE_SEARCH_TEXT_LIMIT),
        textVersion: toCounter(s.textVersion),
        focusToken: toCounter(s.focusToken),
        focus: !!s.focus
    };
}

const clipText = (value, limit) => (value == null || value === '' ? undefined : String(value).slice(0, limit));

/**
 * 原生面板快照：只允许白名单面板；行只带展示字段（标题、副标题、SF Symbol、语气、禁用），
 * 不传地点坐标等数据——点按后原生只回传行 id，由网页查表执行。返回 null 表示关闭面板。
 */
export function sanitizeSheet(sheet) {
    if (!sheet || !NATIVE_SHEETS.includes(sheet.id)) return null;
    return {
        id: sheet.id,
        token: toCounter(sheet.token),
        // 展会名最多 80 字（地点名更短）
        title: clipText(sheet.title, 80) || '',
        subtitle: clipText(sheet.subtitle, 80),
        message: clipText(sheet.message, 120),
        messageTone: sheet.messageTone === 'loading' || sheet.messageTone === 'danger' ? sheet.messageTone : undefined,
        // card：地点卡片两段停靠（摘要时地图可操作）；list：半屏 / 全屏列表；fit：按内容高度的菜单
        size: SHEET_SIZES.includes(sheet.size) ? sheet.size : 'fit',
        leading: sheet.leading ? sanitizeSheetRows([sheet.leading], { rows: 1 })[0] : undefined,
        detail: clipText(sheet.detail, 2000),
        // 简介的行内 Markdown（markdownToNativeInline 生成，HTML 已转义）；旧版原生不认它，仍显示 detail
        detailMarkdown: clipText(sheet.detailMarkdown, 4000),
        caption: clipText(sheet.caption, 200),
        // 标题左侧的图标（展会图标；有 leading 圆钮时不显示）
        image: sanitizeImageURL(sheet.image),
        // 分段正文（展会简介、展会信息）：有内容时代替 detail 的“简介”一段；每段可带行内 Markdown（markdown）
        paragraphs: sanitizeParagraphs(sheet.paragraphs),
        actions: sanitizeSheetRows(sheet.actions, { rows: SHEET_ACTION_LIMIT }),
        sections: sanitizeSections(sheet.sections, { rows: SHEET_ROW_LIMIT }),
        gallery: sanitizeGallery(sheet.gallery),
        // 地点卡片右上角关闭钮的皮肤图片
        ...renameSkinIcon(sanitizeSkinIcon({ image: sheet.closeImage, imageTemplate: sheet.closeImageTemplate }), 'closeImage'),
        // 可点的副标题（摘要）与地址行（详情）：与面板行相同的字段，点按回传行 id
        subtitleAction: sheet.subtitleAction ? sanitizeSheetRows([sheet.subtitleAction], { rows: 1 })[0] : undefined,
        captionAction: sheet.captionAction ? sanitizeSheetRows([sheet.captionAction], { rows: 1 })[0] : undefined
    };
}

const SKIN_IMAGE_LIMIT = 300_000;
const BASE64_IMAGE = /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/;

/**
 * 皮肤图片：App 包里的网页资源（capacitor:）、开发时的 http(s)，或 PNG / JPEG / WebP / GIF 的 base64 data URL
 * （PNG 由 skins/nativeSkin.js 直接提供）。不带凭据，长度封顶。
 */
export function sanitizeSkinImage(value) {
    if (typeof value !== 'string' || !value || value.length > SKIN_IMAGE_LIMIT) return undefined;
    if (value.startsWith('data:')) return BASE64_IMAGE.test(value) ? value : undefined;
    if (value.length > 2048) return undefined;
    try {
        const url = new URL(value);
        return ['capacitor:', 'https:', 'http:'].includes(url.protocol) && url.hostname && !url.username && !url.password ? url.href : undefined;
    } catch { return undefined; }
}

function sanitizeSkinIcon(source) {
    const image = sanitizeSkinImage(source && source.image);
    return image ? { image, imageTemplate: !!source.imageTemplate } : {};
}

function renameSkinIcon(icon, key) {
    return icon.image ? { [key]: icon.image, [`${key}Template`]: icon.imageTemplate } : {};
}

const clampNumber = (value, min, max, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

/** 工具栏装饰（v8）：头像框、两端装饰、选中底座、选中色（#RRGGBB）。没有图片的项不下发 */
export function sanitizeSkin(skin) {
    const source = skin && typeof skin === 'object' ? skin : {};
    const out = {};
    const decor = (value, build) => {
        const image = value && typeof value === 'object' ? sanitizeSkinImage(value.image) : undefined;
        return image ? build(value, image) : undefined;
    };
    const frame = decor(source.avatarFrame, (value, image) => ({ image, scale: clampNumber(value.scale, 1, 2, 1.3) }));
    if (frame) out.avatarFrame = frame;
    for (const key of ['ornamentStart', 'ornamentEnd']) {
        const ornament = decor(source[key], (value, image) => ({
            image,
            width: clampNumber(value.width, 1, 200, 40),
            height: clampNumber(value.height, 1, 200, 40),
            x: clampNumber(value.x, -200, 200, 0),
            y: clampNumber(value.y, -200, 200, -20)
        }));
        if (ornament) out[key] = ornament;
    }
    const pedestal = decor(source.pedestal, (value, image) => ({
        image,
        width: clampNumber(value.width, 1, 120, 48),
        height: clampNumber(value.height, 1, 120, 48),
        y: clampNumber(value.y, -60, 60, 0)
    }));
    if (pedestal) out.pedestal = pedestal;
    if (typeof source.selectedColor === 'string' && /^#[0-9a-f]{6}$/i.test(source.selectedColor)) out.selectedColor = source.selectedColor;
    return out;
}

function sanitizeParagraphs(list) {
    const paragraphs = [];
    for (const [index, item] of (Array.isArray(list) ? list : []).entries()) {
        if (paragraphs.length >= PARAGRAPH_LIMIT) break;
        const text = item && typeof item === 'object' ? clipText(String(item.text ?? '').trim(), 2000) : undefined;
        if (!text) continue;
        paragraphs.push({ id: clipText(item.id, 32) || `paragraph-${index}`, title: clipText(item.title, 40), text,
            // 行内 Markdown（markdownToNativeInline 生成）；旧版原生不认它，仍显示 text
            markdown: clipText(item.markdown, 4000) });
    }
    return paragraphs;
}

/** 工具栏上滑展开的“更多功能”：与面板相同的分组行；没有可显示的行时返回 null（原生不显示拖动条）。 */
export function sanitizeDrawer(drawer) {
    if (!drawer) return null;
    const sections = sanitizeSections(drawer.sections, { rows: DRAWER_ROW_LIMIT });
    return sections.some((section) => section.rows.length) ? { sections } : null;
}

/**
 * 操作指引（v10）：当前一步要原生指出的控件。null 表示没有指引。
 * drawer 为假时 target 是按钮 id，或 'drawer'（上滑展开更多功能的示意与练习）；drawer 为真时展开更多功能，target 是其中一行的 id。
 * target 为 null 时只把原生控件变暗（欢迎页）。
 */
export function sanitizeTour(tour) {
    if (!tour || typeof tour !== 'object') return null;
    const drawer = !!tour.drawer;
    const target = clipText(tour.target, 64);
    const allowed = drawer || target === NATIVE_TOUR_DRAWER || NATIVE_CHROME_ACTIONS.includes(target);
    return { step: clipText(tour.step, 32) || '', target: allowed && target ? target : null, drawer };
}

const finiteRect = (slot) => {
    if (!slot || typeof slot !== 'object') return null;
    const [x, y, width, height] = [slot.x, slot.y, slot.width, slot.height].map(Number);
    if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
    return { left: x, top: y, right: x + width, bottom: y + height };
};

/**
 * 原生布局里的操作指引状态（WebView 视口 CSS 像素，与 getBoundingClientRect 同一坐标系）。原生控件收起或没有指引时为 null。
 * rect：当前目标（"tour" slot，可能还没回传）；chrome：所有原生控件的外框，说明卡片要避开（原生控件画在网页之上）；
 * drawerOpen：更多功能已展开（练习上滑成功）。
 */
export function readTourLayout(layout) {
    const tour = layout && layout.showing ? layout.tour : null;
    if (!tour || typeof tour !== 'object') return null;
    let rect = null;
    let chrome = null;
    for (const slot of Array.isArray(layout.slots) ? layout.slots : []) {
        // 菜单面板指引期间不显示，它的位置可能是旧的
        if (!slot || slot.id === 'panel') continue;
        const box = finiteRect(slot);
        if (!box) continue;
        if (slot.id === 'tour') rect = box;
        chrome = chrome
            ? { left: Math.min(chrome.left, box.left), top: Math.min(chrome.top, box.top), right: Math.max(chrome.right, box.right), bottom: Math.max(chrome.bottom, box.bottom) }
            : box;
    }
    return { step: clipText(tour.step, 32) || '', rect, chrome, drawerOpen: !!tour.drawerOpen };
}

function sanitizeSections(list, budget) {
    return (Array.isArray(list) ? list : []).slice(0, 8).map((section, index) => ({
        id: clipText(section && section.id, 32) || `section-${index}`,
        title: clipText(section && section.title, 40),
        footer: clipText(section && section.footer, 120),
        style: section && section.style === 'footnote' ? 'footnote' : 'list',
        rows: sanitizeSheetRows(section && section.rows, budget)
    }));
}

/**
 * 地点图片：只传公网 https 地址（原生直接加载），不带凭据；每组最多 12 张、最多 4 组。
 * thumbnails（可选）与 images 逐项对应，原生方块用缩略图、大图用原图；缺失或无效的项回退为原图。
 * 旧版原生忽略 thumbnails，仍用原图，因此不需要升级协议版本。
 */
function sanitizeGallery(list) {
    const groups = [];
    for (const [index, group] of (Array.isArray(list) ? list : []).slice(0, GALLERY_GROUP_LIMIT).entries()) {
        const rawImages = Array.isArray(group && group.images) ? group.images : [];
        const rawThumbnails = Array.isArray(group && group.thumbnails) ? group.thumbnails : [];
        const images = [];
        const thumbnails = [];
        for (const [i, raw] of rawImages.entries()) {
            if (images.length >= GALLERY_IMAGE_LIMIT) break;
            const image = sanitizeImageURL(raw);
            if (!image) continue;
            images.push(image);
            thumbnails.push(sanitizeImageURL(rawThumbnails[i]) || image);
        }
        if (!images.length) continue;
        groups.push({ id: clipText(group.id, 32) || `gallery-${index}`, title: clipText(group.title, 40), images, thumbnails });
    }
    return groups;
}

function sanitizeImageURL(value) {
    try {
        if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname && !url.username && !url.password ? url.href : undefined;
    } catch { return undefined; }
}

function sanitizeSheetRows(list, budget) {
    const seen = new Set();
    const rows = [];
    for (const row of Array.isArray(list) ? list : []) {
        // 条件行（cond && {...}）可能是 false：clipText 会把它变成字符串 "false"，必须先跳过非对象
        if (!row || typeof row !== 'object') continue;
        const id = clipText(row.id, 64);
        if (!id || seen.has(id) || budget.rows <= 0) continue;
        seen.add(id);
        budget.rows -= 1;
        rows.push({
            id,
            title: clipText(row.title, 60) || id,
            subtitle: clipText(row.subtitle, 80),
            symbol: clipText(row.symbol, 64),
            ...sanitizeSkinIcon(row),
            tone: SHEET_TONES.includes(row.tone) ? row.tone : undefined,
            disabled: !!row.disabled,
            keepsOpen: !!row.keepsOpen,
            expands: !!row.expands
        });
    }
    return rows;
}

function sanitizeAvatarURL(value) {
    try {
        if (typeof value !== 'string' || !value.trim()) return undefined;
        // 皮肤的默认头像可能是 base64 PNG（构建时小图被内联）
        if (value.startsWith('data:')) return sanitizeSkinImage(value);
        const url = new URL(value, typeof window !== 'undefined' ? window.location.href : undefined);
        return ['https:', 'http:', 'capacitor:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
    } catch { return undefined; }
}

export class NativeMapChromeSession {
    /**
     * @param {{ ownerId: string, onAction: (actionId: string) => (boolean|void),
     *           onModeChange: (mode: 'web'|'native') => void, onLayout?: (layout: object) => void,
     *           onSearch?: (event: { type: 'input'|'submit'|'focus'|'close', text?: string, focused?: boolean }) => void,
     *           onSheet?: (event: { type: 'select'|'dismiss', sheetId: string, token: number, rowId?: string }) => void,
     *           onDrawer?: (event: { type: 'select', rowId: string }) => void,
     *           plugin?: object, available?: boolean, timing?: object }} options
     * plugin / available / timing 仅供测试注入。
     */
    constructor({ ownerId, onAction, onModeChange, onLayout, onSearch, onSheet, onDrawer, plugin = null, available = null, timing = null }) {
        this.injectedPlugin = plugin;
        this.available = available;
        this.timing = { selfHideMs: NATIVE_SELF_HIDE_MS, retryMs: RETRY_DELAY_MS, handshakeMs: HANDSHAKE_TIMEOUT_MS, ...timing };
        this.ownerId = ownerId;
        this.onAction = onAction;
        this.onSearch = onSearch;
        this.onSheet = onSheet;
        this.onDrawer = onDrawer;
        this.onModeChange = onModeChange;
        this.onLayout = onLayout;
        this.mode = 'web';
        this.sessionId = null;
        this.plugin = null;
        this.revision = 0;
        this.snapshot = null;
        this.suspended = false;
        this.pageHidden = false;
        this.active = false;
        this.stopped = false;
        this.listeners = [];
        this.seenEvents = [];
        this.heartbeatTimer = 0;
        this.retryTimer = 0;
        this.unsubscribeOverlays = null;
        this.unsubscribeLifecycle = null;
        this.layoutWaiters = [];
        this.lastLayout = null;
        this.pushChain = Promise.resolve();
        this.failures = 0;
        this.stableTimer = 0;
    }

    _setMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        if (mode === 'web') setNativeOccupiedRects(this.ownerId, null);
        this.onModeChange && this.onModeChange(mode);
    }

    /** 尝试握手；失败时保持 Web 工具栏，返回 false。 */
    async start(snapshot) {
        this.snapshot = snapshot;
        const available = this.available === null ? canUseNativeMapChrome() : this.available;
        if (this.stopped || !available || !getMotionPolicy().nativeGlass) return false;
        let step = 'load';
        setStatus({ state: 'connecting', reason: '', retrying: false });
        try {
            const plugin = this.injectedPlugin || (await withTimeout(loadPlugin(), CALL_TIMEOUT_MS)).plugin;
            this.plugin = plugin;
            step = 'capabilities';
            const caps = await withTimeout(plugin.capabilities(), CALL_TIMEOUT_MS);
            if (!caps || caps.protocolVersion !== NATIVE_CHROME_PROTOCOL || !caps.supportsGlass) {
                // 设备或 App 版本不支持：不重试
                const reason = !caps ? t('platform:nativeMapChrome.noCapabilities') : caps.protocolVersion !== NATIVE_CHROME_PROTOCOL
                    ? t('platform:nativeMapChrome.protocolMismatch', { protocolVersion: caps.protocolVersion, NATIVE_CHROME_PROTOCOL })
                    : t('platform:nativeMapChrome.glassUnsupported', { systemVersion: caps.systemVersion ? t('platform:nativeMapChrome.systemVersion', { systemVersion: caps.systemVersion }) : '' });
                setStatus({ state: 'unsupported', reason });
                rememberOutcome('unsupported');
                return false;
            }
            if (this.stopped) return false;

            const sessionId = randomId('chrome');
            this.sessionId = sessionId;
            this.revision = 0;
            step = 'listen';
            await this._listen();
            step = 'attach';
            await withTimeout(plugin.attach({ sessionId, ownerId: this.ownerId }), CALL_TIMEOUT_MS);
            step = 'setState';
            await this._pushState();
            step = 'layout';
            const layout = await this._waitForLayout(this.timing.handshakeMs);
            if (!layout || this.stopped || this.sessionId !== sessionId) throw new Error(layout ? 'stale' : t('platform:nativeMapChrome.layoutTimeout'));

            this._startHeartbeat();
            this.unsubscribeOverlays = subscribeOverlays((list) => this._syncSuspension(list));
            this.unsubscribeLifecycle = onAppStateChange(({ active }) => {
                if (active) this._heartbeat();
            });
            // 网页先隐藏自己的工具栏；React 提交后由 activate() 显示原生控件
            this._setMode('native');
            setStatus({ state: 'native', reason: '', retrying: false });
            rememberOutcome('native');
            clearTimeout(this.stableTimer);
            this.stableTimer = setTimeout(() => { this.failures = 0; }, STABLE_RESET_MS);
            return true;
        } catch (error) {
            await this._teardownNative();
            this._setMode('web');
            if (!this.stopped) this._failed(describeError(step, error));
            return false;
        }
    }

    /** 网页工具栏已隐藏后调用：按当前浮层状态显示或保持收起原生控件。 */
    async activate() {
        if (this.mode !== 'native' || this.active || this.stopped) return;
        this.active = true;
        this.suspended = null;
        await this._syncSuspension(getOverlayEntries(), true);
    }

    /** 地图页被其他页面（设置、管理等）盖住：收起原生控件但保留会话，回到地图页时直接恢复。 */
    setPageHidden(hidden) {
        this.pageHidden = !!hidden;
        this._syncSuspension(getOverlayEntries());
    }

    update(snapshot) {
        this.snapshot = snapshot;
        if (!this.sessionId || this.stopped) return;
        this._pushState().catch(() => this._fallback('setState'));
    }

    async stop() {
        if (this.stopped) return;
        this.stopped = true;
        clearTimeout(this.retryTimer);
        clearTimeout(this.stableTimer);
        // 离开地图页时保留最近一次结果供设置页显示；只有握手被打断时回到“尚未连接”
        if (chromeStatus.state === 'connecting') setStatus({ state: 'idle', reason: '', retrying: false });
        this._stopHeartbeat();
        if (this.unsubscribeOverlays) this.unsubscribeOverlays();
        if (this.unsubscribeLifecycle) this.unsubscribeLifecycle();
        await this._teardownNative();
        await this._removeListeners();
        this._setMode('web');
    }

    // ---------------- 内部 ----------------

    async _listen() {
        await this._removeListeners();
        const plugin = this.plugin;
        // 监听注册失败直接让握手失败（原因显示在设置页），而不是静默等到布局超时
        const add = async (name, fn) => {
            this.listeners.push(await withTimeout(plugin.addListener(name, fn), CALL_TIMEOUT_MS));
        };
        await add('action', (event) => this._handleAction(event));
        await add('search', (event) => this._handleSearch(event));
        await add('sheet', (event) => this._handleSheet(event));
        await add('drawer', (event) => this._handleDrawer(event));
        await add('layout', (event) => this._handleLayout(event));
        await add('sessionLost', (event) => this._handleSessionLost(event));
    }

    async _removeListeners() {
        const list = this.listeners;
        this.listeners = [];
        await Promise.all(list.map((handle) => Promise.resolve(handle && handle.remove && handle.remove()).catch(() => null)));
    }

    _pushState() {
        // 串行发送，保证 revision 单调递增
        this.pushChain = this.pushChain.then(async () => {
            if (!this.sessionId || !this.plugin) return;
            const snapshot = this.snapshot || {};
            this.revision += 1;
            const result = await withTimeout(this.plugin.setState({
                sessionId: this.sessionId,
                ownerId: this.ownerId,
                revision: this.revision,
                items: sanitizeItems(snapshot.items),
                theme: snapshot.theme || {},
                floatingGap: Number.isFinite(Number(snapshot.floatingGap)) ? Number(snapshot.floatingGap) : 14,
                search: sanitizeSearch(snapshot.search),
                sheet: sanitizeSheet(snapshot.sheet),
                drawer: sanitizeDrawer(snapshot.drawer),
                skin: sanitizeSkin(snapshot.skin),
                tour: sanitizeTour(snapshot.tour),
                labels: nativeChromeLabels()
            }), CALL_TIMEOUT_MS);
            if (!result || result.appliedRevision !== this.revision) {
                if (!(result && result.ignored)) throw new Error('setState');
            }
        });
        return this.pushChain;
    }

    _waitForLayout(ms) {
        if (this.lastLayout && this.lastLayout.sessionId === this.sessionId) return Promise.resolve(this.lastLayout);
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), ms);
            this.layoutWaiters.push((layout) => { clearTimeout(timer); resolve(layout); });
        });
    }

    _handleLayout(event) {
        if (!event || event.sessionId !== this.sessionId) return;
        const slots = Array.isArray(event.slots) ? event.slots : [];
        if (!slots.some((slot) => slot.id === 'toolbar')) return;
        this.lastLayout = event;
        const waiters = this.layoutWaiters;
        this.layoutWaiters = [];
        waiters.forEach((fn) => fn(event));
        // 原生占用区域（WebView 视口 CSS 像素）供地图安全区计算；收起时不占用
        const rects = event.showing ? (event.occupiedRects || []) : [];
        if (this.mode === 'native') setNativeOccupiedRects(this.ownerId, rects);
        this.onLayout && this.onLayout(event);
    }

    async _handleAction(event) {
        if (!event || event.sessionId !== this.sessionId || event.ownerId !== this.ownerId) return;
        if (!NATIVE_CHROME_ACTIONS.includes(event.actionId)) return;
        if (this.seenEvents.includes(event.eventId)) return;
        this.seenEvents.push(event.eventId);
        if (this.seenEvents.length > 50) this.seenEvents.shift();
        let outcome = 'handled';
        try {
            if (this.onAction && this.onAction(event.actionId) === false) outcome = 'rejected';
        } catch (error) {
            outcome = 'rejected';
            console.warn('原生控件动作处理失败', error);
        }
        // 等 React 提交与浮层登记完成，再判断是否真的打开了浮层
        await nextFrames();
        // 动作切到了其他页面（地图页被盖住）也算：原生保持收起
        const overlayOpened = this.pageHidden || hasNativeSuspendingOverlay(getOverlayEntries());
        if (overlayOpened) this.suspended = true;
        try {
            await withTimeout(this.plugin.ackAction({ sessionId: this.sessionId, eventId: event.eventId, outcome, overlayOpened, revision: this.revision }), CALL_TIMEOUT_MS);
        } catch (error) {
            this._fallback('ackAction');
        }
    }

    /** 原生输入框事件：只接受当前会话、白名单类型，文本截断后交给网页的搜索逻辑。 */
    _handleSearch(event) {
        if (!event || this.mode !== 'native' || event.sessionId !== this.sessionId || event.ownerId !== this.ownerId) return;
        if (!NATIVE_SEARCH_EVENTS.includes(event.type)) return;
        const detail = { type: event.type };
        if (typeof event.text === 'string') detail.text = event.text.slice(0, NATIVE_SEARCH_TEXT_LIMIT);
        if (event.type === 'focus') detail.focused = !!event.focused;
        try {
            this.onSearch && this.onSearch(detail);
        } catch (error) {
            console.warn('原生搜索事件处理失败', error);
        }
    }

    /** 原生面板事件：只接受当前会话、白名单面板与类型；行 id 由网页查表，未知 id 被忽略。 */
    _handleSheet(event) {
        if (!event || this.mode !== 'native' || event.sessionId !== this.sessionId || event.ownerId !== this.ownerId) return;
        if (!NATIVE_SHEET_EVENTS.includes(event.type) || !NATIVE_SHEETS.includes(event.sheetId)) return;
        const detail = { type: event.type, sheetId: event.sheetId, token: toCounter(event.token) };
        if (event.type === 'select') {
            const rowId = clipText(event.rowId, 64);
            if (!rowId) return;
            detail.rowId = rowId;
        }
        try {
            this.onSheet && this.onSheet(detail);
        } catch (error) {
            console.warn('原生面板事件处理失败', error);
        }
    }

    /** 更多功能事件：只接受当前会话与白名单类型；行 id 由网页查表，未知 id 被忽略。 */
    _handleDrawer(event) {
        if (!event || this.mode !== 'native' || event.sessionId !== this.sessionId || event.ownerId !== this.ownerId) return;
        if (!NATIVE_DRAWER_EVENTS.includes(event.type)) return;
        const rowId = clipText(event.rowId, 64);
        if (!rowId) return;
        try {
            this.onDrawer && this.onDrawer({ type: event.type, rowId });
        } catch (error) {
            console.warn('原生更多功能事件处理失败', error);
        }
    }

    _handleSessionLost(event) {
        if (!event || event.sessionId !== this.sessionId) return;
        // 原生已因健康超时自行收起：立即恢复 Web，稍后重新握手
        this.sessionId = null;
        this.active = false;
        this._stopHeartbeat();
        if (this.unsubscribeOverlays) { this.unsubscribeOverlays(); this.unsubscribeOverlays = null; }
        this._setMode('web');
        this._failed(`sessionLost: ${event.reason || 'unknown'}`);
    }

    async _syncSuspension(list, force = false) {
        if (this.mode !== 'native' || !this.active || !this.sessionId) return;
        const want = this.pageHidden || hasNativeSuspendingOverlay(list);
        if (!force && want === this.suspended) return;
        this.suspended = want;
        try {
            if (want) await withTimeout(this.plugin.suspend({ sessionId: this.sessionId, reason: 'overlay' }), CALL_TIMEOUT_MS);
            else await withTimeout(this.plugin.resume({ sessionId: this.sessionId, revision: this.revision }), CALL_TIMEOUT_MS);
        } catch (error) {
            this._fallback(want ? 'suspend' : 'resume');
        }
    }

    _startHeartbeat() {
        this._stopHeartbeat();
        this.heartbeatTimer = setInterval(() => this._heartbeat(), HEARTBEAT_MS);
    }

    _stopHeartbeat() {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = 0;
    }

    _heartbeat() {
        if (!this.sessionId || !this.plugin || document.visibilityState === 'hidden') return;
        withTimeout(this.plugin.heartbeat({ sessionId: this.sessionId }), CALL_TIMEOUT_MS)
            .catch(() => this._fallback('heartbeat'));
    }

    async _teardownNative() {
        const sessionId = this.sessionId;
        this.sessionId = null;
        this.active = false;
        if (!sessionId || !this.plugin) return true;
        try {
            await withTimeout(this.plugin.dispose({ sessionId }), CALL_TIMEOUT_MS);
            return true;
        } catch (error) {
            return false;
        }
    }

    async _fallback(reason) {
        if (this.mode !== 'native' || this.fallingBack) return;
        this.fallingBack = true;
        console.warn('原生地图控件失效，恢复网页工具栏', reason);
        this._stopHeartbeat();
        if (this.unsubscribeOverlays) { this.unsubscribeOverlays(); this.unsubscribeOverlays = null; }
        const confirmed = await this._teardownNative();
        // 没有拿到“已隐藏”回执：停止心跳后原生会在健康超时内自行收起，等它确定隐藏后再恢复 Web
        if (!confirmed) await delay(this.timing.selfHideMs);
        this.fallingBack = false;
        this._setMode('web');
        this._failed(reason);
    }

    /** 记录失败并按退避重试（3s、6s、12s…，连续失败超过上限后停止，回到地图页会重新开始） */
    _failed(reason) {
        clearTimeout(this.stableTimer);
        this.failures += 1;
        const retrying = !this.stopped && this.failures <= MAX_RETRIES;
        setStatus({ state: 'web', reason, retrying });
        if (!retrying) return;
        clearTimeout(this.retryTimer);
        const wait = this.timing.retryMs * 2 ** Math.min(this.failures - 1, 4);
        this.retryTimer = setTimeout(() => {
            if (!this.stopped && this.mode === 'web') this.start(this.snapshot);
        }, wait);
    }
}
