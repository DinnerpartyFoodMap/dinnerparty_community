import { pickContrastTextColor } from "../theme/theme";
import { markdownToPlainText } from '../components/markdown/markdownText.js';
import { t } from '../i18n/index.js';

// 分享图片：围绕作者自己的照片排版（1080×1440，3:4）。三类场景：
//   一家店、一顿饭 → 照片封面 + 店名 + 一句感受（single）
//   多家店、一日行程 → 照片封面 + 逐站图文卡 + 可选路线总览（multi）
//   没有明确地点 → 照片拼图（collage）或文字卡（text）
// planPages 只决定有哪些页（作者可重排、删除、换照片、调裁切）；renderPages 画图，文字放不下时续页并给出提示，不静默截断。
export const PAGE_W = 1080, PAGE_H = 1440;
export const COVER_STYLES = ['主站', '奶油', '薄荷', '夜色'];
export const TEMPLATES = ['auto', 'single', 'multi', 'collage', 'text'];
const themes = { 奶油: { bg: '#fff8eb', ink: '#473d31', line: '#c36b43' }, 薄荷: { bg: '#e9f7ef', ink: '#224f43', line: '#32836d' }, 夜色: { bg: '#182a3b', ink: '#edf3fa', line: '#f3bd66' } };
const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC",sans-serif';
const MARGIN = 72;
const located = (s) => Number.isFinite(s?.lng) && Number.isFinite(s?.lat);
const plain = (text) => markdownToPlainText(text || '').trim();

function themeOf(style) {
    if (style !== '主站') return themes[style] || themes.奶油;
    const root = getComputedStyle(document.documentElement);
    return { bg: root.getPropertyValue('--color-bg-base').trim() || '#F9F8FA', ink: root.getPropertyValue('--color-text-primary').trim() || '#2B2533', line: root.getPropertyValue('--theme-primary').trim() || '#E2789F' };
}
export function resolveTemplate(cover, template = 'auto') {
    const stops = cover.stops || [], photos = stops.some((s) => s.media_ids?.length);
    const wanted = template === 'auto' ? (stops.length === 1 ? 'single' : photos && stops.some(located) ? 'multi' : photos ? 'collage' : 'text') : template;
    // 没有照片时，照片类模板退回文字卡
    return ['single', 'multi', 'collage'].includes(wanted) && !photos ? 'text' : wanted;
}
/** 封面的默认“一句话”：单店用这一站文字的第一句（仅当作者选择分享文字时才有），多站写站数。 */
export function defaultCaption(cover, template) {
    const stops = cover.stops || [];
    if (resolveTemplate(cover, template) === 'single') return Array.from(plain(stops[0]?.text).split(/(?<=[。！？!?\n])/)[0] || '').slice(0, 60).join('').trim();
    return cover.caption || '';
}
/** 照片可选范围：只有所选站点自己的照片。 */
export function photoChoices(cover) { return [...new Set((cover.stops || []).flatMap((s) => s.media_ids || []))]; }

/**
 * @param {object} cover 分享接口返回的 cover（title、日期、所选站点及其照片与可分享文字）
 * @param {{template, coverPhoto, mainPhoto, route, order, removed}} design
 * @returns {{key, kind, label, photo?, photos?, stop?, index?}[]}
 */
export function planPages(cover, design = {}) {
    const stops = cover.stops || [], template = resolveTemplate(cover, design.template);
    const all = photoChoices(cover), pick = (id, list) => (id && list.includes(id) ? id : list[0] || null);
    const mainOf = (s) => pick(design.mainPhoto?.[s.id], s.media_ids || []);
    let pages;
    if (template === 'single') {
        const stop = stops[0];
        pages = [{ key: 'cover', kind: 'cover', single: true, photo: pick(design.coverPhoto, stop.media_ids?.length ? stop.media_ids : all), stop, index: 0 }];
    } else if (template === 'multi') {
        pages = [{ key: 'cover', kind: 'cover', photo: pick(design.coverPhoto, all) },
            ...stops.map((stop, index) => ({ key: `stop:${stop.id}`, kind: 'stop', stop, index, photo: mainOf(stop) }))];
        if (design.route !== false && stops.some(located)) pages.push({ key: 'route', kind: 'route' });
    } else if (template === 'collage') {
        const first = pick(design.coverPhoto, all);
        pages = [{ key: 'collage', kind: 'collage', photos: [first, ...all.filter((id) => id !== first)].slice(0, 9) }];
    } else pages = [{ key: 'text', kind: 'text' }];
    const order = (design.order || []).filter((key) => pages.some((p) => p.key === key));
    const rank = (p) => { const i = order.indexOf(p.key); return i < 0 ? order.length + pages.indexOf(p) : i; };
    const removed = new Set(design.removed || []);
    return pages.filter((p) => !removed.has(p.key)).sort((a, b) => rank(a) - rank(b)).map((p) => ({ ...p, label: pageLabel(p) }));
}
export function pageLabel(page) {
    if (page.kind === 'cover') return t('journey:cover.page.cover');
    if (page.kind === 'stop') return t('journey:cover.page.stop', { index: page.index + 1, name: page.stop.name });
    if (page.kind === 'route') return t('journey:cover.page.route');
    if (page.kind === 'collage') return t('journey:cover.page.collage');
    return t('journey:cover.page.text');
}
/** 所有页面（含可能的续页）会用到的照片。 */
export function pagePhotos(pages) {
    return [...new Set(pages.flatMap((p) => p.kind === 'collage' ? p.photos : p.kind === 'stop' ? (p.stop.media_ids || []).slice(0, 4) : p.photo ? [p.photo] : []))].filter(Boolean);
}

// ---- 文字排版：按宽度折行，最多 maxLines 行，返回放不下的剩余文字 ----
function layout(ctx, text, width, maxLines) {
    const chars = Array.from(String(text || '').replace(/\r\n?/g, '\n').trim());
    const lines = []; let line = '';
    for (let i = 0; i < chars.length; i++) {
        const ch = chars[i];
        const overflow = ch === '\n' || (line && ctx.measureText(line + ch).width > width);
        if (overflow) {
            lines.push(line); line = '';
            if (lines.length >= maxLines) return { lines, rest: chars.slice(ch === '\n' ? i + 1 : i).join('').trim() };
            if (ch === '\n') continue;
        }
        line += ch;
    }
    if (line) lines.push(line);
    return { lines, rest: '' };
}
// 标题这类不分页的文字：放不下时最后一行以省略号结尾，并报告
function fitLines(ctx, text, width, maxLines) {
    const { lines, rest } = layout(ctx, text, width, maxLines);
    if (!rest) return { lines, cut: false };
    let last = lines[lines.length - 1];
    while (last && ctx.measureText(`${last}…`).width > width) last = Array.from(last).slice(0, -1).join('');
    lines[lines.length - 1] = `${last}…`;
    return { lines, cut: true };
}
function drawLines(ctx, lines, x, y, lineHeight) { lines.forEach((l, i) => ctx.fillText(l, x, y + i * lineHeight)); return y + lines.length * lineHeight; }
function font(ctx, size, weight = '') { ctx.font = `${weight ? `${weight} ` : ''}${size}px ${FONT}`; }

// 按裁切位置（0–100，沿超出的方向）把照片铺满区域
function drawPhoto(ctx, image, x, y, w, h, focus = 50) {
    const iw = image.width, ih = image.height, scale = Math.max(w / iw, h / ih);
    const sw = w / scale, sh = h / scale, f = Math.min(100, Math.max(0, Number(focus) || 0)) / 100;
    const sx = iw / ih > w / h ? (iw - sw) * f : (iw - sw) / 2, sy = iw / ih > w / h ? (ih - sh) / 2 : (ih - sh) * f;
    ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
function newCanvas(theme) {
    const canvas = document.createElement('canvas'); canvas.width = PAGE_W; canvas.height = PAGE_H;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = theme.bg; ctx.fillRect(0, 0, PAGE_W, PAGE_H); ctx.textBaseline = 'alphabetic';
    return { canvas, ctx };
}
function shade(ctx, from, to) {
    const g = ctx.createLinearGradient(0, from, 0, to); g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.74)');
    ctx.fillStyle = g; ctx.fillRect(0, from, PAGE_W, to - from);
}
function stopTime(at) { return !at ? '' : at.length > 10 ? at.replace('T', ' ') : at; }

function renderCover(page, info, theme, image, warn) {
    const { canvas, ctx } = newCanvas(theme);
    const title = page.single ? page.stop.name : info.title;
    const meta = page.single ? [info.range, stopTime(page.stop.at).slice(11)].filter(Boolean).join(' · ') : t('journey:cover.meta', { range: info.range, count: info.count });
    const width = PAGE_W - MARGIN * 2;
    font(ctx, 38); const caption = layout(ctx, info.caption, width, 3);
    if (caption.rest) warn(t('journey:cover.warn.caption'));
    font(ctx, 72, 'bold'); const head = fitLines(ctx, title, width, 2);
    if (head.cut) warn(t('journey:cover.warn.title'));
    const block = head.lines.length * 86 + 54 + caption.lines.length * 54;
    let y = PAGE_H - 96 - block;
    if (image) { drawPhoto(ctx, image, 0, 0, PAGE_W, PAGE_H, info.focus(page.photo)); shade(ctx, Math.max(0, y - 260), PAGE_H); ctx.fillStyle = '#fff'; }
    else { ctx.fillStyle = theme.line; ctx.fillRect(MARGIN, y - 72, 120, 12); ctx.fillStyle = theme.ink; }
    font(ctx, 72, 'bold'); y = drawLines(ctx, head.lines, MARGIN, y + 64, 86) - 64;
    font(ctx, 30); ctx.globalAlpha = 0.88; ctx.fillText(meta, MARGIN, y + 54); ctx.globalAlpha = 1; y += 54;
    font(ctx, 38); drawLines(ctx, caption.lines, MARGIN, y + 58, 54);
    return canvas;
}
// 一站一张：主图在上，下方店名、时间与这一站的文字；文字放不下时返回剩余部分，由续页接着排
function renderStop(page, info, theme, images, warn, text, continued) {
    const { canvas, ctx } = newCanvas(theme);
    const width = PAGE_W - MARGIN * 2, main = !continued && images.get(page.photo);
    let y = 96;
    if (main) {
        drawPhoto(ctx, main, 0, 0, PAGE_W, 860, info.focus(page.photo));
        const extra = (page.stop.media_ids || []).filter((id) => id !== page.photo).map((id) => images.get(id)).filter(Boolean).slice(0, 3);
        extra.forEach((img, i) => { const x = PAGE_W - MARGIN - (extra.length - i) * 172 + 12, size = 160; ctx.save(); roundRect(ctx, x, 860 - size - 28, size, size, 18); ctx.clip(); drawPhoto(ctx, img, x, 860 - size - 28, size, size); ctx.restore(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 5; roundRect(ctx, x, 860 - size - 28, size, size, 18); ctx.stroke(); });
        y = 860;
    } else if (!continued && page.photo) warn(t('journey:cover.warn.photo'));
    ctx.fillStyle = theme.line; ctx.beginPath(); ctx.arc(MARGIN + 34, y + (main ? 0 : 34), 34, 0, 2 * Math.PI); ctx.fill();
    ctx.fillStyle = pickContrastTextColor(theme.line); font(ctx, 32, 'bold'); ctx.textAlign = 'center'; ctx.fillText(String(page.index + 1), MARGIN + 34, y + (main ? 11 : 45)); ctx.textAlign = 'left';
    y += main ? 96 : 140;
    ctx.fillStyle = theme.ink; font(ctx, 56, 'bold');
    const name = fitLines(ctx, continued ? t('journey:cover.continued', { name: page.stop.name }) : page.stop.name, width, 2);
    if (name.cut && !continued) warn(t('journey:cover.warn.title'));
    y = drawLines(ctx, name.lines, MARGIN, y, 68);
    const when = stopTime(page.stop.at);
    if (when && !continued) { font(ctx, 30); ctx.globalAlpha = 0.7; ctx.fillText(when, MARGIN, y + 8); ctx.globalAlpha = 1; y += 52; }
    font(ctx, 36);
    const lines = Math.max(1, Math.floor((PAGE_H - 88 - y) / 54));
    const body = layout(ctx, text, width, lines);
    drawLines(ctx, body.lines, MARGIN, y + 40, 54);
    return { canvas, rest: body.rest };
}
// 相同或很近的坐标：编号沿小圆错开，并连回真实位置，避免互相盖住
function spread(points, minGap = 56) {
    const out = points.map((p) => ({ ...p, x: p.px, y: p.py })), seen = new Set();
    out.forEach((p, i) => {
        if (seen.has(i)) return;
        const group = out.map((q, j) => (Math.hypot(q.px - p.px, q.py - p.py) < minGap ? j : -1)).filter((j) => j >= 0);
        group.forEach((j) => seen.add(j));
        if (group.length < 2) return;
        const cx = group.reduce((n, j) => n + out[j].px, 0) / group.length, cy = group.reduce((n, j) => n + out[j].py, 0) / group.length;
        const r = Math.max(46, (minGap * group.length) / (2 * Math.PI));
        group.forEach((j, k) => { const a = -Math.PI / 2 + (2 * Math.PI * k) / group.length; out[j].x = cx + r * Math.cos(a); out[j].y = cy + r * Math.sin(a); out[j].spread = true; });
    });
    return out;
}
function renderRoute(info, theme, mapImage, warn, listStart = 0) {
    const { canvas, ctx } = newCanvas(theme);
    const width = PAGE_W - MARGIN * 2, stops = info.stops;
    ctx.fillStyle = theme.ink; font(ctx, 56, 'bold');
    const head = fitLines(ctx, listStart ? t('journey:cover.routeContinued') : info.title, width, 1);
    ctx.fillText(head.lines[0] || '', MARGIN, 140);
    let y = 200;
    if (!listStart) {
        const box = { x: MARGIN - 12, y: 200, w: width + 24, h: 700 };
        ctx.save(); roundRect(ctx, box.x, box.y, box.w, box.h, 28); ctx.clip();
        ctx.fillStyle = 'rgba(127,127,127,0.08)'; ctx.fillRect(box.x, box.y, box.w, box.h);
        if (mapImage) drawPhoto(ctx, mapImage, box.x, box.y, box.w, box.h);
        else {
            // 纬度修正后的经纬度示意，不是底图
            const valid = stops.map((s, i) => ({ s, i })).filter(({ s }) => located(s));
            const meanLat = valid.reduce((n, { s }) => n + s.lat, 0) / Math.max(1, valid.length), k = Math.cos((meanLat * Math.PI) / 180);
            const xs = valid.map(({ s }) => s.lng * k), ys = valid.map(({ s }) => s.lat);
            const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys), span = Math.max(maxX - minX, maxY - minY, 0.001);
            const points = spread(valid.map(({ s, i }) => ({ i, px: box.x + box.w / 2 + ((s.lng * k - (minX + maxX) / 2) / span) * (box.w - 200), py: box.y + box.h / 2 - ((s.lat - (minY + maxY) / 2) / span) * (box.h - 200) })));
            ctx.strokeStyle = theme.line; ctx.lineWidth = 8; ctx.setLineDash([14, 12]);
            for (let n = 1; n < points.length; n++) { ctx.beginPath(); ctx.moveTo(points[n - 1].px, points[n - 1].py); ctx.lineTo(points[n].px, points[n].py); ctx.stroke(); }
            ctx.setLineDash([]); ctx.lineWidth = 3;
            points.forEach((p) => {
                if (p.spread) { ctx.beginPath(); ctx.moveTo(p.px, p.py); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.fillStyle = theme.line; ctx.beginPath(); ctx.arc(p.px, p.py, 7, 0, 2 * Math.PI); ctx.fill(); }
                ctx.fillStyle = theme.line; ctx.beginPath(); ctx.arc(p.x, p.y, 27, 0, 2 * Math.PI); ctx.fill();
                ctx.fillStyle = pickContrastTextColor(theme.line); font(ctx, 26, 'bold'); ctx.textAlign = 'center'; ctx.fillText(String(p.i + 1), p.x, p.y + 9); ctx.textAlign = 'left';
            });
            if (points.some((p) => p.spread)) warn(t('journey:cover.warn.overlap'));
        }
        ctx.restore();
        ctx.fillStyle = theme.ink; font(ctx, 24); ctx.globalAlpha = 0.7; ctx.fillText(t('journey:cover.mapNote'), MARGIN, 940); ctx.globalAlpha = 1;
        y = 1000;
    }
    // 站点列表逐行排，放不下的留到续页
    font(ctx, 34); ctx.fillStyle = theme.ink;
    let i = listStart;
    for (; i < stops.length; i++) {
        if (y + 52 > PAGE_H - 72) break;
        const line = fitLines(ctx, `${i + 1}. ${stops[i].name}${located(stops[i]) ? '' : t('journey:cover.unlocated')}`, width, 1);
        ctx.fillText(line.lines[0], MARGIN, y + 34); y += 56;
    }
    return { canvas, next: i < stops.length ? i : null };
}
function renderCollage(page, info, theme, images, warn) {
    const { canvas, ctx } = newCanvas(theme);
    const list = page.photos.map((id) => ({ id, image: images.get(id) })).filter((p) => p.image);
    if (list.length < page.photos.length) warn(t('journey:cover.warn.photo'));
    const cols = list.length <= 1 ? 1 : list.length <= 4 ? 2 : 3, rows = Math.max(1, Math.ceil(list.length / cols)), gap = 8, area = 1090;
    const cw = (PAGE_W - gap * (cols - 1)) / cols, ch = (area - gap * (rows - 1)) / rows;
    list.forEach((p, i) => drawPhoto(ctx, p.image, (i % cols) * (cw + gap), Math.floor(i / cols) * (ch + gap), cw, ch, info.focus(p.id)));
    const width = PAGE_W - MARGIN * 2;
    ctx.fillStyle = theme.ink; font(ctx, 60, 'bold');
    const head = fitLines(ctx, info.title, width, 1); if (head.cut) warn(t('journey:cover.warn.title'));
    ctx.fillText(head.lines[0] || '', MARGIN, area + 104);
    font(ctx, 34); const caption = layout(ctx, info.caption || info.range, width, 2);
    if (caption.rest) warn(t('journey:cover.warn.caption'));
    drawLines(ctx, caption.lines, MARGIN, area + 170, 50);
    return canvas;
}
// 文字卡：标题、日期、一句话，然后逐站“编号 店名 + 文字”；排不下的段落接到下一张
function renderText(info, theme, warn, blocks, continued) {
    const { canvas, ctx } = newCanvas(theme);
    const width = PAGE_W - MARGIN * 2;
    let y = 150;
    ctx.fillStyle = theme.line; ctx.fillRect(MARGIN, 70, 120, 12);
    ctx.fillStyle = theme.ink; font(ctx, 64, 'bold');
    const head = fitLines(ctx, continued ? t('journey:cover.textContinued', { title: info.title }) : info.title, width, 2);
    if (head.cut && !continued) warn(t('journey:cover.warn.title'));
    y = drawLines(ctx, head.lines, MARGIN, y, 78);
    if (!continued) {
        font(ctx, 30); ctx.globalAlpha = 0.75; ctx.fillText(t('journey:cover.meta', { range: info.range, count: info.count }), MARGIN, y + 8); ctx.globalAlpha = 1; y += 60;
        if (info.caption) { font(ctx, 38); const c = layout(ctx, info.caption, width, 3); if (c.rest) warn(t('journey:cover.warn.caption')); y = drawLines(ctx, c.lines, MARGIN, y + 30, 54) + 20; }
    }
    y += 30;
    const rest = [...blocks];
    while (rest.length) {
        const block = rest[0];
        font(ctx, block.bold ? 40 : 34, block.bold ? 'bold' : '');
        const lineHeight = block.bold ? 58 : 52, room = Math.floor((PAGE_H - 80 - y) / lineHeight);
        if (room < (block.bold ? 2 : 1)) break;
        const part = layout(ctx, block.text, width, room);
        y = drawLines(ctx, part.lines, MARGIN, y + lineHeight - 14, lineHeight) - lineHeight + 14 + (block.bold ? 6 : 24);
        if (part.rest) { rest[0] = { ...block, text: part.rest }; break; }
        rest.shift();
    }
    return { canvas, rest };
}
const toBlob = (canvas) => new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t('journey:cover.renderFailed')))), 'image/png'));

/**
 * 画出所有页面。续页紧跟在原页之后（key 为 原 key~n，parent 指向原页），随原页一起移动或删除。
 * @param {object[]} pages planPages 的结果
 * @param {{cover, style, caption, focus, images: Map<string, CanvasImageSource|null>, mapImage?: CanvasImageSource|null}} input
 * @returns {Promise<{key, parent, label, blob, warnings: string[]}[]>}
 */
export async function renderPages(pages, input) {
    const { cover } = input, theme = themeOf(input.style);
    const stops = cover.stops || [];
    const info = { title: cover.title, caption: input.caption ?? '', count: stops.length, stops,
        range: input.range ?? (cover.start_date && cover.end_date && cover.end_date !== cover.start_date ? `${cover.start_date} – ${cover.end_date}` : cover.start_date || ''),
        focus: (id) => input.focus?.[id] ?? 50 };
    const out = [];
    const push = async (page, canvas, warnings, n = 0) => out.push({ key: n ? `${page.key}~${n}` : page.key, parent: page.key, label: n ? t('journey:cover.page.more', { label: page.label }) : page.label, blob: await toBlob(canvas), warnings });
    for (const page of pages) {
        const warnings = [], warn = (w) => { if (!warnings.includes(w)) warnings.push(w); };
        if (page.kind === 'cover') {
            const image = page.photo ? input.images.get(page.photo) : null;
            if (page.photo && !image) warn(t('journey:cover.warn.photo'));
            await push(page, renderCover(page, info, theme, image, warn), warnings);
        } else if (page.kind === 'stop') {
            let text = plain(page.stop.text), n = 0, first = true;
            do {
                const { canvas, rest } = renderStop(page, info, theme, input.images, first ? warn : () => {}, text, !first);
                if (rest && first) warn(t('journey:cover.warn.paged'));
                await push(page, canvas, first ? warnings : [], n);
                text = rest; first = false; n++;
            } while (text && n < 6);
            if (text) warnings.push(t('journey:cover.warn.tooLong'));
        } else if (page.kind === 'route') {
            let start = 0, n = 0;
            do {
                const { canvas, next } = renderRoute(info, theme, n ? null : input.mapImage, warn, start);
                if (next !== null && !n) warn(t('journey:cover.warn.paged'));
                await push(page, canvas, n ? [] : warnings, n);
                start = next; n++;
            } while (start !== null && n < 6);
        } else if (page.kind === 'collage') {
            await push(page, renderCollage(page, info, theme, input.images, warn), warnings);
        } else {
            let blocks = stops.flatMap((s, i) => [{ bold: true, text: `${i + 1}. ${s.name}${stopTime(s.at) ? ` · ${stopTime(s.at)}` : ''}` }, ...(plain(s.text) ? [{ text: plain(s.text) }] : [])]), n = 0;
            do {
                const { canvas, rest } = renderText(info, theme, n ? () => {} : warn, blocks, n > 0);
                if (rest.length && !n) warn(t('journey:cover.warn.paged'));
                await push(page, canvas, n ? [] : warnings, n);
                blocks = rest; n++;
            } while (blocks.length && n < 8);
            if (blocks.length) warnings.push(t('journey:cover.warn.tooLong'));
        }
    }
    return out;
}
