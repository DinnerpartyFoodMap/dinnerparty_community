const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// 观察屋的固定语料：读取、校验、算版本。规则见 ../doc/CORPUS.md，禁用词在 ../corpus/rules.json。
const CORPUS_DIR = path.join(__dirname, '..', 'corpus');
const ICONS = Object.freeze(['eat', 'drink', 'cook', 'sleep', 'phone', 'book', 'game', 'write', 'clean', 'chat', 'walk', 'bag', 'tv']);
const AXES = Object.freeze(['homestyle', 'noodles', 'hotpotBbq', 'dessert', 'drinks', 'foreign']);
const OUTING_STEPS = Object.freeze(['pick', 'leave', 'arrive', 'order', 'wait', 'serve', 'eat', 'spicy', 'full', 'pay', 'back']);
const ANCHORS = Object.freeze(['wake', 'bedtime', 'sleep']);
const SCRIPT_KINDS = Object.freeze(['table', 'remote', 'bond']);
const QUIZ_COUNT = 20;

function readJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readFolder(folder) {
    if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter((name) => name.endsWith('.json')).sort()
        .flatMap((name) => readJson(path.join(folder, name)).map((item) => ({ ...item, file: name })));
}

function loadCorpus(dir = CORPUS_DIR) {
    const files = ['rules.json', 'tags.json', 'quirks.json'].map((name) => path.join(dir, name))
        .concat(['situations', 'scripts'].flatMap((sub) => {
            const folder = path.join(dir, sub);
            return fs.existsSync(folder) ? fs.readdirSync(folder).filter((n) => n.endsWith('.json')).sort().map((n) => path.join(folder, n)) : [];
        }));
    const hash = crypto.createHash('sha256');
    for (const file of files) hash.update(path.relative(dir, file).replace(/\\/g, '/')).update('\0').update(fs.readFileSync(file));
    return {
        rules: readJson(path.join(dir, 'rules.json')),
        tags: readJson(path.join(dir, 'tags.json')),
        quirks: readJson(path.join(dir, 'quirks.json')),
        situations: readFolder(path.join(dir, 'situations')),
        scripts: readFolder(path.join(dir, 'scripts')),
        version: hash.digest('hex').slice(0, 12)
    };
}

/** 字数：去掉「」“”和空白；占位符按 rules.placeholderLength 计 */
function textLength(text, rules) {
    let value = String(text || '');
    for (const [token, size] of Object.entries(rules.placeholderLength)) value = value.split(token).join('字'.repeat(size));
    return Array.from(value.replace(/[「」“”\s]/g, '')).length;
}

const outsideQuotes = (text) => String(text || '').replace(/「[^」]*」/g, '');

function lines(item) {
    return [item.action, ...(item.sound || []), ...(item.detail || [])].filter((t) => typeof t === 'string');
}

function validateCorpus(corpus) {
    const { rules } = corpus;
    const errors = [];
    const warnings = [];
    const tagList = corpus.tags.groups.flatMap((group) => group.tags);
    const tagSet = new Set(tagList);
    const tagUses = new Map(tagList.map((tag) => [tag, 0]));
    const situationIds = new Set();
    const patterns = Object.entries(rules.patterns).map(([name, source]) => [name, new RegExp(source, 'u')]);
    const flatBanned = Object.entries(rules.banned).flatMap(([group, words]) => words.map((word) => [group, word]));

    const useTags = (where, tags) => {
        if (!Array.isArray(tags)) { errors.push(`${where}: 标签必须是数组`); return; }
        for (const tag of tags) {
            if (!tagSet.has(tag)) errors.push(`${where}: 标签表里没有「${tag}」`);
            else tagUses.set(tag, tagUses.get(tag) + 1);
        }
    };

    // 一条事件（动作 + 一句话 + 细节）的文字检查
    const checkText = (where, item, { lead, placeholders, atPlace, betweenResidents }) => {
        if (typeof item.action !== 'string' || !lead.some((token) => item.action.startsWith(token))) {
            errors.push(`${where}: 动作要以 ${lead.join(' 或 ')} 开头`);
        }
        if (textLength(item.action, rules) > rules.limits.action) errors.push(`${where}: 动作超过 ${rules.limits.action} 字：${item.action}`);
        if (!Array.isArray(item.sound) || !Array.isArray(item.detail)) { errors.push(`${where}: sound 和 detail 必须是数组`); return; }
        for (const sound of item.sound) {
            if (!/^「[^「」]+」$/.test(sound)) errors.push(`${where}: 一句话要用「」整个括起来：${sound}`);
            else if (textLength(sound, rules) > rules.limits.sound) errors.push(`${where}: 一句话超过 ${rules.limits.sound} 字：${sound}`);
        }
        for (const detail of item.detail) {
            if (textLength(detail, rules) > rules.limits.detail) errors.push(`${where}: 细节超过 ${rules.limits.detail} 字：${detail}`);
        }
        for (const text of lines(item)) {
            for (const token of text.match(/\{[a-z]+\}/g) || []) {
                if (!placeholders.includes(token)) errors.push(`${where}: 这里不能用 ${token}：${text}`);
            }
            for (const [group, word] of flatBanned) if (text.includes(word)) errors.push(`${where}: ${group}「${word}」：${text}`);
            for (const [name, regex] of patterns) if (regex.test(text)) errors.push(`${where}: ${name}：${text}`);
            for (const word of rules.bannedActions) if (text.includes(word)) errors.push(`${where}: 像真实操作「${word}」：${text}`);
            if (/\p{Extended_Pictographic}/u.test(text)) errors.push(`${where}: 不用表情符号：${text}`);
            if (/(?<!其)[他她它]/.test(text)) errors.push(`${where}: 不用他 / 她 / 它，写名字：${text}`);
            const narration = outsideQuotes(text);
            if (/…/.test(narration)) errors.push(`${where}: 省略号只能在「」里：${text}`);
            for (const word of rules.bannedOutsideQuotes) if (narration.includes(word)) errors.push(`${where}: 写了内心或解释「${word}」：${text}`);
            if (atPlace) for (const word of rules.bannedAtPlace) if (text.includes(word)) errors.push(`${where}: 在店里不评价店「${word}」：${text}`);
            if (betweenResidents) for (const word of rules.bannedBetweenResidents) if (text.includes(word)) errors.push(`${where}: 两位住民的小伙伴之间不写「${word}」：${text}`);
        }
        if (item.icon !== undefined && !ICONS.includes(item.icon)) errors.push(`${where}: 没有图标 ${item.icon}`);
    };

    const checkAxes = (where, axes) => {
        if (axes === undefined || axes === null) return;
        if (!Array.isArray(axes) || !axes.length || axes.some((axis) => !AXES.includes(axis))) errors.push(`${where}: axes 只能是 ${AXES.join(' / ')}`);
    };

    // 句子本身说了多久（“睡了四十分钟”）时，用做法自己的 minutes 盖过情境的
    const checkMinutes = (where, minutes, optional = false) => {
        if (optional && minutes === undefined) return;
        if (!Array.isArray(minutes) || minutes.length !== 2 || !(minutes[0] > 0) || minutes[0] > minutes[1]) errors.push(`${where}: minutes 写成 [最短, 最长]`);
    };

    const checkWindow = (where, window) => {
        if (window === null || window === undefined) return [];
        const ranges = Array.isArray(window[0]) ? window : [window];
        for (const range of ranges) {
            if (!Array.isArray(range) || range.length !== 2 || !Number.isInteger(range[0]) || !Number.isInteger(range[1])
                || range[0] < 0 || range[1] > 1800 || range[0] >= range[1]) errors.push(`${where}: window 写成 [起, 止] 分钟数，止可以到 1800`);
        }
        return ranges;
    };

    // ---- 情境 ----
    const quizSeen = new Map();
    const hourCoverage = Array.from({ length: 24 }, () => 0);
    const situationStats = { variants: 0, withSound: 0, withDetail: 0, prefixes: new Map() };
    for (const situation of corpus.situations) {
        const where = `${situation.file} ${situation.id}`;
        if (!/^(home|outing)\.[a-z0-9_-]+$/.test(situation.id || '')) errors.push(`${where}: id 要是 home.xxx 或 outing.xxx`);
        if (situationIds.has(situation.id)) errors.push(`${where}: id 重复`);
        situationIds.add(situation.id);
        if (!['home', 'outing'].includes(situation.scene) || !String(situation.id).startsWith(`${situation.scene}.`)) errors.push(`${where}: scene 和 id 前缀要一致`);
        if (situation.scene === 'outing' && !OUTING_STEPS.includes(situation.step)) errors.push(`${where}: step 只能是 ${OUTING_STEPS.join(' / ')}`);
        if (situation.scene === 'home' && situation.step !== undefined) errors.push(`${where}: 屋里的情境没有 step`);
        if (situation.axis !== undefined && (situation.step !== 'eat' || !AXES.includes(situation.axis))) errors.push(`${where}: axis 只给 outing.eat 用`);
        checkAxes(where, situation.axes);
        if (situation.anchor !== undefined && (situation.scene !== 'home' || !ANCHORS.includes(situation.anchor))) errors.push(`${where}: anchor 只能是 ${ANCHORS.join(' / ')}`);
        if (situation.when !== undefined && !['explore', 'spicy'].includes(situation.when)) errors.push(`${where}: when 只能是 explore / spicy`);
        if (situation.chance !== undefined && !(situation.chance > 0 && situation.chance <= 1)) errors.push(`${where}: chance 在 0 到 1 之间`);
        if (situation.days !== undefined && !['weekend', 'weekday'].includes(situation.days)) errors.push(`${where}: days 只能是 weekend / weekday`);
        if (situation.weight !== undefined && !(situation.weight > 0)) errors.push(`${where}: weight 要大于 0`);
        checkMinutes(where, situation.minutes);
        if (!ICONS.includes(situation.icon)) errors.push(`${where}: 没有图标 ${situation.icon}`);
        if (situation.quiz !== undefined) {
            if (!Number.isInteger(situation.quiz) || situation.quiz < 1 || situation.quiz > QUIZ_COUNT) errors.push(`${where}: quiz 是 1 到 ${QUIZ_COUNT}`);
            if (quizSeen.has(situation.quiz)) errors.push(`${where}: quiz ${situation.quiz} 和 ${quizSeen.get(situation.quiz)} 重复`);
            quizSeen.set(situation.quiz, situation.id);
            if (typeof situation.ask !== 'string' || !situation.ask.trim()) errors.push(`${where}: 问答题要有 ask`);
        }
        const ranges = checkWindow(where, situation.window);
        if (situation.scene === 'home' && !situation.anchor) {
            for (let hour = 6; hour < 24; hour += 1) {
                if (!ranges.length || ranges.some(([start, end]) => start <= hour * 60 && end >= hour * 60 + 60)) hourCoverage[hour] += 1;
            }
        }
        const variants = Array.isArray(situation.variants) ? situation.variants : [];
        if (variants.length < 2) errors.push(`${where}: 至少 2 种做法`);
        const plain = variants.filter((variant) => Array.isArray(variant.fits) && variant.fits.length === 0);
        if (plain.length !== 1) errors.push(`${where}: 要正好一种普通做法（fits 为空），现在 ${plain.length} 种`);
        const variantIds = new Set();
        const verbs = new Map();
        for (const variant of variants) {
            const vWhere = `${where}/${variant.id}`;
            if (!/^[a-z0-9-]+$/.test(variant.id || '') || variantIds.has(variant.id)) errors.push(`${vWhere}: 做法 id 只用小写字母、数字、连字符，且不重复`);
            variantIds.add(variant.id);
            if (Array.isArray(variant.fits) && variant.fits.length > 2) errors.push(`${vWhere}: fits 最多 2 个`);
            useTags(vWhere, variant.fits);
            checkAxes(vWhere, variant.axes);
            checkMinutes(vWhere, variant.minutes, true);
            if (variant.window !== undefined) checkWindow(vWhere, variant.window);
            checkText(vWhere, variant, {
                lead: ['{a}'],
                placeholders: situation.scene === 'outing' ? ['{a}', '{place}'] : ['{a}'],
                atPlace: situation.scene === 'outing', betweenResidents: false
            });
            situationStats.variants += 1;
            if (variant.sound?.length) situationStats.withSound += 1;
            if (variant.detail?.length) situationStats.withDetail += 1;
            const prefix = Array.from(String(variant.action || '').replace('{a}', '')).slice(0, 2).join('');
            situationStats.prefixes.set(prefix, (situationStats.prefixes.get(prefix) || 0) + 1);
            // 开头的介词、副词不算（把、在、又……），看第一个实在的字
            const verb = Array.from(String(variant.action || '').replace('{a}', '').replace(/^[把在被给和跟又先一也就]+/, '')).slice(0, 1).join('');
            if (verbs.has(verb)) warnings.push(`${vWhere}: 和 ${verbs.get(verb)} 开头的字相同（${verb}）`);
            verbs.set(verb, variant.id);
        }
    }
    for (let quiz = 1; quiz <= QUIZ_COUNT; quiz += 1) if (!quizSeen.has(quiz)) errors.push(`问答缺第 ${quiz} 题`);
    for (const anchor of ANCHORS) if (!corpus.situations.some((s) => s.anchor === anchor)) errors.push(`缺 anchor 为 ${anchor} 的屋里情境`);
    for (const step of OUTING_STEPS) if (!corpus.situations.some((s) => s.scene === 'outing' && s.step === step)) errors.push(`缺出门的 ${step} 情境`);
    for (const axis of [...AXES, null]) {
        if (!corpus.situations.some((s) => s.step === 'eat' && (s.axis ?? null) === axis)) errors.push(`缺 ${axis || '通用'} 的 outing.eat`);
    }

    // ---- 小习惯 ----
    const quirkIds = new Set();
    for (const quirk of corpus.quirks) {
        const where = `quirks.json ${quirk.id}`;
        if (!/^[a-z0-9-]+$/.test(quirk.id || '') || quirkIds.has(quirk.id)) errors.push(`${where}: id 只用小写字母、数字、连字符，且不重复`);
        quirkIds.add(quirk.id);
        if (typeof quirk.name !== 'string' || !quirk.name || textLength(quirk.name, rules) > rules.limits.quirkName) errors.push(`${where}: name 1 到 ${rules.limits.quirkName} 字`);
        useTags(where, quirk.fits);
        const hooks = Array.isArray(quirk.hooks) ? quirk.hooks : [];
        if (hooks.length < 2) errors.push(`${where}: 至少挂在 2 个情境上`);
        hooks.forEach((hook, index) => {
            const hWhere = `${where}#${index + 1}`;
            const target = corpus.situations.find((s) => s.id === hook.situation);
            if (!target) { errors.push(`${hWhere}: 找不到情境 ${hook.situation}`); return; }
            checkAxes(hWhere, hook.axes);
            checkMinutes(hWhere, hook.minutes, true);
            checkText(hWhere, hook, {
                lead: ['{a}'], placeholders: target.scene === 'outing' ? ['{a}', '{place}'] : ['{a}'],
                atPlace: target.scene === 'outing', betweenResidents: false
            });
        });
    }

    // ---- 剧本 ----
    const scriptIds = new Set();
    const coverage = { table: [0, 0, 0, 0], remote: [0, 0, 0, 0], bond: [0, 0, 0, 0] };
    for (const script of corpus.scripts) {
        const where = `${script.file} ${script.id}`;
        if (!/^(table|remote|bond)\.[a-z0-9-]+$/.test(script.id || '') || scriptIds.has(script.id)) errors.push(`${where}: id 要是 kind.xxx 且不重复`);
        scriptIds.add(script.id);
        if (!SCRIPT_KINDS.includes(script.kind) || !String(script.id).startsWith(`${script.kind}.`)) errors.push(`${where}: kind 和 id 前缀要一致`);
        if (script.kind === 'bond') {
            if (![1, 2, 3].includes(script.level)) errors.push(`${where}: 升级剧情的 level 是 1 到 3`);
            else coverage.bond[script.level] += 1;
        } else if (!Array.isArray(script.bond) || script.bond.length !== 2 || !(script.bond[0] >= 0 && script.bond[0] <= script.bond[1] && script.bond[1] <= 3)) {
            errors.push(`${where}: bond 写成 [最低, 最高]，0 到 3`);
        } else if (coverage[script.kind]) {
            for (let level = script.bond[0]; level <= script.bond[1]; level += 1) coverage[script.kind][level] += 1;
        }
        if (script.axis !== undefined && script.axis !== null && (script.kind !== 'table' || !AXES.includes(script.axis))) errors.push(`${where}: 只有拼桌剧本能限定 axis`);
        useTags(`${where} x`, script.x || []);
        useTags(`${where} y`, script.y || []);
        const beats = Array.isArray(script.beats) ? script.beats : [];
        const [min, max] = script.kind === 'bond' ? [1, 2] : [2, 4];
        if (beats.length < min || beats.length > max) errors.push(`${where}: ${min} 到 ${max} 条`);
        if (beats.filter((beat) => beat.star).length !== 1) errors.push(`${where}: 要正好一条 star`);
        const all = beats.flatMap(lines).join('');
        if (!all.includes('{x}') || !all.includes('{y}')) errors.push(`${where}: {x} 和 {y} 都要出场`);
        beats.forEach((beat, index) => {
            const bWhere = `${where}#${index + 1}`;
            if (!['x', 'y', 'xy'].includes(beat.who)) errors.push(`${bWhere}: who 只能是 x / y / xy`);
            checkMinutes(bWhere, beat.minutes);
            if (!ICONS.includes(beat.icon)) errors.push(`${bWhere}: 没有图标 ${beat.icon}`);
            checkText(bWhere, beat, {
                lead: ['{x}', '{y}'], placeholders: script.kind === 'table' ? ['{x}', '{y}', '{place}'] : ['{x}', '{y}'],
                atPlace: script.kind === 'table', betweenResidents: true
            });
        });
    }
    for (let level = 0; level <= 3; level += 1) {
        if (coverage.table[level] < 3) errors.push(`熟悉度 ${level} 的拼桌剧本少于 3 段（${coverage.table[level]}）`);
        if (coverage.remote[level] < 2) errors.push(`熟悉度 ${level} 的隔空剧本少于 2 段（${coverage.remote[level]}）`);
    }
    for (let level = 1; level <= 3; level += 1) if (coverage.bond[level] < 1) errors.push(`缺升到 ${level} 级的升级剧情`);

    // ---- 成批的范围 ----
    const share = (count) => situationStats.variants ? count / situationStats.variants : 0;
    const soundShare = share(situationStats.withSound);
    const detailShare = share(situationStats.withDetail);
    if (soundShare < 0.3 || soundShare > 0.6) errors.push(`有一句话的做法占 ${(soundShare * 100).toFixed(0)}%，应在 30% 到 60%`);
    if (detailShare < 0.6 || detailShare > 0.9) errors.push(`有细节的做法占 ${(detailShare * 100).toFixed(0)}%，应在 60% 到 90%`);
    for (const [prefix, count] of situationStats.prefixes) {
        if (count / situationStats.variants > 0.15) errors.push(`「{a}${prefix}」开头的做法占 ${(count / situationStats.variants * 100).toFixed(0)}%，超过 15%`);
    }
    for (const [tag, count] of tagUses) if (count < 3) errors.push(`标签「${tag}」只用到 ${count} 次，至少 3 次`);
    for (let hour = 6; hour < 24; hour += 1) if (hourCoverage[hour] < 6) errors.push(`${hour}:00 可用的屋里情境只有 ${hourCoverage[hour]} 个，至少 6 个`);

    // ---- 只提示：近似重复 ----
    const all = [
        ...corpus.situations.flatMap((s) => (s.variants || []).map((v) => [`${s.id}/${v.id}`, v.action])),
        ...corpus.quirks.flatMap((q) => (q.hooks || []).map((h, i) => [`${q.id}#${i + 1}`, h.action])),
        ...corpus.scripts.flatMap((s) => (s.beats || []).map((b, i) => [`${s.id}#${i + 1}`, b.action]))
    ];
    const grams = (text) => {
        const chars = Array.from(String(text || '').replace(/\{[a-z]+\}/g, ''));
        return new Set(chars.slice(0, -1).map((c, i) => c + chars[i + 1]));
    };
    const sets = all.map(([id, text]) => [id, text, grams(text)]);
    for (let i = 0; i < sets.length; i += 1) {
        for (let j = i + 1; j < sets.length; j += 1) {
            const [a, b] = [sets[i][2], sets[j][2]];
            if (!a.size || !b.size) continue;
            let common = 0;
            for (const gram of a) if (b.has(gram)) common += 1;
            if (common / (a.size + b.size - common) >= 0.6) warnings.push(`近似重复：${sets[i][0]}「${sets[i][1]}」和 ${sets[j][0]}「${sets[j][1]}」`);
        }
    }

    return {
        errors, warnings,
        stats: {
            situations: corpus.situations.length, variants: situationStats.variants, quirks: corpus.quirks.length,
            scripts: corpus.scripts.length, coverage, soundShare, detailShare, tagUses: Object.fromEntries(tagUses), hourCoverage
        }
    };
}

module.exports = { CORPUS_DIR, ICONS, AXES, OUTING_STEPS, ANCHORS, QUIZ_COUNT, loadCorpus, validateCorpus, textLength };
