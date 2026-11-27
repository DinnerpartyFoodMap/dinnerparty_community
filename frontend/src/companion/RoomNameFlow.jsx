import React, { useEffect, useState } from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import Button from '../components/primitives/Button';
import Segmented from '../components/forms/Segmented';
import SelectInput from '../components/forms/SelectInput';
import TextInput from '../components/forms/TextInput';
import { t } from '../i18n';
import { nameRoom } from './roomApi';
import { roomNameProblem } from './roomViewModel';
import { PANEL_BODY } from './roomPanel';

const MOVE_IN_QUESTIONS = 6;

/** 谁能看、互动、城市：起名第 2 步和编辑性格共用 */
export function RoomAudienceFields({ visibility, meets, city, cities, onChange, disabled }) {
    const self = visibility === 'self';
    return <div className="fm-room-form">
        <p className="fm-room-form__lead">{t(self ? 'companion:naming.publicSelf' : 'companion:naming.publicResidents')}</p>
        <div className="fm-room-form__field">
            <span>{t('companion:naming.audience')}</span>
            <Segmented label={t('companion:naming.audience')} value={visibility} disabled={disabled}
                onChange={(value) => onChange({ visibility: value })}
                options={[['residents', t('companion:naming.audienceResidents')], ['self', t('companion:naming.audienceSelf')]]} />
        </div>
        <label className="fm-room-form__switch">
            <span>{t('companion:naming.meets')}</span>
            <input type="checkbox" role="switch" checked={!self && meets} disabled={disabled || self}
                onChange={(event) => onChange({ meets: event.target.checked })} />
        </label>
        <p className="fm-room-form__hint">{t(self ? 'companion:naming.meetsSelfHint' : 'companion:naming.meetsHint')}</p>
        <label className="fm-room-form__field">
            <span>{t('companion:naming.city')}</span>
            <SelectInput value={city || ''} disabled={disabled} onChange={(event) => onChange({ city: event.target.value || null })}>
                <option value="">{t('companion:naming.cityNone')}</option>
                {city && !cities.includes(city) && <option value={city}>{city}</option>}
                {cities.map((name) => <option key={name} value={name}>{name}</option>)}
            </SelectInput>
        </label>
        <p className="fm-room-form__hint">{t('companion:naming.cityHint')}</p>
    </div>;
}

/** 一道题：选项是这个场景的做法，再点一次取消 */
export function RoomQuizQuestion({ item, name, value, onChange, disabled }) {
    return <fieldset className="fm-room-quiz" disabled={disabled}>
        <legend>{t('companion:naming.question', { name, ask: item.ask })}</legend>
        {item.options.map((option) => <button key={option.id} type="button" aria-pressed={value === option.id}
            className={`fm-room-quiz__option${value === option.id ? ' is-selected' : ''}`}
            onClick={() => onChange(value === option.id ? null : option.id)}>{option.text}</button>)}
    </fieldset>;
}

/**
 * 起名（入住）：名字 → 谁能看到 → 前 6 道题（可跳过、可以“以后再答”）。一次提交 POST /api/rooms/me/name。
 * me 是 GET /api/rooms/me；已经填了东西时关面板先确认。panel：覆盖面板的布局和动效（iOS 原生小伙伴页底下打开时全屏、短渐变）。
 */
export default function RoomNameFlow({ open, onClose, me, cities, backendUrl, token, onNamed, panel = null }) {
    const defaultName = me?.default_name || t('companion:defaultName');
    const quiz = (Array.isArray(me?.quiz) ? me.quiz : []).filter((item) => item.n <= MOVE_IN_QUESTIONS);
    const [step, setStep] = useState(0);
    const [name, setName] = useState('');
    const [audience, setAudience] = useState({ visibility: 'residents', meets: true, city: null });
    const [answers, setAnswers] = useState({});
    const [question, setQuestion] = useState(0);
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!open) return;
        setStep(0); setName(''); setAnswers({}); setQuestion(0); setConfirmDiscard(false); setError('');
        setAudience({ visibility: 'residents', meets: true, city: me?.profile?.city || null });
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const problem = roomNameProblem(name, defaultName);
    const dirty = !!name.trim() || Object.keys(answers).length > 0 || step > 0;
    const close = () => {
        if (saving) return;
        if (dirty && !confirmDiscard) setConfirmDiscard(true);
        else onClose();
    };

    async function finish() {
        if (saving) return;
        setSaving(true);
        setError('');
        try {
            const result = await nameRoom(backendUrl, token, {
                name: name.trim(), visibility: audience.visibility, meets: audience.visibility === 'self' ? false : audience.meets,
                city: audience.city, answers
            });
            onNamed(result);
        } catch (failure) {
            setError(failure.message || t('companion:naming.failed'));
        } finally {
            setSaving(false);
        }
    }

    const item = quiz[question];
    let body;
    let footer;
    if (confirmDiscard) {
        body = <p className="fm-room-form__lead">{t('companion:naming.discardTitle')}</p>;
        footer = <>
            <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>{t('companion:naming.keep')}</Button>
            <Button variant="destructive" onClick={onClose}>{t('companion:naming.discard')}</Button>
        </>;
    } else if (step === 0) {
        body = <div className="fm-room-form">
            <label className="fm-room-form__field">
                <span>{t('companion:naming.stepName')}</span>
                <TextInput value={name} maxLength={40} placeholder={t('companion:naming.namePlaceholder')} autoFocus
                    aria-invalid={!!name.trim() && !!problem || undefined}
                    onChange={(event) => setName(event.target.value)} />
            </label>
            <p className="fm-room-form__hint">{name.trim() && problem
                ? t(`companion:naming.errors.${problem}`, { name: defaultName })
                : t('companion:naming.nameHint')}</p>
        </div>;
        footer = <Button disabled={!!problem} onClick={() => setStep(1)}>{t('companion:naming.next')}</Button>;
    } else if (step === 1) {
        body = <RoomAudienceFields {...audience} cities={cities} onChange={(patch) => setAudience((current) => ({ ...current, ...patch }))} />;
        footer = <>
            <Button variant="secondary" onClick={() => setStep(0)}>{t('companion:naming.back')}</Button>
            <Button onClick={() => (quiz.length ? setStep(2) : finish())} disabled={saving}>{t('companion:naming.next')}</Button>
        </>;
    } else {
        const last = question >= quiz.length - 1;
        body = item ? <div className="fm-room-form">
            <p className="fm-room-form__hint">{t('companion:naming.progress', { index: question + 1, total: quiz.length })}</p>
            <RoomQuizQuestion item={item} name={name.trim()} value={answers[item.situation] || null} disabled={saving}
                onChange={(value) => setAnswers((current) => {
                    const next = { ...current };
                    if (value) next[item.situation] = value; else delete next[item.situation];
                    return next;
                })} />
        </div> : null;
        footer = <>
            <Button variant="secondary" disabled={saving} onClick={() => (question ? setQuestion(question - 1) : setStep(1))}>
                {t(question ? 'companion:naming.prevQuestion' : 'companion:naming.back')}</Button>
            {!last && <Button variant="secondary" disabled={saving} onClick={() => setQuestion(question + 1)}>{t('companion:naming.skipQuestion')}</Button>}
            {last
                ? <Button disabled={saving} onClick={finish}>{t(saving ? 'companion:naming.saving' : 'companion:naming.finish')}</Button>
                : <Button disabled={saving || !answers[item?.situation]} onClick={() => setQuestion(question + 1)}>{t('companion:naming.next')}</Button>}
        </>;
    }

    const titles = ['stepName', 'stepAudience', 'stepQuiz'];
    return <ResponsivePanel open={open} onClose={close} kind="room-naming" desktop="center" mobile="sheet"
        title={t(`companion:naming.${titles[step]}`)} width="min(520px, calc(100vw - 24px))" bodyStyle={PANEL_BODY}
        headerExtra={step === 2 && !confirmDiscard
            ? <Button variant="plain" disabled={saving} onClick={finish}>{t('companion:naming.later')}</Button> : null}
        footer={<div className="fm-room-form__actions">{footer}</div>} {...panel}>
        {body}
        {error && <p className="fm-room-form__error" role="alert">{error}</p>}
    </ResponsivePanel>;
}
