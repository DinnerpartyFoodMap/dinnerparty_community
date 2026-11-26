import React, { useCallback, useEffect, useRef, useState } from 'react';
import Button from '../components/primitives/Button';
import ActionMenu from '../components/overlay/ActionMenu';
import { useTips } from '../components/feedback/Tips';
import { useConfirm } from '../components/feedback/Confirm';
import { ProfileShell } from '../profile/UserProfilePage';
import { setUserBlocked } from '../api/client';
import { userReportPrefill } from '../feedback/feedbackTypes';
import { t } from '../i18n';
import { fetchRoomDay } from './roomApi';
import { roomBondKey, roomDayNavigation, roomNowEvent, roomRefreshDelay } from './roomViewModel';
import RoomTimeline, { RoomAvatar } from './RoomTimeline';
import { MomentsPanel, minutesInto } from './CompanionRoom';
import './companion.css';

/**
 * 别人的小伙伴（/users/<id>/room，只读）：大头照、名字、主人、性格和小习惯、你们的熟悉程度、时间线、名场面。
 * 不加载对方的 Live2D。看不到时（没起名、只有主人自己可见、关了小伙伴、被封禁、互相屏蔽）统一“没有找到”，不说原因。
 */
export default function OtherRoomPage({ backendUrl, token, userId, onOpenPlace, onOpenRoom, onOpenProfile, onOpenFeedback, onRequireAuth, onBack }) {
    const showTip = useTips();
    const confirm = useConfirm();
    const [day, setDay] = useState(null);
    const [status, setStatus] = useState('loading'); // loading | ready | login | missing | failed
    const [date, setDate] = useState(null);
    const [today, setToday] = useState(null);
    const [filter, setFilter] = useState('all');
    const [moments, setMoments] = useState(false);
    const timer = useRef(0);

    const load = useCallback(async (target) => {
        if (!token) { setStatus('login'); return; }
        try {
            const data = await fetchRoomDay(backendUrl, token, userId, target);
            if (data?.named === false) { setStatus('missing'); return; }
            setDay(data);
            setStatus('ready');
            if (data?.is_today) setToday(data.day);
        } catch (error) {
            setStatus(error.status === 401 ? 'login' : (error.status === 404 ? 'missing' : 'failed'));
        }
    }, [backendUrl, token, userId]);

    useEffect(() => { void load(date); }, [load, date]);

    // 今天：下一条开始时再取；回到前台时也取一次
    useEffect(() => {
        window.clearTimeout(timer.current);
        if (!day?.is_today) return undefined;
        timer.current = window.setTimeout(() => load(date), roomRefreshDelay(day, minutesInto(day.day)));
        const onVisible = () => { if (document.visibilityState === 'visible') void load(date); };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
            window.clearTimeout(timer.current);
            document.removeEventListener('visibilitychange', onVisible);
        };
    }, [day, date, load]);

    const owner = day?.owner || {};
    const block = async () => {
        if (!(await confirm(t('companion:room.blockConfirm'), { destructive: true, confirmLabel: t('companion:room.blockAction') }))) return;
        try {
            await setUserBlocked(backendUrl, token, userId, true);
            showTip(t('companion:room.blocked'));
            onBack?.();
        } catch (error) {
            showTip(t('companion:room.blockFailed', { message: error?.message || error }));
        }
    };

    let body;
    if (status === 'login') {
        body = <div className="fm-room-message">
            <p>{t('companion:room.loginRequired')}</p>
            <Button onClick={onRequireAuth}>{t('companion:room.login')}</Button>
        </div>;
    } else if (status === 'missing') {
        body = <div className="fm-room-message"><p>{t('companion:room.notFound')}</p></div>;
    } else if (status === 'failed') {
        body = <div className="fm-room-message">
            <p>{t('companion:room.loadFailed')}</p>
            <Button variant="secondary" onClick={() => load(date)}>{t('companion:room.retry')}</Button>
        </div>;
    } else if (status === 'ready' && day) {
        const now = roomNowEvent(day);
        const bond = roomBondKey(owner.bond_level);
        const navigation = roomDayNavigation({ day: day.day, today: today || day.day, firstDay: day.first_day });
        body = <>
            <div className="fm-room-visit__menu">
                <ActionMenu label={t('companion:room.menu')} items={[
                    { key: 'report', label: t('companion:room.report'), onClick: () => onOpenFeedback?.(userReportPrefill({ id: userId, username: owner.owner_name || '' })) },
                    { key: 'block', label: t('companion:room.block'), tone: 'danger', onClick: block }
                ]} />
            </div>
            <section className="fm-room-visit">
                <RoomAvatar person={owner} size={96} />
                <h2>{owner.name}</h2>
                {owner.owner_name && <button type="button" className="fm-room-visit__owner" onClick={() => onOpenProfile?.(userId)}>
                    {t('companion:room.ownerOf', { owner: owner.owner_name })}</button>}
                {bond && <p className="fm-room-visit__bond">{t('companion:room.bondWith', { level: t(`companion:room.bond.${bond}`) })}</p>}
                {!!owner.tags?.length && <div className="fm-room-visit__chips" aria-label={t('companion:room.tags')}>
                    {owner.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>}
                {!!owner.quirks?.length && <div className="fm-room-visit__chips" aria-label={t('companion:room.quirks')}>
                    {owner.quirks.map((quirk) => <span key={quirk.id}>{quirk.name}</span>)}
                </div>}
                {now && <p className="fm-room-header__now">{t('companion:room.now', { text: now.action })}</p>}
            </section>
            {day.paused
                ? <p className="fm-room-timeline__empty">{t('companion:room.notFound')}</p>
                : <RoomTimeline day={day} filter={filter} onFilter={setFilter} navigation={navigation}
                    onNavigate={(target) => setDate(target === today ? null : target)} selfId={userId}
                    onOpenPlace={onOpenPlace} onOpenPerson={onOpenRoom} />}
            <Button variant="menu" full onClick={() => setMoments(true)}>{t('companion:room.moments')}</Button>
            <MomentsPanel open={moments} onClose={() => setMoments(false)} backendUrl={backendUrl} token={token} userId={userId} />
        </>;
    } else {
        body = null;
    }

    return <ProfileShell onBack={onBack} title={t('companion:title')}>{body}</ProfileShell>;
}
