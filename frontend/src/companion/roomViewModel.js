// 小伙伴时间线的视图模型（纯函数）：分段、筛选、把一次外出 / 一段剧情归成一组、“现在”一行、日期范围。
// 网页 CompanionRoom 与 iOS 原生小伙伴页（经 buildCompanionViewModel 交给 Swift）共用。
// 输入是 GET /api/rooms/:userId/day 的响应；时刻是当天分钟数，过了零点大于 1440（仍算这一天，排在最后）。

export const ROOM_FILTERS = Object.freeze(['all', 'moments', 'meets']);
export const ROOM_SEGMENTS = Object.freeze([
    { id: 'morning', until: 720 },
    { id: 'afternoon', until: 1080 },
    { id: 'evening', until: 1440 },
    { id: 'night', until: Infinity }
]);
const DAY_MS = 86_400_000;
const HISTORY_DAYS = 30;

const pad = (value) => String(value).padStart(2, '0');

/** 当天分钟数 → “HH:MM”（过了零点照常写钟点，深夜段的标题已经说明） */
export function roomClock(minute) {
    const value = ((Math.round(Number(minute) || 0) % 1440) + 1440) % 1440;
    return `${pad(Math.floor(value / 60))}:${pad(value % 60)}`;
}

export function segmentOf(minute) {
    return ROOM_SEGMENTS.find((segment) => minute < segment.until).id;
}

const isMeet = (event) => event.type === 'meet' || event.type === 'bond';

function matches(event, filter) {
    if (filter === 'moments') return !!event.star;
    if (filter === 'meets') return isMeet(event);
    return true;
}

/** 一条事件的两行文字：正文是动作；下面一行是说的话和细节 */
export function roomEventLines(event) {
    return {
        main: event.action || '',
        sub: [event.sound, event.detail].filter((text) => typeof text === 'string' && text.trim()).join(' ')
    };
}

/** 睡着那一条不写时长（它跨到第二天早上） */
export function showsDuration(event) {
    return event.anchor !== 'sleep' && event.type !== 'sleep' && Number.isFinite(event.end_min) && event.end_min > event.start_min;
}

function groupKey(event) {
    const group = event.group;
    return group && group.id != null ? `${group.kind}:${group.id}` : null;
}

/**
 * 分段后的行：连续、属于同一组（一次外出、一段剧情）的事件合成一行 { kind: 'group', group, events }，
 * 其余是 { kind: 'event', event }。一组放在它第一条所在的段里，不跨段拆开。
 */
export function buildRoomTimeline(day, { filter = 'all' } = {}) {
    const events = (Array.isArray(day?.events) ? day.events : [])
        .filter((event) => event && Number.isFinite(event.start_min))
        .sort((a, b) => a.start_min - b.start_min)
        .filter((event) => matches(event, ROOM_FILTERS.includes(filter) ? filter : 'all'));
    const rows = [];
    for (const event of events) {
        const key = groupKey(event);
        const last = rows.at(-1);
        if (key && last?.kind === 'group' && last.key === key) last.events.push(event);
        else if (key) rows.push({ kind: 'group', key, group: event.group, events: [event] });
        else rows.push({ kind: 'event', key: `${event.start_min}:${rows.length}`, event });
    }
    // 组标题要店名：组本身没带 place 时取组里第一条带店的事件
    for (const row of rows) {
        if (row.kind === 'group' && !row.group.place) {
            const place = row.events.find((event) => event.place?.name)?.place;
            if (place) row.group = { ...row.group, place };
        }
    }
    const segments = [];
    for (const row of rows) {
        const first = row.kind === 'group' ? row.events[0] : row.event;
        const id = segmentOf(first.start_min);
        if (segments.at(-1)?.id !== id) segments.push({ id, rows: [] });
        segments.at(-1).rows.push(row);
    }
    let empty = null;
    if (!segments.length) {
        if (filter === 'moments') empty = 'noMoments';
        else if (filter === 'meets') empty = 'noMeets';
        // 今天还什么都没发生：起名当天是“刚住下”，其他日子是还没起床
        else if (day?.is_today) empty = day.first_day && day.day !== day.first_day ? 'notUp' : 'fresh';
        else empty = 'nothing';
    }
    return { segments, empty, upcoming: !!day?.is_today && day?.next_at != null };
}

/** 现在在做的事：今天最后一条已经开始的事件 */
export function roomNowEvent(day) {
    if (!day?.is_today) return null;
    const events = (Array.isArray(day.events) ? day.events : []).filter((event) => Number.isFinite(event.start_min));
    return events.reduce((latest, event) => (!latest || event.start_min >= latest.start_min ? event : latest), null);
}

function shiftDay(day, offset) {
    const time = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(time) ? new Date(time + offset * DAY_MS).toISOString().slice(0, 10) : null;
}

/** 能不能往前、往后翻：最早到起名那天或 30 天前（取较晚的），最晚到今天 */
export function roomDayNavigation({ day, today, firstDay }) {
    const oldest = [firstDay, shiftDay(today, -HISTORY_DAYS)].filter(Boolean).sort().at(-1);
    const prev = shiftDay(day, -1);
    const next = shiftDay(day, 1);
    return {
        prev: prev && oldest && prev >= oldest ? prev : null,
        next: next && today && next <= today ? next : null,
        isToday: day === today
    };
}

/** 刷新时机：下一条开始时（不早于 30 秒、不晚于 10 分钟后）；nowMinute 是当天分钟数 */
export function roomRefreshDelay(day, nowMinute) {
    if (!day?.is_today) return null;
    const wait = day.next_at == null ? 10 * 60_000 : (day.next_at - nowMinute) * 60_000;
    return Math.min(10 * 60_000, Math.max(30_000, wait));
}

/** 名字的本地检查（后端同样的规则是准的，这里只为及时提示）：返回 errors 键或 null */
export function roomNameProblem(value, defaultName) {
    const name = String(value || '').trim();
    const length = Array.from(name).length;
    if (!length) return 'empty';
    if (length > 12) return 'long';
    // 全是标点和数学、货币、修饰符号的不行；表情（So）算正常的字
    if (/^[\p{P}\p{Sm}\p{Sc}\p{Sk}\s]+$/u.test(name)) return 'symbols';
    if (defaultName && name === defaultName) return 'default';
    if (/https?:|www\.|\.(com|cn|net|org|cc|top|xyz)\b|\d{6,}|qq|微信|vx|wx|v信/i.test(name)) return 'link';
    return null;
}

/** 熟悉度级别 0–3 → 文案键（生面孔不列出，见“熟悉的小伙伴”） */
export const ROOM_BOND_LEVELS = Object.freeze(['stranger', 'nodding', 'buddy', 'oldFriend']);

export function roomBondKey(level) {
    // 没互动过（null）不显示熟悉程度
    if (level === null || level === undefined || level === '') return null;
    const value = Number(level);
    return Number.isInteger(value) && value >= 0 && value < ROOM_BOND_LEVELS.length ? ROOM_BOND_LEVELS[value] : null;
}

/** 熟悉的小伙伴：点头之交以上、最多 3 只，按级别从高到低 */
export function roomFriends(owner) {
    const list = Array.isArray(owner?.friends) ? owner.friends : [];
    return list.filter((friend) => friend?.user_id != null && Number(friend.level) >= 1 && roomBondKey(friend.level))
        .sort((a, b) => Number(b.level) - Number(a.level))
        .slice(0, 3);
}

/**
 * 名字和口头禅的检查（GET /api/rooms/me 的 texts）：主页名字下方的提示。
 * 只提示没通过的；检查中只在编辑页标出。返回 null 或 { name: bool, sayings: 没通过的句数 }
 */
export function roomTextProblems(texts) {
    const name = texts?.name?.status === 'self_only';
    const sayings = (Array.isArray(texts?.sayings) ? texts.sayings : []).filter((item) => item?.status === 'self_only').length;
    return name || sayings ? { name, sayings } : null;
}

/** 编辑页里一段文字的检查状态：checking | self_only | null（通过或还没保存过） */
export function roomTextStatus(texts, field, value) {
    if (field === 'name') {
        const status = texts?.name?.status;
        return status === 'checking' || status === 'self_only' ? status : null;
    }
    const item = (Array.isArray(texts?.sayings) ? texts.sayings : []).find((saying) => saying?.text === value);
    return item?.status === 'checking' || item?.status === 'self_only' ? item.status : null;
}
