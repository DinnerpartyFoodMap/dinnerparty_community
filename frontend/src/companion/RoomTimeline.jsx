import React from 'react';
import Segmented from '../components/forms/Segmented';
import IconButton from '../components/primitives/IconButton';
import { t } from '../i18n';
import { materialIcon } from '../platform/iconRegistry';
import { DEFAULT_COMPANION_AVATAR } from './defaultCompanion';
import {
    ROOM_FILTERS, buildRoomTimeline, roomClock, roomEventLines, showsDuration
} from './roomViewModel';

const builtInAvatar = `${import.meta.env.BASE_URL}${DEFAULT_COMPANION_AVATAR}`;

/** 圆头像：大头照还没有（P2 的额外角色）时用饭桶的 */
export function RoomAvatar({ person, size = 28, onOpen }) {
    const image = <img src={person?.avatar || builtInAvatar} alt="" width={size} height={size} loading="lazy" />;
    if (!onOpen) return <span className="fm-room-avatar" style={{ width: size, height: size }} title={person?.name || ''}>{image}</span>;
    return <button type="button" className="fm-room-avatar fm-room-avatar--button" style={{ width: size, height: size }}
        aria-label={person?.name || ''} onClick={onOpen}>{image}</button>;
}

function EventRow({ event, people, selfId, onOpenPerson }) {
    const { main, sub } = roomEventLines(event);
    const who = (Array.isArray(event.who) ? event.who : []).slice(0, 2);
    return <li className="fm-room-event">
        <div className="fm-room-event__time">
            <span>{roomClock(event.start_min)}</span>
            {showsDuration(event) && <small>{t('companion:room.minutes', { count: event.end_min - event.start_min })}</small>}
        </div>
        <div className="fm-room-event__avatars">
            {who.map((id) => {
                const person = people.get(String(id));
                const other = String(id) !== String(selfId) && onOpenPerson;
                return <RoomAvatar key={id} person={person} onOpen={other ? () => onOpenPerson(id) : null} />;
            })}
        </div>
        <div className="fm-room-event__text">
            <p>{main}{event.star && <span className="fm-room-event__star" aria-label={t('companion:room.star')}> ★</span>}</p>
            {sub && <p className="fm-room-event__sub">{sub}</p>}
        </div>
    </li>;
}

function groupTitle(group, onOpenPlace) {
    const place = group.place?.name
        ? (onOpenPlace && group.place.id != null
            ? <button type="button" className="fm-room-group__place" onClick={() => onOpenPlace(group.place.id)}>{group.place.name}</button>
            : group.place.name)
        : null;
    if (group.kind === 'outing') return <>{t('companion:room.outingGroup', { place: '' })}{place}</>;
    const name = group.partner?.name || '';
    const label = group.kind === 'remote' ? t('companion:room.remoteGroup', { name }) : t('companion:room.tableGroup', { name });
    return <>{label}{place && <> · {place}</>}</>;
}

/**
 * 时间线：日期切换、筛选、按上午 / 下午 / 晚上 / 深夜分段；一次外出、一段剧情归成一组，剧情用竖线连起来。
 * day 是 GET /api/rooms/:userId/day 的响应；selfId 是这只小伙伴主人的 id（点自己的头像没有反应）。
 */
export default function RoomTimeline({ day, filter, onFilter, navigation, onNavigate, selfId, onOpenPlace, onOpenPerson }) {
    const people = new Map((Array.isArray(day?.people) ? day.people : []).map((person) => [String(person.user_id), person]));
    const view = buildRoomTimeline(day, { filter });
    const ownerName = day?.owner?.name || '';
    return <section className="fm-room-timeline" aria-label={t('companion:title')}>
        <div className="fm-room-timeline__bar">
            <IconButton icon={materialIcon('prevDay')} label={t('companion:room.prevDay')} disabled={!navigation?.prev} onClick={() => onNavigate(navigation.prev)} />
            <strong>{navigation?.isToday ? t('companion:room.today') : day?.day}</strong>
            <IconButton icon={materialIcon('nextDay')} label={t('companion:room.nextDay')} disabled={!navigation?.next} onClick={() => onNavigate(navigation.next)} />
        </div>
        <Segmented size="sm" label={t('companion:room.filterLabel')} value={filter} onChange={onFilter}
            options={ROOM_FILTERS.map((id) => [id, t(`companion:room.filter.${id}`)])} />
        {view.empty && <p className="fm-room-timeline__empty">{t(`companion:room.${view.empty}`, { name: ownerName })}</p>}
        {view.segments.map((segment) => <div key={segment.id} className="fm-room-segment">
            <h3>{t(`companion:room.segment.${segment.id}`)}</h3>
            <ul>
                {segment.rows.map((row) => row.kind === 'event'
                    ? <EventRow key={row.key} event={row.event} people={people} selfId={selfId} onOpenPerson={onOpenPerson} />
                    : <li key={row.key} className={`fm-room-group fm-room-group--${row.group.kind}`}>
                        <p className="fm-room-group__title">{groupTitle(row.group, onOpenPlace)}</p>
                        <ul>{row.events.map((event, index) => <EventRow key={index} event={event} people={people} selfId={selfId} onOpenPerson={onOpenPerson} />)}</ul>
                    </li>)}
            </ul>
        </div>)}
        {view.upcoming && <p className="fm-room-timeline__upcoming">{t('companion:room.upcoming')}</p>}
    </section>;
}
