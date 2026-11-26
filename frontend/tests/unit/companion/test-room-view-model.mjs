// 小伙伴时间线视图模型：分段、筛选、分组、“现在”、日期范围、刷新时机（RM 前端部分）。
import assert from 'node:assert/strict';
import {
    roomClock, segmentOf, buildRoomTimeline, roomNowEvent, roomDayNavigation, roomRefreshDelay, roomEventLines, showsDuration, roomNameProblem,
    roomBondKey, roomFriends, roomTextProblems, roomTextStatus
} from '../../../src/companion/roomViewModel.js';

const event = (start, extra = {}) => ({ start_min: start, end_min: start + 10, type: 'home', action: `a${start}`, sound: null, detail: null, star: false, ...extra });

// 钟点与分段
assert.equal(roomClock(65), '01:05');
assert.equal(roomClock(1500), '01:00', '过了零点照常写钟点');
assert.equal(segmentOf(600), 'morning');
assert.equal(segmentOf(720), 'afternoon');
assert.equal(segmentOf(1439), 'evening');
assert.equal(segmentOf(1500), 'night');

// 分组：同一次外出连续的几条合成一组，放在第一条所在的段
{
    const outing = { kind: 'outing', id: 7, place: { id: 1, name: '面馆' } };
    const day = { is_today: true, next_at: 1300, events: [
        event(480), event(700, { group: outing }), event(715, { group: outing }), event(730, { group: outing }),
        event(900), event(1460, { anchor: 'sleep', end_min: 1900 })
    ] };
    const view = buildRoomTimeline(day);
    assert.deepEqual(view.segments.map((s) => s.id), ['morning', 'afternoon', 'night']);
    const group = view.segments[0].rows[1];
    assert.equal(group.kind, 'group');
    assert.equal(group.events.length, 3, '跨 12:00 的外出不拆开');
    assert.equal(view.upcoming, true);
    assert.equal(view.empty, null);
    assert.equal(showsDuration(day.events.at(-1)), false, '睡着那条不写时长');
    assert.equal(showsDuration(day.events[0]), true);
}

// 筛选与空状态
{
    const day = { is_today: false, events: [event(500), event(600, { star: 'rare' }), event(700, { type: 'meet', group: { kind: 'meet', id: 3 } })] };
    assert.equal(buildRoomTimeline(day, { filter: 'moments' }).segments[0].rows.length, 1);
    assert.equal(buildRoomTimeline(day, { filter: 'meets' }).segments[0].rows[0].kind, 'group');
    assert.equal(buildRoomTimeline({ is_today: false, events: [event(500)] }, { filter: 'moments' }).empty, 'noMoments');
    assert.equal(buildRoomTimeline({ is_today: false, events: [event(500)] }, { filter: 'meets' }).empty, 'noMeets');
    assert.equal(buildRoomTimeline({ is_today: true, next_at: 900, events: [] }).empty, 'fresh');
    assert.equal(buildRoomTimeline(day).upcoming, false, '看以前的日子不显示“后面的事还没发生”');
}

// 两行文字
assert.deepEqual(roomEventLines({ action: '饭桶点了单', sound: '「好了」', detail: '菜单没翻开' }), { main: '饭桶点了单', sub: '「好了」 菜单没翻开' });
assert.deepEqual(roomEventLines({ action: '饭桶睡着了', sound: null, detail: '' }), { main: '饭桶睡着了', sub: '' });

// 现在：今天最后一条已经开始的
assert.equal(roomNowEvent({ is_today: true, events: [event(500), event(800), event(600)] }).start_min, 800);
assert.equal(roomNowEvent({ is_today: false, events: [event(500)] }), null);

// 日期范围：起名那天和 30 天前取较晚的
assert.deepEqual(roomDayNavigation({ day: '2026-11-25', today: '2026-11-25', firstDay: '2026-11-24' }), { prev: '2026-11-24', next: null, isToday: true });
assert.equal(roomDayNavigation({ day: '2026-11-24', today: '2026-11-25', firstDay: '2026-11-24' }).prev, null);
assert.equal(roomDayNavigation({ day: '2026-10-26', today: '2026-11-25', firstDay: '2026-01-01' }).prev, null, '最多看 30 天前');
assert.equal(roomDayNavigation({ day: '2026-10-27', today: '2026-11-25', firstDay: '2026-01-01' }).prev, '2026-10-26');
assert.equal(roomDayNavigation({ day: '2026-11-24', today: '2026-11-25', firstDay: '2026-11-01' }).next, '2026-11-25');

// 刷新：下一条开始时，夹在 30 秒到 10 分钟
assert.equal(roomRefreshDelay({ is_today: true, next_at: 601 }, 600), 60_000);
assert.equal(roomRefreshDelay({ is_today: true, next_at: 600 }, 600), 30_000);
assert.equal(roomRefreshDelay({ is_today: true, next_at: 900 }, 600), 600_000);
assert.equal(roomRefreshDelay({ is_today: false }, 600), null);

// 名字
assert.equal(roomNameProblem('  ', '饭桶'), 'empty');
assert.equal(roomNameProblem('一二三四五六七八九十一二三', '饭桶'), 'long');
assert.equal(roomNameProblem('😀🍞', '饭桶'), null, '表情算字，不算符号');
assert.equal(roomNameProblem('……！', '饭桶'), 'symbols');
assert.equal(roomNameProblem(' 饭桶 ', '饭桶'), 'default');
assert.equal(roomNameProblem('加我qq', '饭桶'), 'link');
assert.equal(roomNameProblem('小满123456', '饭桶'), 'link');
assert.equal(roomNameProblem('小满', '饭桶'), null);

// 今天还没有事件：起名当天“刚住下”，之后的日子“还没起床”
assert.equal(buildRoomTimeline({ day: '2026-11-25', first_day: '2026-11-25', is_today: true, events: [] }).empty, 'fresh');
assert.equal(buildRoomTimeline({ day: '2026-11-26', first_day: '2026-11-20', is_today: true, events: [] }).empty, 'notUp');
assert.equal(buildRoomTimeline({ day: '2026-11-24', first_day: '2026-11-20', is_today: false, events: [] }).empty, 'nothing');

// 外出组没带店时，组标题取组里第一条带店的事件
{
    const view = buildRoomTimeline({ day: '2026-11-25', events: [
        event(700, { group: { kind: 'outing', id: 1 } }),
        event(710, { group: { kind: 'outing', id: 1 }, place: { id: 9, name: '面馆' } })
    ] });
    assert.deepEqual(view.segments[0].rows[0].group.place, { id: 9, name: '面馆' });
}

// 熟悉的小伙伴：点头之交起、最多 3 只、级别高的在前
assert.equal(roomBondKey(0), 'stranger');
assert.equal(roomBondKey(3), 'oldFriend');
assert.equal(roomBondKey(4), null);
assert.equal(roomBondKey(null), null);
assert.deepEqual(roomFriends({ friends: [
    { user_id: 'a', level: 0 }, { user_id: 'b', level: 1 }, { user_id: 'c', level: 3 }, { user_id: 'd', level: 2 }, { user_id: 'e', level: 1 }
] }).map((friend) => friend.user_id), ['c', 'd', 'b']);
assert.deepEqual(roomFriends(null), []);

// 名字和口头禅的检查：主页只提示没通过的，编辑页标检查中和没通过
assert.equal(roomTextProblems(null), null);
assert.equal(roomTextProblems({ name: { status: 'checking' }, sayings: [{ text: '饿了', status: 'checking' }] }), null);
assert.deepEqual(roomTextProblems({ name: { status: 'self_only' }, sayings: [{ text: '饿了', status: 'self_only' }, { text: '好吃', status: 'visible' }] }),
    { name: true, sayings: 1 });
assert.equal(roomTextStatus({ name: { status: 'checking' } }, 'name'), 'checking');
assert.equal(roomTextStatus({ name: { status: 'visible' } }, 'name'), null);
assert.equal(roomTextStatus({ sayings: [{ text: '饿了', status: 'self_only' }] }, 'saying', '饿了'), 'self_only');
assert.equal(roomTextStatus({ sayings: [{ text: '饿了', status: 'self_only' }] }, 'saying', '好吃'), null);

console.log('Room view model tests passed.');
