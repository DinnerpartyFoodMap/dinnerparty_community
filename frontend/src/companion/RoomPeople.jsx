import React from 'react';
import { t } from '../i18n';
import { RoomAvatar } from './RoomTimeline';

/**
 * 一列别的小伙伴（熟悉的小伙伴、口味像你的小伙伴）：头像、名字、一行小字；点了进对方的小伙伴页。
 * 没有人时整块不显示。
 */
export default function RoomPeople({ title, people, caption, onOpen }) {
    if (!people?.length) return null;
    return <section className="fm-room-people" aria-label={title}>
        <h3>{title}</h3>
        <ul>
            {people.map((person) => <li key={person.user_id}>
                <button type="button" className="fm-room-people__item" onClick={() => onOpen?.(person.user_id)}>
                    <RoomAvatar person={person} size={36} />
                    <span>
                        {person.name}
                        {caption(person) && <small>{caption(person)}</small>}
                    </span>
                </button>
            </li>)}
        </ul>
    </section>;
}

export const ownerCaption = (person) => (person.owner_name ? t('companion:room.ownerOf', { owner: person.owner_name }) : '');
