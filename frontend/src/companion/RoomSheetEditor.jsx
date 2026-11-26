import React, { useEffect, useMemo, useState } from 'react';
import ResponsivePanel from '../components/overlay/ResponsivePanel';
import Button from '../components/primitives/Button';
import Chip from '../components/primitives/Chip';
import TextInput from '../components/forms/TextInput';
import { useTips } from '../components/feedback/Tips';
import { t } from '../i18n';
import { saveRoom } from './roomApi';
import { roomNameProblem, roomTextStatus } from './roomViewModel';
import { RoomAudienceFields, RoomQuizQuestion } from './RoomNameFlow';
import { PANEL_BODY } from './roomPanel';

const MAX_TAGS = 10;
const MAX_QUIRKS = 3;
const MAX_SAYINGS = 3;

function initialForm(me) {
    const sheet = me?.profile?.sheet || {};
    return {
        name: sheet.name || '',
        tags: [...(sheet.tags || [])],
        untagged: [...(sheet.untagged || [])],
        answers: { ...(sheet.answers || {}) },
        quirks: [...(sheet.quirks || [])],
        sayings: [...(sheet.sayings || [])],
        visibility: me?.profile?.visibility || 'residents',
        meets: me?.profile?.meets !== false && me?.profile?.meets !== 0,
        city: me?.profile?.city || null
    };
}

const sayingOk = (text) => {
    const value = String(text || '').trim();
    const length = Array.from(value).length;
    return length >= 1 && length <= 8 && !/[「」\n]/.test(value);
};

/**
 * 编辑性格（全屏面板）：名字、标签、20 道题、小习惯、口头禅、谁能看到。保存 PUT /api/rooms/me；
 * 有未保存的修改时关面板先确认。
 */
export default function RoomSheetEditor({ open, onClose, me, cities, backendUrl, token, onSaved }) {
    const showTip = useTips();
    const [form, setForm] = useState(() => initialForm(me));
    const [initial, setInitial] = useState(() => JSON.stringify(initialForm(me)));
    const [confirmDiscard, setConfirmDiscard] = useState(false);
    const [saving, setSaving] = useState(false);
    const [errors, setErrors] = useState([]);

    useEffect(() => {
        if (!open) return;
        const next = initialForm(me);
        setForm(next);
        setInitial(JSON.stringify(next));
        setConfirmDiscard(false);
        setErrors([]);
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    const defaultName = me?.default_name || t('companion:defaultName');
    const groups = Array.isArray(me?.tags?.groups) ? me.tags.groups : [];
    const exclusive = Array.isArray(me?.tags?.exclusive) ? me.tags.exclusive : [];
    const inferred = useMemo(() => new Set((me?.suggestions?.tags || []).map((item) => item.tag)), [me]);
    const dirty = JSON.stringify(form) !== initial;
    const nameProblem = roomNameProblem(form.name, defaultName);
    // 检查状态只对已经保存过的那个名字有意义；改了还没保存的不标
    const nameStatus = form.name.trim() === (me?.profile?.sheet?.name || '') ? roomTextStatus(me?.texts, 'name') : null;
    const sayingsOk = form.sayings.every(sayingOk);
    const patch = (values) => setForm((current) => ({ ...current, ...values }));

    function toggleTag(tag) {
        setForm((current) => {
            if (current.tags.includes(tag)) {
                return { ...current, tags: current.tags.filter((item) => item !== tag),
                    untagged: inferred.has(tag) && !current.untagged.includes(tag) ? [...current.untagged, tag] : current.untagged };
            }
            const partner = exclusive.find((pair) => pair.includes(tag))?.find((item) => item !== tag);
            const tags = partner ? current.tags.filter((item) => item !== partner) : current.tags;
            if (tags.length >= MAX_TAGS) {
                showTip(t('companion:editor.tagsMax'));
                return current;
            }
            return { ...current, tags: [...tags, tag], untagged: current.untagged.filter((item) => item !== tag) };
        });
    }

    function toggleQuirk(id) {
        setForm((current) => {
            if (current.quirks.includes(id)) return { ...current, quirks: current.quirks.filter((item) => item !== id) };
            if (current.quirks.length >= MAX_QUIRKS) {
                showTip(t('companion:editor.quirksMax'));
                return current;
            }
            return { ...current, quirks: [...current.quirks, id] };
        });
    }

    const close = () => {
        if (saving) return;
        if (dirty && !confirmDiscard) setConfirmDiscard(true);
        else onClose();
    };

    async function save() {
        if (saving || nameProblem || !sayingsOk) return;
        setSaving(true);
        setErrors([]);
        try {
            const { visibility, meets, city, ...sheet } = form;
            const result = await saveRoom(backendUrl, token, {
                sheet: { ...sheet, name: sheet.name.trim(), sayings: sheet.sayings.map((text) => text.trim()) },
                visibility, meets: visibility === 'self' ? false : meets, city
            });
            showTip(t('companion:editor.saved'));
            onSaved(result);
        } catch (failure) {
            setErrors(failure.errors?.length ? failure.errors : [failure.message || t('companion:editor.failed')]);
        } finally {
            setSaving(false);
        }
    }

    const body = confirmDiscard
        ? <p className="fm-room-form__lead">{t('companion:editor.discardTitle')}</p>
        : <div className="fm-room-form fm-room-editor">
            <section>
                <h3>{t('companion:editor.name')}</h3>
                <TextInput value={form.name} maxLength={40} aria-invalid={!!nameProblem || undefined}
                    onChange={(event) => patch({ name: event.target.value })} />
                <p className="fm-room-form__hint">{nameProblem
                    ? t(`companion:naming.errors.${nameProblem}`, { name: defaultName })
                    : (nameStatus ? t(`companion:editor.nameStatus.${nameStatus}`, { name: defaultName }) : t('companion:naming.nameHint'))}</p>
            </section>
            <section>
                <h3>{t('companion:editor.tags')} <small>{t('companion:editor.tagsHint')}</small></h3>
                {groups.map((group) => <div key={group.id} className="fm-room-editor__group">
                    <p className="fm-room-form__hint">{group.name}</p>
                    <div className="fm-room-editor__chips">
                        {group.tags.map((tag) => <Chip key={tag} selected={form.tags.includes(tag)} aria-pressed={form.tags.includes(tag)}
                            onClick={() => toggleTag(tag)}>{tag}</Chip>)}
                    </div>
                </div>)}
                {form.tags.some((tag) => inferred.has(tag)) && <p className="fm-room-form__hint">
                    {form.tags.filter((tag) => inferred.has(tag)).join('、')}：{t('companion:editor.inferred')}</p>}
            </section>
            <section>
                <h3>{t('companion:editor.quiz')}</h3>
                {(me?.quiz || []).map((item) => <RoomQuizQuestion key={item.n} item={item} name={form.name.trim() || defaultName}
                    value={form.answers[item.situation] || null}
                    onChange={(value) => setForm((current) => {
                        const answers = { ...current.answers };
                        if (value) answers[item.situation] = value; else delete answers[item.situation];
                        return { ...current, answers };
                    })} />)}
            </section>
            <section>
                <h3>{t('companion:editor.quirks')}</h3>
                <div className="fm-room-editor__chips">
                    {(me?.quirks || []).map((quirk) => <Chip key={quirk.id} selected={form.quirks.includes(quirk.id)}
                        aria-pressed={form.quirks.includes(quirk.id)} onClick={() => toggleQuirk(quirk.id)}>{quirk.name}</Chip>)}
                </div>
                {!form.quirks.length && <p className="fm-room-form__hint">{t('companion:editor.quirksHint')}</p>}
            </section>
            <section>
                <h3>{t('companion:editor.sayings')}</h3>
                {form.sayings.map((text, index) => <div key={index} className="fm-room-editor__saying">
                    <TextInput value={text} maxLength={16} placeholder={t('companion:editor.sayingPlaceholder')}
                        aria-invalid={!sayingOk(text) || undefined}
                        onChange={(event) => patch({ sayings: form.sayings.map((item, at) => (at === index ? event.target.value : item)) })} />
                    {roomTextStatus(me?.texts, 'saying', text.trim()) && <small className="fm-room-editor__status">
                        {t(`companion:editor.sayingStatus.${roomTextStatus(me?.texts, 'saying', text.trim())}`)}</small>}
                    <Button variant="plain" onClick={() => patch({ sayings: form.sayings.filter((_, at) => at !== index) })}>
                        {t('companion:editor.removeSaying')}</Button>
                </div>)}
                {form.sayings.length < MAX_SAYINGS && <Button variant="secondary" size="sm" onClick={() => patch({ sayings: [...form.sayings, ''] })}>
                    {t('companion:editor.addSaying')}</Button>}
                <p className="fm-room-form__hint">{sayingsOk ? t('companion:editor.sayingsHint') : t('companion:editor.sayingInvalid')}</p>
                {Number.isFinite(me?.text_saves_left) && <p className="fm-room-form__hint">
                    {t('companion:editor.textSavesLeft', { count: me.text_saves_left })}</p>}
            </section>
            <section>
                <h3>{t('companion:naming.stepAudience')}</h3>
                <RoomAudienceFields visibility={form.visibility} meets={form.meets} city={form.city} cities={cities} onChange={patch} />
            </section>
        </div>;

    return <ResponsivePanel open={open} onClose={close} kind="room-editor" desktop="side-right" mobile="full"
        title={t('companion:editor.title')} width="min(560px, 100vw)" bodyStyle={PANEL_BODY}
        headerExtra={confirmDiscard ? null : <Button variant="plain" disabled={!dirty || saving || !!nameProblem || !sayingsOk} onClick={save}>
            {t(saving ? 'companion:editor.saving' : 'companion:editor.save')}</Button>}
        footer={confirmDiscard ? <div className="fm-room-form__actions">
            <Button variant="secondary" onClick={() => setConfirmDiscard(false)}>{t('companion:editor.keep')}</Button>
            <Button variant="destructive" onClick={onClose}>{t('companion:editor.discard')}</Button>
        </div> : (errors.length ? <ul className="fm-room-form__error" role="alert">{errors.map((text, index) => <li key={index}>{text}</li>)}</ul> : null)}>
        {body}
    </ResponsivePanel>;
}
