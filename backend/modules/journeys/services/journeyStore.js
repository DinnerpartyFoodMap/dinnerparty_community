const { randomUUID } = require('crypto');
const { db } = require('../../../infrastructure/database');
const sql = db._raw;
const now = () => new Date().toISOString();
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function string(value, max = 2000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function coordinate(value, bound) {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    if (!Number.isFinite(n) || Math.abs(n) > bound) fail('坐标超出范围');
    return n;
}
function date(value) {
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) fail('日期无效');
    return value;
}
function ownedMedia(userId, ids, max = 12, message = '每次最多 12 张图片') {
    if (!Array.isArray(ids) || ids.length > max) fail(message);
    return [...new Set(ids)].map(id => {
        const row = sql.prepare('SELECT id FROM JourneyMedia WHERE id = ? AND user_id = ?').get(String(id), userId);
        if (!row) fail('图片不存在或无权使用', 404);
        return row.id;
    });
}
const MAX_ENTRY_MEDIA = 60, MEDIA_KINDS = ['dish', 'menu', 'other'], CENTER_SOURCES = ['current', 'search', 'map', 'place', 'manual'];
// The search center is private context for finding shops. It is never a visited stop.
function normalizeCenter(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const lng = Number(value.lng), lat = Number(value.lat);
    if (value.lng === null || value.lat === null || !Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) return null;
    return { name: string(value.name, 120), city: string(value.city, 50), lng, lat, source: CENTER_SOURCES.includes(value.source) ? value.source : 'manual' };
}
// Offsets index the untrimmed original text, so the source text is never trimmed.
function normalizeSourceInput(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const text = typeof value.text === 'string' ? value.text.slice(0, 24000) : '';
    const valid = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : '';
    return { text, start_date: valid(value.start_date), end_date: valid(value.end_date), center: normalizeCenter(value.center) };
}
// A quote is kept only while it still matches the original text at the same offsets.
function normalizeSpans(spans, text) {
    if (!Array.isArray(spans) || !text) return [];
    return spans.slice(0, 12).flatMap(span => {
        const start = Number(span?.start), end = Number(span?.end);
        if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > text.length || end - start > 2000) return [];
        const quote = text.slice(start, end);
        if (typeof span.text === 'string' && span.text !== quote) return [];
        return [{ start, end, text: quote }];
    }).sort((a, b) => a.start - b.start);
}
function normalizeMediaMeta(value, ids) {
    const meta = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return meta;
    for (const id of ids) {
        const item = value[id];
        if (!item || typeof item !== 'object') continue;
        const entry = {};
        if (MEDIA_KINDS.includes(item.kind)) entry.kind = item.kind;
        if (item.kind_source === 'user' || item.kind_source === 'ai') entry.kind_source = item.kind_source;
        const caption = string(item.caption, 200);
        if (caption) entry.caption = caption;
        if (Object.keys(entry).length) meta[id] = entry;
    }
    return meta;
}
function mediaReferences(document) {
    if (!document || typeof document !== 'object') return [];
    const stops = Array.isArray(document.stops) ? document.stops : [];
    return [...new Set([...(Array.isArray(document.entry_media_ids) ? document.entry_media_ids : []), ...stops.flatMap(s => Array.isArray(s?.media_ids) ? s.media_ids : [])])];
}
function normalizeDocument(input, userId) {
    if (!input || !Array.isArray(input.stops) || input.stops.length > 60) fail('行程最多包含 60 个途经点');
    const start_date = date(input.start_date), end_date = date(input.end_date || start_date);
    if (end_date < start_date) fail('结束日期不能早于开始日期');
    const source_input = normalizeSourceInput(input.source_input);
    const ids = new Set();
    const stops = input.stops.map(s => {
        if (!s || typeof s !== 'object' || Array.isArray(s)) fail('途经点格式无效');
        const id = /^[a-zA-Z0-9_-]{8,80}$/.test(s.id || '') ? s.id : randomUUID();
        if (ids.has(id)) fail('途经点 ID 重复');
        ids.add(id);
        const lng = coordinate(s.lng, 180), lat = coordinate(s.lat, 90);
        if ((lng === null) !== (lat === null)) fail('请同时填写经纬度');
        if (Array.isArray(s.expenses) && s.expenses.length > 30) fail('每站最多 30 笔支出');
        const expenses = (Array.isArray(s.expenses) ? s.expenses : []).map(e => {
            if (!e || typeof e !== 'object' || e.amount === '') fail('金额无效');
            const amount = Number(e.amount);
            if (!Number.isFinite(amount) || amount < 0 || amount > 1000000) fail('金额无效');
            return { id: string(e.id, 80) || randomUUID(), amount: Math.round(amount * 100) / 100, currency: 'CNY', note: string(e.note, 100) };
        });
        const at = string(s.at, 30);
        // A stop may know only its day (YYYY-MM-DD) or the day and time; an unknown date stays empty instead of becoming the first day.
        if (at && (!/^\d{4}-\d{2}-\d{2}(T([01]\d|2[0-3]):[0-5]\d)?$/.test(at) || !Number.isFinite(Date.parse(at)) || at.slice(0, 10) < start_date || at.slice(0, 10) > end_date)) fail('途经点时间须在行程日期内');
        if (at) date(at.slice(0,10));
        const candidates = (Array.isArray(s.candidates) ? s.candidates : []).slice(0, 5).filter(c=>c && ['local','amap'].includes(c.source)).map(c=> {
            if(c.source === 'amap' && process.env.AMAP_JOURNAL_STORAGE_ALLOWED !== 'true') return null;
            if(c.source === 'local') {
                const p=Number.isSafeInteger(c.place_id) ? sql.prepare('SELECT id,name,longitude,latitude FROM Place WHERE id=?').get(c.place_id) : null;
                return p ? {id:`local_${p.id}`,place_id:p.id,name:p.name,lng:p.longitude,lat:p.latitude,source:'local',address:'',suggested:c.suggested===true,score:Number.isFinite(c.score)?Math.max(-3,Math.min(3,c.score)):1} : null;
            }
            return {id:string(c.id,100),place_id:null,name:string(c.name,160),lng:coordinate(c.lng,180),lat:coordinate(c.lat,90),source:'amap',address:string(c.address,250),suggested:c.suggested===true,score:Number.isFinite(c.score)?Math.max(-3,Math.min(3,c.score)):1};
        }).filter(c=>c && c.lng!==null && c.lat!==null);
        const stop = { id, name: string(s.name, 160) || '未命名地点', note: string(s.note, 4000), at, candidates,
            mood: string(s.mood, 16), lng, lat, address: string(s.address, 250),
            place_id: Number.isSafeInteger(s.place_id) && sql.prepare('SELECT id FROM Place WHERE id = ?').get(s.place_id) ? s.place_id : null,
            source: ['local', 'manual', 'amap'].includes(s.source) ? s.source : 'manual',
            confirmed: s.confirmed === true, visit_status: ['visited', 'planned', 'unknown'].includes(s.visit_status) ? s.visit_status : 'unknown',
            location_resolution:s.location_resolution==='deferred'?'deferred':'pending',clarification_text:string(s.clarification_text,1000),clarification_city:string(s.clarification_city,50),
            evidence: string(s.evidence, 800), media_ids: ownedMedia(userId, s.media_ids || []), expenses,
            excerpts: normalizeSpans(s.excerpts, source_input?.text), excerpt_edited: string(s.excerpt_edited, 2000),
            dishes: (Array.isArray(s.dishes) ? s.dishes : []).map(d => string(d, 40)).filter(Boolean).slice(0, 10),
            external_id: /^amap_[A-Za-z0-9_-]{1,100}$/.test(s.external_id || '') ? s.external_id : '',
            category: string(s.category, 60).replace(/<[^>]*>/g, ''),
            duplicate_ack: (Array.isArray(s.duplicate_ack) ? s.duplicate_ack : []).filter(Number.isSafeInteger).slice(0, 20),
            candidate_basis: ['broad', 'named', 'clue'].includes(s.candidate_basis) ? s.candidate_basis : 'named' };
        // Only explicit author choices are stored; absence means the default for the stop's visit status.
        if (typeof s.public === 'boolean') stop.public = s.public;
        if (typeof s.map_link === 'boolean') stop.map_link = s.map_link;
        // 'model': the time was filled in by the model and not yet checked by the author (journeyAI.reconstruct).
        if (s.at_source === 'model' && at) stop.at_source = 'model';
        return stop;
    });
    if (stops.some(s => s.source === 'amap') && process.env.AMAP_JOURNAL_STORAGE_ALLOWED !== 'true') fail('尚未配置高德数据存储授权，请使用站内地点或手动标记');
    const document = { title: string(input.title, 120) || '我的行程', start_date, end_date,
        summary: string(input.summary, 5000), stops,
        sources: (Array.isArray(input.sources) ? input.sources : []).slice(0, 20).map(s => ({ id: string(s.id, 80), revision: Number(s.revision) || 1 })) };
    // Every photo of the entry is kept in order; stops only reference a subset.
    document.entry_media_ids = ownedMedia(userId, mediaReferences({ entry_media_ids: input.entry_media_ids, stops }), MAX_ENTRY_MEDIA, `每篇日记最多 ${MAX_ENTRY_MEDIA} 张图片`);
    document.media_meta = normalizeMediaMeta(input.media_meta, document.entry_media_ids);
    // Whole-entry public text and photos are explicit author choices; the private original input is never copied in automatically.
    document.public_text = string(input.public_text, 5000);
    document.public_media_ids = (Array.isArray(input.public_media_ids) ? [...new Set(input.public_media_ids)] : []).filter(id => document.entry_media_ids.includes(id)).slice(0, MAX_ENTRY_MEDIA);
    // Set when the model organised this entry (journeyAI.reconstruct): its title and summary may be model-written,
    // so the review page and the public diary label it as AI-assisted. Kept through edits, restores and merges.
    if (input.ai_assisted === true) document.ai_assisted = true;
    if (source_input) document.source_input = source_input;
    if (Buffer.byteLength(JSON.stringify(document)) > 200000) fail('行程内容过大');
    return document;
}
function getJourney(userId, id) {
    const row = sql.prepare('SELECT * FROM Journey WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) fail('日记不存在', 404);
    return { id: row.id, revision: row.revision, document: JSON.parse(row.document), created_at: row.created_at, updated_at: row.updated_at };
}
function saveJourney(userId, input, id = null, baseRevision = null) {
    const document = normalizeDocument(input, userId);
    return sql.transaction(() => {
        let revision = 1, previousDocument = null;
        if (id) {
            const previous = getJourney(userId, id);
            if (baseRevision !== previous.revision) fail('日记已在其他窗口修改，请重新载入后再保存', 409);
            revision = previous.revision + 1;
            previousDocument = previous.document;
            // Provenance is server-owned. Editing cannot invent merge ancestry.
            document.sources = previous.document.sources;
        } else {
            if (sql.prepare('SELECT COUNT(*) AS n FROM Journey WHERE user_id=?').get(userId).n >= 500) fail('最多保存 500 篇日记，请先整理归档',413);
            id = randomUUID(); document.sources = [];
        }
        const encoded = JSON.stringify(document), time = now();
        if (revision === 1) sql.prepare('INSERT INTO Journey(id,user_id,document,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,userId,encoded,time,time);
        else sql.prepare('UPDATE Journey SET document=?,revision=?,updated_at=? WHERE id=?').run(encoded,revision,time,id);
        sql.prepare('INSERT INTO JourneyRevision VALUES(?,?,?,?)').run(id,revision,encoded,time);
        require('./journeyCorrections').recordSavedChanges(sql,id,revision,previousDocument,document,input,time);
        return getJourney(userId,id);
    })();
}
function mergeJourneys(...args) { return require('./journeyMerge').mergeJourneys(...args); }
module.exports = { sql, now, fail, string, date, coordinate, ownedMedia, normalizeCenter, normalizeSourceInput, normalizeSpans, normalizeMediaMeta, mediaReferences, MAX_ENTRY_MEDIA, MEDIA_KINDS, normalizeDocument, getJourney, saveJourney, mergeJourneys };
