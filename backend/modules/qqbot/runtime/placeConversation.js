const { randomUUID, randomInt } = require('crypto');
const { db } = require('../../../infrastructure/database');
const botConfig = require('./config');
const placeService = require('../../places/services/placeService');
const { findDuplicates } = require('../../journeys/services/journeyMapLinks');
const { resolveQQUser, resolveQQUserForWrite, identityMessage } = require('./qqIdentity');
const { saveUserLocation } = require('../../accounts/services/userLocation');

// Add-place drafts, one per conversation (bot + chat type + chat + sender).
// Every step is persisted, so a restart resumes where the user left off.
const sql = db._raw;
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000;
const PAUSE_AFTER_MS = 30 * 60 * 1000;
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const MAX_TRACKED_BOT_MESSAGES = 6;
// After `!定位` without a draft, the next location card (also in a group) is the sender's own position.
const PERSONAL_LOCATE_TTL_MS = 5 * 60 * 1000;
const pendingPersonalLocate = new Map();

const STEP_LABELS = { location: '等待定位', name: '等待店名', description: '等待描述', ready: '可补充人均/标签后提交' };
const GROUP_REPLY_HINT = '（群内请回复本条消息或 @我 发送）';

const iso = (date) => date.toISOString();
const later = (date, ms) => new Date(date.getTime() + ms);

function conversationKey(ctx) {
    return [ctx.botId, ctx.chatType, ctx.chatId, ctx.senderQq].join(':');
}

function parseJson(value, fallback) {
    try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function toDraft(row) {
    if (!row) return null;
    return {
        ...row,
        fields: parseJson(row.fields, {}),
        bot_message_ids: parseJson(row.bot_message_ids, []),
        preview_duplicates: parseJson(row.preview_duplicates, [])
    };
}

function loadActiveDraft(ctx) {
    const row = sql.prepare("SELECT * FROM QQBotDraft WHERE conversation_key = ? AND status = 'active'").get(conversationKey(ctx));
    if (!row) return null;
    if (row.expires_at <= iso(ctx.now)) {
        sql.prepare("UPDATE QQBotDraft SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'").run(iso(ctx.now), row.id);
        return null;
    }
    return toDraft(row);
}

function isPaused(draft, now) {
    return now.getTime() - Date.parse(draft.last_activity_at) > PAUSE_AFTER_MS;
}

function computeStep(fields) {
    if (fields.lat == null || fields.lng == null) return 'location';
    if (!fields.name) return 'name';
    if (fields.description == null) return 'description';
    return 'ready';
}

/** Persists field changes; any change bumps the version and voids the current preview. */
function saveFields(draft, fields, { now, step }) {
    sql.prepare(`UPDATE QQBotDraft
        SET fields = ?, step = ?, version = version + 1,
            preview_version = NULL, preview_code = NULL, preview_request_id = NULL, preview_message_id = NULL,
            preview_duplicates = NULL, preview_expires_at = NULL,
            updated_at = ?, last_activity_at = ?, expires_at = ?
        WHERE id = ?`).run(JSON.stringify(fields), step, iso(now), iso(now), iso(later(now, DRAFT_TTL_MS)), draft.id);
    const hadPreview = draft.preview_version != null;
    Object.assign(draft, { fields, step, version: draft.version + 1, preview_version: null, preview_code: null, preview_request_id: null, preview_message_id: null });
    return { hadPreview };
}

function touch(draft, now, changes = {}) {
    const step = changes.step || draft.step;
    sql.prepare('UPDATE QQBotDraft SET step = ?, updated_at = ?, last_activity_at = ?, expires_at = ? WHERE id = ?')
        .run(step, iso(now), iso(now), iso(later(now, DRAFT_TTL_MS)), draft.id);
    draft.step = step;
    draft.last_activity_at = iso(now);
}

/** Remembers the bot's messages for this draft so group members can answer by quoting them. */
function recordBotMessage(draftId, kind, messageId, draftVersion) {
    if (!draftId || messageId == null) return;
    const row = sql.prepare('SELECT bot_message_ids, version, status FROM QQBotDraft WHERE id = ?').get(draftId);
    if (!row || row.status !== 'active') return;
    const ids = parseJson(row.bot_message_ids, []).concat(String(messageId)).slice(-MAX_TRACKED_BOT_MESSAGES);
    sql.prepare('UPDATE QQBotDraft SET bot_message_ids = ? WHERE id = ?').run(JSON.stringify(ids), draftId);
    if (kind === 'preview') {
        // Only the preview of the version that is still current becomes quotable for confirmation.
        sql.prepare('UPDATE QQBotDraft SET preview_message_id = ? WHERE id = ? AND preview_version = ? AND version = ?')
            .run(String(messageId), draftId, draftVersion, draftVersion);
    }
}

function isReplyToDraft(draft, replyId) {
    return !!(draft && replyId && draft.bot_message_ids.includes(String(replyId)));
}

// ---------- text helpers ----------

function shorten(text, max) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function tagsText(tags) {
    return Array.isArray(tags) && tags.length ? tags.join('、') : '';
}

function locationLine(fields) {
    if (fields.lat == null) return '定位：未发送';
    if (fields.address) return `地址：${fields.address}`;
    return `定位：${fields.location_name || `${fields.lat.toFixed(6)}, ${fields.lng.toFixed(6)}`}`;
}

function promptFor(draft, ctx) {
    const hint = ctx.isGroup ? GROUP_REPLY_HINT : '';
    switch (draft.step) {
        case 'location':
            return { text: '请通过 QQ 的“位置”功能发送想添加的店铺定位。', track: 'prompt' };
        case 'name': {
            const where = draft.fields.location_name ? `已收到“${draft.fields.location_name}”的位置，` : '已收到定位，';
            return { text: `${where}请发送店名。${hint}`, track: 'prompt' };
        }
        case 'description':
            return { text: `请发送描述；暂时不写可以用 !跳过。${hint}`, track: 'prompt' };
        default:
            return { text: '草稿已就绪，发送 !提交 查看核对信息。', track: 'prompt' };
    }
}

function draftSummary(draft) {
    const f = draft.fields;
    return [
        `当前草稿（${STEP_LABELS[draft.step] || draft.step}）：`,
        locationLine(f),
        `店名：${f.name || '未填写'}`,
        `描述：${f.description ? shorten(f.description, 80) : '未填写'}`,
        `人均：${f.per_person_cost ? `${f.per_person_cost} 元` : '未填写'}`,
        `标签：${tagsText(f.tags) || '未填写'}`
    ].join('\n');
}

function withDraft(reply, draft) {
    return { ...reply, draftId: draft.id, draftVersion: draft.version };
}

const NO_DRAFT = { text: '当前没有进行中的草稿，发送 !添加地点 开始。' };

// ---------- field parsing ----------

function parseName(value) {
    const result = placeService.normalizePlainTextField(value, { fieldLabel: '店名', maxLength: placeService.PLACE_NAME_MAX_LENGTH, required: true });
    return result.error ? { error: result.error } : { value: result.value };
}

function parseDescription(value) {
    const result = placeService.normalizePlainTextField(value, { fieldLabel: '描述', maxLength: placeService.PLACE_DESCRIPTION_MAX_LENGTH });
    return result.error ? { error: result.error } : { value: result.value };
}

function parseTags(value) {
    const normalized = placeService.normalizePlainTextField(String(value || '').replace(/、/g, ','), {
        fieldLabel: '标签', maxLength: placeService.PLACE_CATEGORY_MAX_LENGTH
    });
    if (normalized.error) return { error: normalized.error };
    const list = placeService.normalizeCategoryList(normalized.value);
    if (list.error) return { error: list.error.replace('分类', '标签') };
    if (list.value.length > placeService.PLACE_CATEGORY_MAX_LENGTH) {
        return { error: `标签总长度不能超过 ${placeService.PLACE_CATEGORY_MAX_LENGTH} 个字符` };
    }
    return { value: list.names };
}

function parseCost(value) {
    const text = String(value || '').trim().replace(/\s*(元|块|块钱|rmb|RMB)$/, '').replace(/^[¥￥]\s*/, '');
    if (!/^\d+$/.test(text)) return { error: '人均需为正整数，例如 !人均 20；不填可发送 !人均 清空' };
    const result = placeService.normalizePerPersonCost(text);
    return result.error ? { error: '人均需为正整数，例如 !人均 20' } : { value: result.value };
}

const CLEAR_WORDS = new Set(['清空', '清除', '删除', '无']);

/** Shop details recognised from a long add-place message; anything invalid is dropped and asked for later. */
function normalizePrefill(prefill) {
    const fields = {};
    if (!prefill || typeof prefill !== 'object') return fields;
    if (prefill.name) {
        const parsed = parseName(String(prefill.name).slice(0, placeService.PLACE_NAME_MAX_LENGTH));
        if (!parsed.error) fields.name = parsed.value;
    }
    if (prefill.description) {
        const parsed = parseDescription(String(prefill.description).slice(0, placeService.PLACE_DESCRIPTION_MAX_LENGTH));
        if (!parsed.error && parsed.value) fields.description = parsed.value;
    }
    if (prefill.per_person_cost != null) {
        const parsed = parseCost(String(prefill.per_person_cost));
        if (!parsed.error && parsed.value) fields.per_person_cost = parsed.value;
    }
    if (Array.isArray(prefill.tags) && prefill.tags.length) {
        const parsed = parseTags(prefill.tags.join(','));
        if (!parsed.error && parsed.value.length) fields.tags = parsed.value;
    }
    return fields;
}

function recognizedLines(fields) {
    const lines = [];
    if (fields.name) lines.push(`店名：${fields.name}`);
    if (fields.per_person_cost) lines.push(`人均：${fields.per_person_cost} 元`);
    if (fields.tags && fields.tags.length) lines.push(`标签：${tagsText(fields.tags)}`);
    if (fields.description) lines.push(`描述：${shorten(fields.description, 120)}`);
    return lines;
}

// ---------- conversation actions ----------

function identityReply(identity) {
    return { text: identityMessage(identity, botConfig.siteUrl()) };
}

/** The answer when this sender cannot start a draft (no account, ambiguous or restricted), else null. */
function startDraftBlocked(ctx) {
    const identity = resolveQQUser(ctx.senderQq);
    return identity.status === 'ok' ? null : [identityReply(identity)];
}

/**
 * `!添加地点`. `prefill` holds details recognised from a longer message
 * ({ name, description, per_person_cost, tags }); `note` is shown before the prompt.
 */
function startDraft(ctx, { prefill = null, note = '' } = {}) {
    const existing = loadActiveDraft(ctx);
    if (existing) {
        return [withDraft({
            text: `你已有一个未完成的草稿（${STEP_LABELS[existing.step] || existing.step}）。发送 !继续 接着编辑，或 !取消 后重新开始。`
        }, existing)];
    }
    const identity = resolveQQUser(ctx.senderQq);
    if (identity.status !== 'ok') return [identityReply(identity)];
    const now = ctx.now;
    const draft = {
        id: randomUUID(),
        step: 'location',
        fields: normalizePrefill(prefill),
        version: 1,
        bot_message_ids: [],
        preview_duplicates: []
    };
    sql.prepare(`INSERT INTO QQBotDraft (id, conversation_key, bot_id, chat_type, chat_id, sender_qq, user_id, status, step, fields, version,
            bot_message_ids, created_at, updated_at, last_activity_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', 'location', ?, 1, '[]', ?, ?, ?, ?)`).run(
        draft.id, conversationKey(ctx), ctx.botId, ctx.chatType, ctx.chatId, ctx.senderQq, identity.user.id,
        JSON.stringify(draft.fields), iso(now), iso(now), iso(now), iso(later(now, DRAFT_TTL_MS))
    );
    const prompt = promptFor(draft, ctx);
    const parts = [];
    if (note) parts.push(note);
    const recognized = recognizedLines(draft.fields);
    if (recognized.length) {
        parts.push(['已识别：', ...recognized, '识别有误可以用 !店名、!描述、!人均、!tag 修改。'].join('\n'), '');
    }
    parts.push(prompt.text);
    return [withDraft({ ...prompt, text: parts.join('\n') }, draft)];
}

function cancelDraft(ctx) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return [NO_DRAFT];
    sql.prepare("UPDATE QQBotDraft SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'active'").run(iso(ctx.now), draft.id);
    return [{ text: '已取消本次添加，草稿未保存为地点。' }];
}

function showDraft(ctx) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return [NO_DRAFT];
    touch(draft, ctx.now);
    return [withDraft({ text: `${draftSummary(draft)}\n\n${promptFor(draft, ctx).text}`, track: 'prompt' }, draft)];
}

function afterFieldChange(draft, ctx, message, { hadPreview }) {
    // Once location, name and description are settled, every change goes straight to the review message.
    if (draft.step === 'ready') {
        const replies = preparePreview(ctx);
        if (replies[0]) replies[0] = { ...replies[0], text: `${message}${hadPreview ? '已重新生成核对信息。' : ''}\n${replies[0].text}` };
        return replies;
    }
    const notes = [message];
    if (hadPreview) notes.push('草稿已修改，之前的预览已失效。');
    const prompt = promptFor(draft, ctx);
    return [withDraft({ text: `${notes.join('')}\n${prompt.text}`, track: prompt.track }, draft)];
}

/** `!店名` / `!描述` / `!人均` / `!tag`: edits apply in any step and resume a paused draft. */
function setField(ctx, field, args) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return [NO_DRAFT];
    const value = String(args || '').trim();
    const fields = { ...draft.fields };
    let message;
    if (field === 'name') {
        if (!value) return [{ text: '用法：!店名 店铺名称' }];
        const parsed = parseName(value);
        if (parsed.error) return [{ text: parsed.error }];
        fields.name = parsed.value;
        message = `店名已设为“${parsed.value}”。`;
    } else if (field === 'description') {
        if (!value) return [{ text: '用法：!描述 内容，或 !描述 清空' }];
        if (CLEAR_WORDS.has(value)) {
            fields.description = '';
            message = '描述已清空。';
        } else {
            const parsed = parseDescription(value);
            if (parsed.error) return [{ text: parsed.error }];
            fields.description = parsed.value;
            message = '描述已更新。';
        }
    } else if (field === 'cost') {
        if (!value) return [{ text: '用法：!人均 20，或 !人均 清空' }];
        if (CLEAR_WORDS.has(value)) {
            fields.per_person_cost = null;
            message = '人均已清空。';
        } else {
            const parsed = parseCost(value);
            if (parsed.error) return [{ text: parsed.error }];
            fields.per_person_cost = parsed.value;
            message = `人均已设为 ${parsed.value} 元。`;
        }
    } else if (field === 'tags') {
        if (!value) return [{ text: '用法：!tag 快餐,避雷（中英文逗号均可），或 !tag 清空；常用标签见 !标签列表' }];
        if (CLEAR_WORDS.has(value)) {
            fields.tags = [];
            message = '标签已清空。';
        } else {
            const parsed = parseTags(value);
            if (parsed.error) return [{ text: parsed.error }];
            fields.tags = parsed.value;
            message = `标签已设为：${tagsText(parsed.value)}。`;
        }
    }
    // While waiting for a (re)located card the step stays on location.
    const step = draft.step === 'location' ? 'location' : computeStep(fields);
    const saved = saveFields(draft, fields, { now: ctx.now, step });
    return afterFieldChange(draft, ctx, message, saved);
}

function notRegisteredForLocation() {
    const url = botConfig.siteUrl();
    return { text: `你的 QQ 还没有对应的网站账号。注册并填写本人 QQ 后才能记录位置${url ? `：${url}` : '。'}` };
}

function canKeepLocation(identity) {
    // A restricted account may still browse with !随机; only an unambiguous account counts.
    return !!identity.user && (identity.status === 'ok' || identity.status === 'banned');
}

/** `!定位` without a draft: the next location card becomes the sender's !随机 centre. */
function requestPersonalLocation(ctx) {
    if (!canKeepLocation(resolveQQUser(ctx.senderQq))) return [notRegisteredForLocation()];
    const now = ctx.now.getTime();
    if (pendingPersonalLocate.size > 1000) {
        for (const [key, expiresAt] of pendingPersonalLocate) if (expiresAt <= now) pendingPersonalLocate.delete(key);
    }
    pendingPersonalLocate.set(conversationKey(ctx), now + PERSONAL_LOCATE_TTL_MS);
    return [{ text: '请通过 QQ 的“位置”功能发送你现在的位置，之后 !随机 会以这里为中心推荐 5 km 内的地点。' }];
}

/** A location card outside a draft: in private chat, or in a group right after `!定位`. */
function recordPersonalLocation(ctx) {
    const key = conversationKey(ctx);
    const expiresAt = pendingPersonalLocate.get(key);
    const requested = !!expiresAt && expiresAt > ctx.now.getTime();
    if (ctx.isGroup && !requested) return [];
    const location = ctx.parsed.location;
    if (location.invalid) return [{ text: '这条位置没有可用的坐标，请重新通过 QQ 的“位置”功能发送。' }];
    pendingPersonalLocate.delete(key);
    const identity = resolveQQUser(ctx.senderQq);
    if (!canKeepLocation(identity)) {
        return [requested ? notRegisteredForLocation() : { text: '收到定位。如需添加地点，请先发送 !添加地点。' }];
    }
    const label = location.name || location.address || '';
    saveUserLocation(identity.user.id, { lat: location.lat, lng: location.lng, label, source: 'qq' }, ctx.now);
    return [{ text: `已记录你的位置${label ? `「${shorten(label, 30)}」` : ''}，发送 !随机 会以这里为中心推荐 5 km 内的地点。如需添加地点，请先发送 !添加地点。` }];
}

function requestLocation(ctx) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return requestPersonalLocation(ctx);
    touch(draft, ctx.now, { step: 'location' });
    return [withDraft({ text: '请通过 QQ 的“位置”功能重新发送店铺定位；原定位在收到新定位前保留。', track: 'prompt' }, draft)];
}

function skipStep(ctx) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return [NO_DRAFT];
    if (draft.step !== 'description') {
        if (draft.step === 'location' || draft.step === 'name') return [{ text: '定位和店名不能跳过。' }];
        return [{ text: '当前没有可以跳过的步骤，可以发送 !提交 查看预览。' }];
    }
    const fields = { ...draft.fields, description: '' };
    const saved = saveFields(draft, fields, { now: ctx.now, step: computeStep(fields) });
    return afterFieldChange(draft, ctx, '已跳过描述。', saved);
}

function pausedReply(draft) {
    return withDraft({ text: '草稿已超过 30 分钟未操作，暂停收集。发送 !继续 恢复，或 !取消 放弃。' }, draft);
}

/** A native location card. In groups it is taken without @ only while this sender's draft waits for one. */
function onLocation(ctx, draft) {
    const location = ctx.parsed.location;
    if (!draft) return recordPersonalLocation(ctx);
    const addressed = !ctx.isGroup || ctx.parsed.atSelf || isReplyToDraft(draft, ctx.parsed.replyId);
    if (draft.step !== 'location') {
        return addressed ? [withDraft({ text: '如需更换定位，请先发送 !定位，再发送新的位置。' }, draft)] : [];
    }
    if (isPaused(draft, ctx.now)) return addressed ? [pausedReply(draft)] : [];
    if (location.invalid) {
        return [withDraft({ text: '这条位置没有可用的坐标，请重新通过 QQ 的“位置”功能发送；不会根据名称猜测坐标。', track: 'prompt' }, draft)];
    }
    const hadLocation = draft.fields.lat != null;
    const hadName = !!draft.fields.name;
    const fields = {
        ...draft.fields,
        lat: location.lat,
        lng: location.lng,
        address: location.address || '',
        location_name: location.name || ''
    };
    const saved = saveFields(draft, fields, { now: ctx.now, step: computeStep(fields) });
    // A replaced location on a named draft is announced; otherwise just ask the next question.
    if (!(hadLocation && hadName) && !saved.hadPreview && draft.step !== 'ready') {
        const prompt = promptFor(draft, ctx);
        // The name question already says the location arrived; a name may have come with the first message.
        const text = draft.step === 'name' ? prompt.text : `已收到定位。${prompt.text}`;
        return [withDraft({ ...prompt, text }, draft)];
    }
    const message = hadLocation ? `定位已更新为“${location.name || '新位置'}”。` : '已收到定位。';
    return afterFieldChange(draft, ctx, message, saved);
}

/** Plain text answers the current question (name / description). */
function onText(ctx, draft) {
    const text = ctx.parsed.rawText;
    if (!draft) return null;
    const addressed = !ctx.isGroup || ctx.parsed.atSelf || isReplyToDraft(draft, ctx.parsed.replyId);
    if (!addressed) return [];
    if (isPaused(draft, ctx.now)) return [pausedReply(draft)];
    if (/^确认(提交)?$/.test(text)) {
        return [withDraft({ text: draft.preview_version != null
            ? '请引用最新的预览消息回复“确认提交”，或发送 !确认提交 确认码。'
            : '还没有可确认的预览，请先发送 !提交。' }, draft)];
    }
    if (draft.step === 'name') return setField(ctx, 'name', text);
    if (draft.step === 'description') return setField(ctx, 'description', text);
    if (draft.step === 'location') {
        return [withDraft({ text: '现在需要的是 QQ 原生“位置”消息；文字地址不能代替定位。', track: 'prompt' }, draft)];
    }
    return [withDraft({ text: '草稿已就绪。修改请用 !店名、!描述、!人均、!tag 等指令，或发送 !提交 查看预览。' }, draft)];
}

// ---------- preview & submission ----------

function validatedPlace(draft) {
    const f = draft.fields;
    return placeService.validateNewPlace({
        name: f.name,
        description: f.description || '',
        latitude: f.lat,
        longitude: f.lng,
        category: (f.tags || []).join(', '),
        per_person_cost: f.per_person_cost,
        address: f.address || ''
    });
}

function nearbyDuplicates(draft) {
    const f = draft.fields;
    return findDuplicates({ lat: f.lat, lng: f.lng, name: f.name });
}

function previewText(draft, user, duplicates, code) {
    const f = draft.fields;
    const lines = [
        '请核对：',
        `店名：${f.name}`,
        f.address ? `地址：${f.address}` : `定位：${f.location_name || `${f.lat.toFixed(6)}, ${f.lng.toFixed(6)}`}`,
        `人均：${f.per_person_cost ? `${f.per_person_cost} 元` : '未填写'}`,
        `标签：${tagsText(f.tags) || '未填写'}`,
        `描述：${f.description ? shorten(f.description, 200) : '未填写'}`,
        `作者：${user.username}`
    ];
    if (duplicates.length) {
        lines.push('', '⚠ 附近已有名称相似的地点：');
        duplicates.forEach((d) => {
            const link = botConfig.placeUrl(d.id);
            lines.push(`· ${d.name}（约 ${d.distance_m} 米）${link ? ` ${link}` : ''}`);
        });
        lines.push('如果是同一家店，请发送 !取消；确认提交即表示仍要新建。');
    }
    lines.push('', '可选补充（发送后会重新生成核对信息）：',
        '!人均 20　!tag 快餐,避雷　!标签列表',
        '!店名 新店名　!描述 新描述　!定位 重新发位置');
    lines.push('', `确认无误请回复本条“确认提交”，或发送 !确认提交 ${code}（5 分钟内有效）；放弃请发 !取消。`);
    return lines.join('\n');
}

function preparePreview(ctx) {
    const draft = loadActiveDraft(ctx);
    if (!draft) return [NO_DRAFT];
    const f = draft.fields;
    if (f.lat == null) return [withDraft({ text: '还没有定位，请先通过 QQ 的“位置”功能发送店铺定位。', track: 'prompt' }, draft)];
    if (!f.name) return [withDraft({ text: '还没有店名，请先发送 !店名 店铺名称。' }, draft)];
    const identity = resolveQQUser(ctx.senderQq);
    if (identity.status !== 'ok') return [identityReply(identity)];
    if (identity.user.id !== draft.user_id) {
        return [{ text: '你的网站账号信息已变化（可能已删除或改绑），本草稿无法提交，请联系管理员。' }];
    }
    const validated = validatedPlace(draft);
    if (validated.error) return [withDraft({ text: `无法提交：${validated.error}` }, draft)];
    // Submitting while the description is still being asked for counts as skipping it,
    // so later chat text is not captured as a description by accident.
    if (f.description == null) f.description = '';
    const duplicates = nearbyDuplicates(draft);
    const code = String(randomInt(1000, 10000));
    const requestId = randomUUID();
    const now = ctx.now;
    draft.step = computeStep(f);
    sql.prepare(`UPDATE QQBotDraft
        SET fields = ?, preview_version = version, preview_code = ?, preview_request_id = ?, preview_message_id = NULL,
            preview_duplicates = ?, preview_expires_at = ?, step = ?,
            updated_at = ?, last_activity_at = ?, expires_at = ?
        WHERE id = ?`).run(JSON.stringify(f), code, requestId, JSON.stringify(duplicates.map((d) => d.id)), iso(later(now, PREVIEW_TTL_MS)),
        draft.step, iso(now), iso(now), iso(later(now, DRAFT_TTL_MS)), draft.id);
    return [withDraft({ text: previewText(draft, identity.user, duplicates, code), track: 'preview' }, draft)];
}

class SubmitRejected extends Error {
    constructor(reply, { invalidatePreview = false } = {}) {
        super(reply);
        this.reply = reply;
        this.invalidatePreview = invalidatePreview;
    }
}

/**
 * Creates the place for a previewed draft exactly once. The request id was fixed
 * when the preview was made; retries reuse it and the draft_id unique key makes a
 * second submission return the first place instead of creating another one.
 */
function submitDraft(draftId, requestId, now) {
    const run = sql.transaction(() => {
        const previous = sql.prepare('SELECT place_id FROM QQBotSubmission WHERE draft_id = ? OR request_id = ?').get(draftId, requestId);
        if (previous) return { status: 'replayed', placeId: previous.place_id };
        const draft = toDraft(sql.prepare('SELECT * FROM QQBotDraft WHERE id = ?').get(draftId));
        if (!draft || draft.status !== 'active') throw new SubmitRejected('草稿已结束，请重新发送 !添加地点。');
        if (draft.preview_version !== draft.version || draft.preview_request_id !== requestId) {
            throw new SubmitRejected('预览已失效（草稿已修改），请重新发送 !提交。');
        }
        if (!draft.preview_expires_at || draft.preview_expires_at <= iso(now)) {
            throw new SubmitRejected('预览已过期，请重新发送 !提交。');
        }
        const identity = resolveQQUserForWrite(draft.sender_qq);
        if (identity.status !== 'ok') throw new SubmitRejected(identityMessage(identity, botConfig.siteUrl()));
        if (identity.user.id !== draft.user_id) {
            throw new SubmitRejected('你的网站账号信息已变化（可能已删除或改绑），本草稿无法提交，请联系管理员。');
        }
        const validated = validatedPlace(draft);
        if (validated.error) throw new SubmitRejected(`无法提交：${validated.error}`);
        // A similar place that appeared after the preview needs a fresh look.
        const acknowledged = new Set(draft.preview_duplicates);
        const fresh = nearbyDuplicates(draft).filter((d) => !acknowledged.has(d.id));
        if (fresh.length) {
            throw new SubmitRejected('附近刚出现名称相似的地点，请重新发送 !提交 查看最新预览。', { invalidatePreview: true });
        }
        const placeId = placeService.insertPlaceSync(validated.value, draft.user_id, { source: 'qq_bot' });
        sql.prepare('INSERT INTO QQBotSubmission (request_id, draft_id, draft_version, user_id, place_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
            .run(requestId, draftId, draft.version, draft.user_id, placeId, iso(now));
        sql.prepare("UPDATE QQBotDraft SET status = 'submitted', place_id = ?, updated_at = ? WHERE id = ?").run(placeId, iso(now), draftId);
        return { status: 'created', placeId, name: validated.value.name };
    });
    try {
        const result = run.immediate();
        if (result.status === 'created') placeService.afterPlacesCreated([result.placeId]);
        return result;
    } catch (error) {
        if (!(error instanceof SubmitRejected)) throw error;
        if (error.invalidatePreview) {
            sql.prepare(`UPDATE QQBotDraft SET preview_version = NULL, preview_code = NULL, preview_request_id = NULL,
                preview_message_id = NULL, preview_duplicates = NULL, preview_expires_at = NULL WHERE id = ?`).run(draftId);
        }
        return { status: 'rejected', reply: error.reply };
    }
}

function successReply(ctx, placeId, name, { replayed = false } = {}) {
    const link = botConfig.placeUrl(placeId);
    const prefix = replayed ? '这份草稿已经提交过了' : '添加成功';
    if (ctx.isGroup) {
        return { text: `${prefix}！「${name}」已加入地图${link ? `：${link}` : '。'}\n门面和菜单照片可在网页中补充。` };
    }
    return { text: `${prefix}！${link ? `在地图中查看：${link}` : ''}\n门面和菜单照片可在网页中补充。` };
}

function placeName(placeId) {
    const row = sql.prepare('SELECT name FROM Place WHERE id = ?').get(placeId);
    return row ? row.name : '地点';
}

/** `!确认提交 code`, or quoting the preview with "确认提交". */
function confirmSubmission(ctx, { code = '', viaReply = false } = {}) {
    const draft = loadActiveDraft(ctx);
    if (!draft) {
        // A repeated confirmation after success points back to the place already created.
        const done = code && sql.prepare(`SELECT place_id FROM QQBotDraft
            WHERE conversation_key = ? AND status = 'submitted' AND preview_code = ? AND updated_at > ?
            ORDER BY updated_at DESC LIMIT 1`).get(conversationKey(ctx), code, iso(later(ctx.now, -DRAFT_TTL_MS)));
        if (done && done.place_id) return [successReply(ctx, done.place_id, placeName(done.place_id), { replayed: true })];
        return [{ text: '当前没有待确认的预览，发送 !添加地点 开始。' }];
    }
    if (draft.preview_version == null || draft.preview_version !== draft.version) {
        return [withDraft({ text: '预览已失效或还没有预览，请先发送 !提交 生成最新预览。' }, draft)];
    }
    if (!draft.preview_expires_at || draft.preview_expires_at <= iso(ctx.now)) {
        return [withDraft({ text: '预览已过期，请重新发送 !提交。' }, draft)];
    }
    if (viaReply) {
        if (!draft.preview_message_id || draft.preview_message_id !== String(ctx.parsed.replyId)) {
            return [withDraft({ text: '这条预览已失效，请引用最新的预览消息，或发送 !确认提交 确认码。' }, draft)];
        }
    } else if (!code) {
        return [withDraft({ text: '请发送 !确认提交 确认码（见预览消息），或引用预览消息回复“确认提交”。' }, draft)];
    } else if (code !== draft.preview_code) {
        return [withDraft({ text: '确认码不正确，请核对最新的预览消息。' }, draft)];
    }
    const result = submitDraft(draft.id, draft.preview_request_id, ctx.now);
    if (result.status === 'rejected') return [withDraft({ text: result.reply }, draft)];
    return [successReply(ctx, result.placeId, result.name || placeName(result.placeId), { replayed: result.status === 'replayed' })];
}

// ---------- housekeeping ----------

function expireDrafts(now = new Date()) {
    return sql.prepare("UPDATE QQBotDraft SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?")
        .run(iso(now), iso(now)).changes;
}

module.exports = {
    DRAFT_TTL_MS,
    PAUSE_AFTER_MS,
    PREVIEW_TTL_MS,
    conversationKey,
    loadActiveDraft,
    isReplyToDraft,
    recordBotMessage,
    startDraft,
    startDraftBlocked,
    cancelDraft,
    showDraft,
    setField,
    requestLocation,
    skipStep,
    onLocation,
    onText,
    preparePreview,
    confirmSubmission,
    submitDraft,
    expireDrafts,
    parseTags,
    parseCost,
    normalizePrefill,
    _resetForTesting: () => pendingPersonalLocate.clear()
};
