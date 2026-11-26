const { createHash } = require('node:crypto');
const { beijingClock } = require('../../../infrastructure/beijingClock');
const { DEFAULT_COMPANION_ID, getCompanionState } = require('../../skins/services/companionState');
const { findPack } = require('../../skins/services/resourcePacks');
const { isBanActive } = require('../../accounts/services/userAccess');
const { loadCorpus } = require('./roomCorpus');
const { inferTags, defaultQuirks, normalizeSheet } = require('./roomTraits');
const { DEFAULT_ROLE_NAME } = require('./roomNames');
const { RoomError, roomNotFound } = require('./roomErrors');
const { refreshToday } = require('./roomDay');
const { cancelFutureMeets } = require('./roomMeets');
const { syncTexts, readTexts, enqueueTextChecks } = require('./roomTextCheck');

const TEXT_SAVE_LIMIT = 10;
const pendingInference = new WeakMap();

function defaultRoleName(database, userId) {
    const { active } = getCompanionState(userId, database);
    return active === DEFAULT_COMPANION_ID ? DEFAULT_ROLE_NAME : findPack('companion', active)?.name ?? DEFAULT_ROLE_NAME;
}

function readProfile(database, userId) {
    const row = database.prepare('SELECT * FROM RoomProfile WHERE user_id = ?').get(userId);
    return row ? { ...row, sheet: JSON.parse(row.sheet) } : null;
}

function assertWritable(database, userId, now) {
    const user = database.prepare('SELECT is_banned, ban_expires FROM User WHERE id = ?').get(userId);
    if (!user) throw roomNotFound();
    if (isBanActive(user, new Date(now))) throw new RoomError(403, 'AUTH_USER_BANNED', '通行凭证已受限，仅允许查看内容');
}

async function ensureInference(database, userId, now, day) {
    const cached = readProfile(database, userId)?.sheet.inferred;
    if (cached?.day >= day) return cached;
    if (!pendingInference.has(database)) pendingInference.set(database, new Map());
    const pending = pendingInference.get(database);
    const key = JSON.stringify([userId, day]);
    if (pending.has(key)) return pending.get(key);
    const work = inferTags(database, userId, { now }).then(({ tags, basis }) => database.transaction(() => {
        if (!database.prepare('SELECT 1 FROM User WHERE id = ?').get(userId)) throw roomNotFound();
        const stored = readProfile(database, userId)?.sheet ?? {};
        if (stored.inferred?.day >= day) return stored.inferred;
        const inferred = { day, tags: tags.map((tag) => ({ tag, basis: basis[tag] })) };
        database.prepare(`INSERT INTO RoomProfile (user_id, sheet, updated_at_ms) VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET sheet = excluded.sheet`)
            .run(userId, JSON.stringify({ ...stored, inferred }), Number(now));
        return inferred;
    }).immediate()).finally(() => pending.delete(key));
    pending.set(key, work);
    return work;
}

function suggestedSheet(userId, inferred, corpus) {
    const tags = inferred.tags.map(({ tag }) => tag);
    return { name: '', tags, untagged: [], answers: {}, quirks: defaultQuirks(userId, tags, corpus), sayings: [] };
}

function cityExists(database, city) {
    return Boolean(database.prepare('SELECT 1 FROM PlaceRegion WHERE city = ? LIMIT 1').get(city));
}

function lastCity(database, userId) {
    const city = database.prepare('SELECT city FROM UserLastLocation WHERE user_id = ?').get(userId)?.city;
    return city && cityExists(database, city) ? city : null;
}

function settingsForWrite(database, userId, input, errors, { naming }) {
    const { visibility = 'residents', meets = 1 } = input;
    if (visibility !== 'residents' && visibility !== 'self') errors.push('可见范围须为 residents 或 self');
    if (![0, 1, true, false].includes(meets)) errors.push('互动设置须为开启或关闭');
    let city = null;
    if (input.city === undefined && naming) city = lastCity(database, userId);
    else if (typeof input.city === 'string') {
        city = input.city.trim() || null;
        if (city && !cityExists(database, city)) errors.push('请选择地图上的城市');
    } else if (input.city != null) errors.push('城市须为城市名或留空');
    return { visibility, meets: visibility === 'self' ? 0 : Number(meets), city };
}

function writeInput(database, userId, input, corpus, inferred) {
    const naming = inferred !== undefined;
    const validBody = input && typeof input === 'object' && !Array.isArray(input);
    if (!validBody) throw new RoomError(400, 'room_invalid', '请检查角色卡和设置', ['请求须为对象']);
    const draft = naming ? { ...suggestedSheet(userId, inferred, corpus), name: input.name, answers: input.answers } : input.sheet;
    const { sheet, errors } = normalizeSheet(draft, corpus, { defaultName: defaultRoleName(database, userId) });
    const settings = settingsForWrite(database, userId, input, errors, { naming });
    if (errors.length) throw new RoomError(400, 'room_invalid', '请检查角色卡和设置', errors);
    return { sheet, ...settings };
}

function hashSheet(sheet) {
    const answers = Object.fromEntries(Object.entries(sheet.answers).sort(([a], [b]) => a.localeCompare(b)));
    return createHash('sha256').update(JSON.stringify({ ...sheet, answers })).digest('hex');
}

function textSavesLeft(database, userId, day) {
    const row = database.prepare('SELECT count FROM RoomTextQuota WHERE user_id = ? AND day = ?').get(userId, day);
    return Math.max(0, TEXT_SAVE_LIMIT - (row?.count ?? 0));
}

async function getMe(database, userId, { now = Date.now() } = {}) {
    const { day } = beijingClock(new Date(now));
    const corpus = loadCorpus();
    const inferred = await ensureInference(database, userId, now, day);
    const row = readProfile(database, userId);
    if (!row) throw roomNotFound();
    const { inferred: _cached, ...sheet } = row.sheet;
    const { groups, exclusive } = corpus.tags;
    return {
        named: Boolean(row.enabled),
        profile: {
            visibility: row.visibility,
            meets: row.meets,
            city: row.enabled ? row.city : lastCity(database, userId),
            sheet: row.enabled ? sheet : suggestedSheet(userId, inferred, corpus)
        },
        default_name: defaultRoleName(database, userId),
        suggestions: { tags: inferred.tags },
        tags: { groups, exclusive },
        quirks: corpus.quirks.map(({ id, name, fits }) => ({ id, name, fits })),
        quiz: corpus.situations.filter(({ quiz }) => quiz != null).sort((a, b) => a.quiz - b.quiz)
            .map(({ quiz, id, ask, variants }) => ({
                n: quiz, situation: id, ask,
                options: variants.filter(({ rare }) => !rare).map(({ id, action }) => ({
                    id, text: action.replaceAll('{a}', '').replaceAll('{place}', '这家店').trim()
                }))
            })),
        text_saves_left: textSavesLeft(database, userId, day),
        texts: readTexts(database, userId, row.enabled ? sheet : { name: '', sayings: [] })
    };
}

async function nameRoom(database, userId, input, { now = Date.now() } = {}) {
    const alreadyNamed = () => new RoomError(409, 'room_already_named', '小伙伴已经入住');
    if (readProfile(database, userId)?.enabled) throw alreadyNamed();
    const { day } = beijingClock(new Date(now));
    const corpus = loadCorpus();
    assertWritable(database, userId, now);
    writeInput(database, userId, input, corpus, { tags: [] });
    const inferred = await ensureInference(database, userId, now, day);
    const result = database.transaction(() => {
        assertWritable(database, userId, now);
        const row = readProfile(database, userId);
        if (!row) throw roomNotFound();
        if (row.enabled) throw alreadyNamed();
        const { sheet, visibility, meets, city } = writeInput(database, userId, input, corpus, row.sheet.inferred ?? inferred);
        database.prepare(`UPDATE RoomProfile SET enabled = 1, visibility = ?, meets = ?, city = ?, sheet = ?,
            sheet_hash = ?, named_at_ms = ?, named_day = ?, updated_at_ms = ? WHERE user_id = ?`)
            .run(visibility, meets, city, JSON.stringify({ ...sheet, inferred: row.sheet.inferred ?? inferred }),
                hashSheet(sheet), Number(now), day, Number(now), userId);
        syncTexts(database, userId, sheet, now);
        return { named: true, profile: { visibility, meets, city, sheet }, text_saves_left: textSavesLeft(database, userId, day) };
    }).immediate();
    enqueueTextChecks(database, userId);
    return result;
}

function saveProfile(database, userId, input, { now = Date.now() } = {}) {
    const clock = beijingClock(new Date(now));
    const corpus = loadCorpus();
    const result = database.transaction(() => {
        assertWritable(database, userId, now);
        const row = readProfile(database, userId);
        if (!row?.enabled) throw new RoomError(409, 'room_not_named', '请先给小伙伴起名');
        const { sheet, visibility, meets, city } = writeInput(database, userId, input, corpus);
        if (!sheet.quirks.length) sheet.quirks = defaultQuirks(userId, sheet.tags, corpus);
        const old = row.sheet;
        const textChanged = old.name !== sheet.name || JSON.stringify(old.sayings) !== JSON.stringify(sheet.sayings);
        if (textChanged) {
            const quota = database.prepare(`INSERT INTO RoomTextQuota (user_id, day, count) VALUES (?, ?, 1)
                ON CONFLICT(user_id, day) DO UPDATE SET count = count + 1 WHERE count < ?`)
                .run(userId, clock.day, TEXT_SAVE_LIMIT);
            if (!quota.changes) throw new RoomError(429, 'room_text_limit', '今天修改名字或口头禅的次数已用完');
        }
        const sheetHash = hashSheet(sheet);
        database.prepare(`UPDATE RoomProfile SET visibility = ?, meets = ?, city = ?, sheet = ?,
            sheet_hash = ?, updated_at_ms = ? WHERE user_id = ?`)
            .run(visibility, meets, city, JSON.stringify({ ...sheet, inferred: old.inferred }), sheetHash, Number(now), userId);
        syncTexts(database, userId, sheet, now);
        if (row.meets && !meets || row.visibility !== visibility && visibility === 'self' || city !== row.city) {
            cancelFutureMeets(database, userId, now);
        }
        if (sheetHash !== row.sheet_hash || city !== row.city) {
            refreshToday(database, { userId, profile: { ...row, city, sheet_hash: sheetHash }, sheet, clock, now, corpus });
        }
        return { named: true, profile: { visibility, meets, city, sheet }, text_saves_left: textSavesLeft(database, userId, clock.day) };
    }).immediate();
    enqueueTextChecks(database, userId);
    return result;
}

function clearTexts(database, userId, now = Date.now()) {
    const row = readProfile(database, userId);
    if (!row?.enabled) throw roomNotFound();
    const clock = beijingClock(new Date(now));
    const sheet = { ...row.sheet, sayings: [] };
    const { inferred, ...publicSheet } = sheet;
    const sheetHash = hashSheet(publicSheet);
    database.prepare('UPDATE RoomProfile SET sheet = ?, sheet_hash = ?, updated_at_ms = ? WHERE user_id = ?')
        .run(JSON.stringify({ ...publicSheet, inferred }), sheetHash, now, userId);
    database.prepare("DELETE FROM RoomText WHERE user_id = ? AND substr(field, 1, 7) = 'saying:'").run(userId);
    database.prepare(`INSERT INTO RoomText (user_id, field, value, status, report, updated_at_ms)
        VALUES (?, 'name', ?, 'self_only', '管理员清空', ?) ON CONFLICT(user_id, field) DO UPDATE SET
        value = excluded.value, status = excluded.status, report = excluded.report, updated_at_ms = excluded.updated_at_ms`)
        .run(userId, sheet.name, now);
    database.prepare('DELETE FROM RoomDay WHERE user_id = ? AND day > ?').run(userId, clock.day);
    refreshToday(database, { userId, profile: { ...row, sheet_hash: sheetHash }, sheet, clock, now, corpus: loadCorpus() });
}

module.exports = { DEFAULT_ROLE_NAME, defaultRoleName, getMe, nameRoom, saveProfile, clearTexts };
