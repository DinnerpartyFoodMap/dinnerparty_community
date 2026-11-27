// iOS 原生小伙伴页里“一天”那部分的快照：网页取数、算好分段和每一行的文字，Swift 只照着画。
// 字段都是字符串、布尔和数组，原生不需要再知道时间线的规则（分段、分组、空状态都在 roomViewModel.js）。
import { t } from '../i18n/index.js';
import {
    ROOM_FILTERS, buildRoomTimeline, roomBondKey, roomClock, roomDayNavigation, roomEventLines, roomFriends, roomNowEvent,
    roomTextProblems, showsDuration
} from './roomViewModel.js';
import { DEFAULT_COMPANION_AVATAR } from './defaultCompanion.js';

// 文案键都写成字面量（i18n 检查要能看到每个键）
const SEGMENT_LABELS = {
    morning: () => t('companion:room.segment.morning'),
    afternoon: () => t('companion:room.segment.afternoon'),
    evening: () => t('companion:room.segment.evening'),
    night: () => t('companion:room.segment.night')
};
const EMPTY_LABELS = {
    fresh: (name) => t('companion:room.fresh', { name }),
    notUp: (name) => t('companion:room.notUp', { name }),
    nothing: () => t('companion:room.nothing'),
    noMoments: () => t('companion:room.noMoments'),
    noMeets: () => t('companion:room.noMeets')
};
const FILTER_LABELS = {
    all: () => t('companion:room.filter.all'),
    moments: () => t('companion:room.filter.moments'),
    meets: () => t('companion:room.filter.meets')
};
const BOND_LABELS = {
    stranger: () => t('companion:room.bond.stranger'),
    nodding: () => t('companion:room.bond.nodding'),
    buddy: () => t('companion:room.bond.buddy'),
    oldFriend: () => t('companion:room.bond.oldFriend')
};
const bondLabel = (level) => BOND_LABELS[roomBondKey(level)]?.() || '';

function groupTitle(group) {
    if (group.kind === 'outing') return t('companion:room.outingGroup', { place: group.place?.name || '' });
    const name = group.partner?.name || '';
    const base = group.kind === 'remote' ? t('companion:room.remoteGroup', { name }) : t('companion:room.tableGroup', { name });
    return group.place?.name ? `${base} · ${group.place.name}` : base;
}

function eventRow(event, people, grouped) {
    const { main, sub } = roomEventLines(event);
    return {
        kind: 'event',
        time: roomClock(event.start_min),
        duration: showsDuration(event) ? t('companion:room.minutes', { count: event.end_min - event.start_min }) : '',
        text: main,
        sub,
        star: !!event.star,
        grouped,
        avatars: (Array.isArray(event.who) ? event.who : []).slice(0, 2).map((id) => {
            const person = people.get(String(id));
            return { userId: String(id), name: person?.name || '', image: person?.avatar || DEFAULT_COMPANION_AVATAR };
        })
    };
}

const personRow = (person, caption) => ({
    userId: String(person.user_id),
    name: person.name || '',
    caption: caption || '',
    image: person.avatar || DEFAULT_COMPANION_AVATAR
});

/** 时间线部分（自己的、别人的共用）：分段后的行、日期、筛选、空状态 */
function timelineFields(day, { filter, today, ownerName }) {
    const people = new Map((Array.isArray(day?.people) ? day.people : []).map((person) => [String(person.user_id), person]));
    const view = buildRoomTimeline(day, { filter });
    const rows = [];
    for (const segment of view.segments) {
        rows.push({ kind: 'segment', title: SEGMENT_LABELS[segment.id]?.() || '' });
        for (const row of segment.rows) {
            if (row.kind === 'event') rows.push(eventRow(row.event, people, false));
            else {
                rows.push({ kind: 'group', title: groupTitle(row.group), placeId: row.group.place?.id != null ? String(row.group.place.id) : '' });
                for (const event of row.events) rows.push(eventRow(event, people, true));
            }
        }
    }
    const navigation = day ? roomDayNavigation({ day: day.day, today: today || day.day, firstDay: day.first_day }) : null;
    const now = roomNowEvent(day);
    return {
        now: now ? t('companion:room.now', { text: now.action }) : '',
        date: day?.day || '',
        dayLabel: navigation?.isToday ? t('companion:room.today') : (day?.day || ''),
        prev: navigation?.prev || '',
        next: navigation?.next || '',
        filter,
        rows,
        empty: view.empty ? EMPTY_LABELS[view.empty]?.(ownerName) || '' : '',
        upcoming: view.upcoming ? t('companion:room.upcoming') : ''
    };
}

function timelineLabels() {
    return {
        edit: t('companion:room.edit'),
        prevDay: t('companion:room.prevDay'),
        nextDay: t('companion:room.nextDay'),
        moments: t('companion:room.moments'),
        retry: t('companion:room.retry'),
        filters: ROOM_FILTERS.map((id) => ({ id, label: FILTER_LABELS[id]() }))
    };
}

/**
 * 别人的小伙伴（原生里推入的只读页）。state: { status: loading|ready|missing|failed, day, filter, today }
 * 看不到时（404）只给“没有找到这个小伙伴”，不说原因。
 */
export function buildOtherRoomNativeModel({ status = 'loading', day = null, filter = 'all', today = null } = {}) {
    const labels = {
        ...timelineLabels(),
        menu: t('companion:room.menu'),
        report: t('companion:room.report'),
        block: t('companion:room.block'),
        blockConfirm: t('companion:room.blockConfirm'),
        blockAction: t('companion:room.blockAction'),
        cancel: t('common:action.cancel'),
        title: t('companion:title')
    };
    if (status === 'missing') return { loaded: true, missing: t('companion:room.notFound'), labels };
    if (status === 'failed' && !day) return { loaded: true, error: t('companion:room.loadFailed'), labels };
    if (!day) return { loaded: false, labels };
    const owner = day.owner || {};
    const bond = roomBondKey(owner.bond_level);
    return {
        loaded: true,
        labels,
        name: owner.name || '',
        avatar: owner.avatar || DEFAULT_COMPANION_AVATAR,
        ownerLine: owner.owner_name ? t('companion:room.ownerOf', { owner: owner.owner_name }) : '',
        ownerName: owner.owner_name || '',
        bond: bond ? t('companion:room.bondWith', { level: bondLabel(owner.bond_level) }) : '',
        tags: (Array.isArray(owner.tags) ? owner.tags : []).map(String).slice(0, 10),
        quirks: (Array.isArray(owner.quirks) ? owner.quirks : []).map((quirk) => String(quirk?.name || '')).filter(Boolean).slice(0, 3),
        paused: day.paused ? t('companion:room.notFound') : '',
        ...timelineFields(day.paused ? null : day, { filter, today, ownerName: owner.name || '' })
    };
}

/**
 * state: { available, failed, me, day, filter, today, neighbors }。available 为假（接口没开放）时原生只显示原来的页面。
 * 返回 { available, named, ... }；没起名时带起名卡片的文字。
 */
export function buildRoomNativeModel({ available = true, failed = false, me = null, day = null, filter = 'all', today = null, neighbors = [] } = {}) {
    const labels = {
        ...timelineLabels(),
        friends: t('companion:room.friends'),
        neighbors: t('companion:room.neighbors')
    };
    if (!available) return { available: false };
    if (!me) return { available: true, loaded: false, error: failed ? t('companion:room.loadFailed') : '', labels };
    if (!me.named) {
        return {
            available: true, loaded: true, named: false, labels,
            card: { title: t('companion:room.nameCardTitle'), body: t('companion:room.nameCardBody'), action: t('companion:room.nameAction') }
        };
    }
    const ownerName = day?.owner?.name || me.profile?.sheet?.name || '';
    const problems = roomTextProblems(me.texts);
    const notice = problems ? [
        problems.name ? t('companion:room.textNoticeName', { name: me.default_name || '' }) : '',
        problems.sayings ? t('companion:room.textNoticeSayings', { count: problems.sayings }) : ''
    ].filter(Boolean).join(' ') : '';
    return {
        available: true, loaded: !!day, named: true, labels,
        error: failed && !day ? t('companion:room.loadFailed') : '',
        name: ownerName,
        notice,
        paused: day?.paused ? t('companion:room.paused') : '',
        friends: roomFriends(day?.owner).map((friend) => personRow(friend, bondLabel(friend.level))),
        neighbors: (Array.isArray(neighbors) ? neighbors : []).slice(0, 5)
            .map((person) => personRow(person, person.owner_name ? t('companion:room.ownerOf', { owner: person.owner_name }) : '')),
        ...timelineFields(day, { filter, today, ownerName })
    };
}
