import React, { useCallback, useEffect, useRef, useState } from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import Button from '../components/primitives/Button';
import { t } from '../i18n';
import { fetchRoomCities, fetchRoomDay, fetchRoomMe, fetchRoomMoments, fetchRoomNeighbors } from './roomApi';
import {
    roomBondKey, roomClock, roomDayNavigation, roomEventLines, roomFriends, roomNowEvent, roomRefreshDelay, roomTextProblems
} from './roomViewModel';
import RoomTimeline from './RoomTimeline';
import RoomPeople, { ownerCaption } from './RoomPeople';
import RoomNameFlow from './RoomNameFlow';
import RoomSheetEditor from './RoomSheetEditor';
import { PANEL_BODY } from './roomPanel';

const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 现在离这一天（北京时间 0 点）过了多少分钟；过了零点大于 1440，和事件的时刻同一刻度 */
export function minutesInto(day, now = Date.now()) {
    const start = Date.parse(`${day}T00:00:00Z`);
    return Number.isFinite(start) ? Math.floor((now + BEIJING_OFFSET_MS - start) / 60_000) : 0;
}

export function MomentsPanel({ open, onClose, backendUrl, token, userId }) {
    const [items, setItems] = useState([]);
    const [before, setBefore] = useState(null);
    const [loading, setLoading] = useState(false);
    const load = useCallback(async (cursor) => {
        setLoading(true);
        try {
            const data = await fetchRoomMoments(backendUrl, token, userId, cursor);
            const list = Array.isArray(data?.moments) ? data.moments : [];
            setItems((current) => (cursor ? [...current, ...list] : list));
            setBefore(data?.next_before ?? (list.length >= 30 ? list.at(-1)?.id : null));
        } catch { /* 列表保持原样，可以关掉重开 */ }
        finally { setLoading(false); }
    }, [backendUrl, token, userId]);
    useEffect(() => { if (open) void load(null); }, [open, load]);
    return <ResponsivePanel open={open} onClose={onClose} kind="room-moments" desktop="side-right" mobile="sheet"
        title={t('companion:room.moments')} width="min(480px, 100vw)" bodyStyle={PANEL_BODY}>
        {!loading && !items.length && <p className="fm-room-timeline__empty">{t('companion:room.momentsEmpty')}</p>}
        <ul className="fm-room-moments">
            {items.map((item) => {
                const event = item.event || item;
                const { main, sub } = roomEventLines(event);
                return <li key={item.id}>
                    <small>{item.day} {roomClock(event.start_min ?? item.t)}</small>
                    <p>{main} ★</p>
                    {sub && <p className="fm-room-event__sub">{sub}</p>}
                </li>;
            })}
        </ul>
        {before && <Button variant="secondary" disabled={loading} onClick={() => load(before)}>{t('companion:room.momentsMore')}</Button>}
        <p className="fm-room-form__hint">{t('companion:room.momentsKeep')}</p>
    </ResponsivePanel>;
}

/**
 * 自己的小伙伴：没起名时是起名卡片；起名后是名字、“现在”一行、时间线和名场面。
 * 接口没开放（ROOMS_AUDIENCE 关着，404）时什么都不渲染，页面保持原来的样子。
 */
export default function CompanionRoom({ backendUrl, token, userId, onOpenPlace, onOpenRoom, initialAction = null }) {
    const [me, setMe] = useState(null);
    const [unavailable, setUnavailable] = useState(false);
    const [day, setDay] = useState(null);
    const [date, setDate] = useState(null);
    const [today, setToday] = useState(null);
    const [filter, setFilter] = useState('all');
    const [failed, setFailed] = useState(false);
    const [naming, setNaming] = useState(false);
    const [editing, setEditing] = useState(false);
    const [moments, setMoments] = useState(false);
    const [cities, setCities] = useState([]);
    const [neighbors, setNeighbors] = useState([]);
    const timer = useRef(0);

    const loadMe = useCallback(async () => {
        try {
            setMe(await fetchRoomMe(backendUrl, token));
        } catch (error) {
            if (error.status === 404) setUnavailable(true);
            else setFailed(true);
        }
    }, [backendUrl, token]);

    const loadDay = useCallback(async (target) => {
        try {
            const data = await fetchRoomDay(backendUrl, token, userId, target);
            setDay(data);
            setFailed(false);
            if (data?.is_today) setToday(data.day);
        } catch (error) {
            if (error.status === 404) setUnavailable(true);
            else setFailed(true);
        }
    }, [backendUrl, token, userId]);

    useEffect(() => { void loadMe(); }, [loadMe]);
    // 从 iOS 原生小伙伴页的“起名”“编辑”过来（?room=name|edit）：读到起名状态后直接打开对应表单，只打开一次
    const autoOpened = useRef(false);
    useEffect(() => {
        if (!me || autoOpened.current) return;
        autoOpened.current = true;
        if (initialAction === 'name' && !me.named) setNaming(true);
        if (initialAction === 'edit' && me.named) setEditing(true);
    }, [me, initialAction]);
    useEffect(() => { if (me?.named) void loadDay(date); }, [me?.named, date, loadDay]);
    // 口味像你的小伙伴：起名后取一次（后端按查看者缓存），失败就不显示这一块
    useEffect(() => {
        if (!me?.named) return undefined;
        let alive = true;
        fetchRoomNeighbors(backendUrl, token).then((list) => { if (alive) setNeighbors(list); }).catch(() => {});
        return () => { alive = false; };
    }, [me?.named, backendUrl, token]);
    useEffect(() => {
        if (naming || editing) void fetchRoomCities(backendUrl).then(setCities).catch(() => {});
    }, [naming, editing, backendUrl]);

    // 今天：下一条开始时再取；App 回到前台时也取一次
    useEffect(() => {
        window.clearTimeout(timer.current);
        if (!day?.is_today) return undefined;
        const delay = roomRefreshDelay(day, minutesInto(day.day));
        timer.current = window.setTimeout(() => loadDay(date), delay);
        const onVisible = () => { if (document.visibilityState === 'visible') void loadDay(date); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearTimeout(timer.current);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [day, date, loadDay]);

    if (unavailable) return null;
    if (!me) return failed ? <div className="fm-room-card">
        <p>{t('companion:room.loadFailed')}</p>
        <Button variant="secondary" onClick={() => { setFailed(false); void loadMe(); }}>{t('companion:room.retry')}</Button>
    </div> : null;

    const overlays = <>
        <RoomNameFlow open={naming} onClose={() => setNaming(false)} me={me} cities={cities} backendUrl={backendUrl} token={token}
            onNamed={() => { setNaming(false); setDate(null); void loadMe(); }} />
        <RoomSheetEditor open={editing} onClose={() => setEditing(false)} me={me} cities={cities} backendUrl={backendUrl} token={token}
            onSaved={() => { setEditing(false); void loadMe(); void loadDay(date); }} />
        <MomentsPanel open={moments} onClose={() => setMoments(false)} backendUrl={backendUrl} token={token} userId={userId} />
    </>;

    if (!me.named) return <>
        <section className="fm-room-card">
            <h2>{t('companion:room.nameCardTitle')}</h2>
            <p>{t('companion:room.nameCardBody')}</p>
            <Button onClick={() => setNaming(true)}>{t('companion:room.nameAction')}</Button>
        </section>
        {overlays}
    </>;

    const now = roomNowEvent(day);
    const problems = roomTextProblems(me.texts);
    const friends = roomFriends(day?.owner);
    const navigation = day ? roomDayNavigation({ day: day.day, today: today || day.day, firstDay: day.first_day }) : null;
    return <>
        <section className="fm-room-header">
            <div className="fm-room-header__name">
                <h2>{day?.owner?.name || me.profile?.sheet?.name}</h2>
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>{t('companion:room.edit')}</Button>
            </div>
            {problems && <button type="button" className="fm-room-header__notice" onClick={() => setEditing(true)}>
                {problems.name && <span>{t('companion:room.textNoticeName', { name: me.default_name || '' })}</span>}
                {problems.name && problems.sayings > 0 && ' '}
                {problems.sayings > 0 && <span>{t('companion:room.textNoticeSayings', { count: problems.sayings })}</span>}
            </button>}
            {now && <p className="fm-room-header__now">{t('companion:room.now', { text: now.action })}</p>}
        </section>
        {day?.paused && <p className="fm-room-timeline__empty">{t('companion:room.paused')}</p>}
        {failed && !day && <div className="fm-room-card">
            <p>{t('companion:room.loadFailed')}</p>
            <Button variant="secondary" onClick={() => loadDay(date)}>{t('companion:room.retry')}</Button>
        </div>}
        {day && !day.paused && <RoomTimeline day={day} filter={filter} onFilter={setFilter} navigation={navigation}
            onNavigate={(target) => setDate(target === today ? null : target)} selfId={userId} onOpenPlace={onOpenPlace} onOpenPerson={onOpenRoom} />}
        {day && <Button variant="menu" full onClick={() => setMoments(true)}>{t('companion:room.moments')}</Button>}
        <RoomPeople title={t('companion:room.friends')} people={friends} onOpen={onOpenRoom}
            caption={(friend) => (roomBondKey(friend.level) ? t(`companion:room.bond.${roomBondKey(friend.level)}`) : '')} />
        <RoomPeople title={t('companion:room.neighbors')} people={neighbors} onOpen={onOpenRoom} caption={ownerCaption} />
        {overlays}
    </>;
}
