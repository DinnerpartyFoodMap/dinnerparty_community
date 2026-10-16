import React from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import { t } from '../i18n/index.js';

/** 「日记 · 同好」入口：纵向大点击区，依次为图文生成、日历、同好，底部独立取消。 */
export default function JourneyEntrySheet({open,counts,onSelect,onClose}) {
    const material=counts?.material||0,unfinished=counts?.count||0;
    const items=[
        {id:'composer',icon:'✦',title:t('journey:common.feature.generate'),hint:material?t('journey:entry.composerHintUnfinished', { material }):t('journey:entry.composerHint')},
        {id:'calendar',icon:'▦',title:t('journey:common.feature.calendar'),hint:t('journey:entry.calendarHint'),badge:unfinished?t('journey:entry.calendarBadge', { unfinished }):''},
        {id:'community',icon:'◎',title:t('journey:common.feature.community'),hint:t('journey:entry.communityHint')}
    ];
    return <ResponsivePanel open={open} onClose={onClose} label={t('journey:entry.title')} kind="journey-entry" desktop="center" mobile="sheet" showClose={false}
        width="min(380px, calc(100vw - 24px))" bodyStyle={{padding:0}}>
        <div className="jw-entry-sheet" role="menu" aria-label={t('journey:entry.title')}>
            {items.map(item=><button type="button" role="menuitem" key={item.id} className="jw-entry-sheet__item" onClick={()=>onSelect(item.id)}>
                <span className="jw-entry-sheet__icon" aria-hidden="true">{item.icon}</span>
                <span className="jw-entry-sheet__text"><strong>{item.title}</strong><small>{item.hint}</small></span>
                {item.badge&&<span className="jw-badge jw-badge--warn">{item.badge}</span>}
            </button>)}
            <button type="button" className="jw-entry-sheet__cancel" onClick={onClose}>{t('common:action.cancel')}</button>
        </div>
    </ResponsivePanel>;
}
