import React, { useEffect, useRef, useState } from 'react';
import Button from "../../components/primitives/Button";
import TextInput from "../../components/forms/TextInput";
import TextArea from "../../components/forms/TextArea";
import PlaceImageInputs from './PlaceImageInputs';
import { useTips } from "../../components/feedback/Tips";
import { useConfirm } from "../../components/feedback/Confirm";
import ScrollableView from "../../components/layout/ScrollableView";
import CategorySelector from "./CategorySelector";
import { t } from "../../i18n/index.js";
import { RATING_TIERS, tierLabel, tierHint } from "../rating";
import { emptyPlaceContent, placeDraftSource, openPlaceDraft, placeContentKey, persistPlaceDraft, discardPlaceDraft } from "../addPlaceDraft";

export default function AddForm({ backendUrl, token, userId, defaultPos, defaultName = "", defaultCategory = "", defaultDescription = "", defaultAddress = "", onCancel, onSubmit }) {
    // 打开时读一次本机草稿（addPlaceDraft.js）：同一来源直接恢复，从另一个高德地点收录时只提示可以恢复
    const [opening] = useState(() => {
        const baseline = emptyPlaceContent({ name: defaultName, category: defaultCategory, description: defaultDescription });
        const source = placeDraftSource({ name: defaultName, address: defaultAddress });
        return { baseline, source, ...openPlaceDraft(userId, baseline, source) };
    });
    const [name, setName] = useState(opening.content.name);
    const [category, setCategory] = useState(opening.content.category);
    const [description, setDescription] = useState(opening.content.description);
    const [exteriorImages, setExteriorImages] = useState(opening.content.exteriorImages);
    const [menuImages, setMenuImages] = useState(opening.content.menuImages);
    const [perPersonCost, setPerPersonCost] = useState(opening.content.perPersonCost);
    // 创建者的评价：必须自己选一档，不预选
    const [chosenRating, setChosenRating] = useState(opening.content.chosenRating);
    const [ratingMissing, setRatingMissing] = useState(false);
    const [draftNotice, setDraftNotice] = useState(opening.restored ? 'restored' : opening.pending ? 'pending' : null);
    const [draftSaved, setDraftSaved] = useState(opening.restored);
    const showTip = useTips();
    const confirm = useConfirm();

    // 每次改动都立即写入本机，面板随时关掉也不丢
    const content = { name, category, description, perPersonCost, chosenRating, exteriorImages, menuImages };
    const contentKey = placeContentKey(content);
    const writtenKeyRef = useRef(placeContentKey(opening.content));
    useEffect(() => {
        if (!userId || contentKey === writtenKeyRef.current) return;
        writtenKeyRef.current = contentKey;
        setDraftSaved(persistPlaceDraft(userId, content, opening.baseline, opening.source));
    }, [userId, contentKey]);

    const applyContent = (next) => {
        setName(next.name);
        setCategory(next.category);
        setDescription(next.description);
        setPerPersonCost(next.perPersonCost);
        setChosenRating(next.chosenRating);
        setExteriorImages(next.exteriorImages);
        setMenuImages(next.menuImages);
    };
    const restoreDraft = () => {
        applyContent(opening.pending);
        setDraftNotice('restored');
    };
    const clearDraft = async () => {
        if (!(await confirm(t('map:addForm.draft.clearConfirm')))) return;
        applyContent(opening.baseline);
        setDraftNotice(null);
    };

    const handle = () => {
        if (!name) { showTip(t('map:addForm.nameRequired')); return; }
        if (chosenRating == null) { setRatingMissing(true); showTip(t('map:addForm.ratingRequired')); return; }
        const payload = {
            name,
            category,
            description,
            // 从高德地点收录时带上地址（单独的字段，不再塞进描述）
            ...(defaultAddress ? { address: defaultAddress } : {}),
            per_person_cost: perPersonCost ? parseInt(perPersonCost, 10) : null,
            rating: chosenRating,
            rating_input_kind: 'explicit',
            exterior_images: exteriorImages.filter(Boolean),
            menu_images: menuImages.filter(Boolean),
            longitude: defaultPos[0],
            latitude: defaultPos[1]
        };
        onSubmit(payload, { onCreated: () => discardPlaceDraft(userId) });
    };

    return (
        <div style={{ width: '100%', boxSizing: 'border-box' }}>
            {draftNotice && (
                <div role="status" style={{ marginBottom: 8, padding: '6px 6px 6px 10px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 'var(--radius-sm)', background: 'color-mix(in srgb, var(--color-info) 12%, var(--color-bg-surface))', fontSize: 13, lineHeight: 1.5, color: 'var(--color-text-secondary)' }}>
                    <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
                        {draftNotice === 'restored'
                            ? t('map:addForm.draft.restored')
                            : opening.pending.name ? t('map:addForm.draft.pendingNamed', { name: opening.pending.name }) : t('map:addForm.draft.pending')}
                    </span>
                    {draftNotice === 'restored'
                        ? <Button themeAware onClick={clearDraft} style={{ padding: '4px 10px', fontSize: 13, flexShrink: 0 }}>{t('map:addForm.draft.clear')}</Button>
                        : <Button themeAware onClick={restoreDraft} style={{ padding: '4px 10px', fontSize: 13, flexShrink: 0 }}>{t('map:addForm.draft.restore')}</Button>}
                </div>
            )}
            <div><strong style={{ color: 'var(--color-text-primary)' }}>{t('map:addForm.coordinates')}</strong><span style={{ color: 'var(--color-text-primary)' }}>{defaultPos[1].toFixed(6)}, {defaultPos[0].toFixed(6)}</span></div>
            {defaultAddress && <div style={{ marginTop: 4 }}><strong style={{ color: 'var(--color-text-primary)' }}>{t('map:addForm.address')}</strong><span style={{ color: 'var(--color-text-secondary)' }}>{defaultAddress}</span></div>}
            <div style={{ marginTop: 8 }}>
                <TextInput placeholder={t('map:addForm.namePlaceholder')} value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} />
            </div>
            <div style={{ marginTop: 8, position: 'relative' }}>
                <CategorySelector
                    backendUrl={backendUrl}
                    token={token}
                    value={category}
                    onChange={setCategory}
                />
            </div>
            <div style={{ marginTop: 8 }}>
                {/* 描述可以写多行，支持基础 Markdown（与后端一致最多 1000 字） */}
                <TextArea markdown rows={3} maxLength={1000} placeholder={t('map:common.label.description')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%", borderRadius: 16, minHeight: 72 }} />
            </div>
            <div style={{ marginTop: 8 }}>
                <TextInput
                    placeholder={t('map:addForm.perPersonCostPlaceholder')}
                    value={perPersonCost}
                    onChange={(e) => {
                        const v = e.target.value;
                        if (v === '' || /^[1-9]\d*$/.test(v)) setPerPersonCost(v);
                    }}
                    style={{ width: "100%" }}
                    inputMode="numeric"
                />
            </div>
            <div style={{ marginTop: 10 }}>
                <div id="add-place-rating-label" style={{ fontSize: 13, fontWeight: 700, color: ratingMissing ? 'var(--color-danger)' : 'var(--color-text-secondary)' }}>{t('map:addForm.ratingLabel')}</div>
                <div role="radiogroup" aria-labelledby="add-place-rating-label" aria-required="true" aria-invalid={ratingMissing || undefined} aria-describedby={ratingMissing ? 'add-place-rating-error' : undefined}
                    style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
                    {RATING_TIERS.map((item) => {
                        const selected = chosenRating === item.score;
                        return (
                            <button
                                key={item.score}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={t('map:rating.panel.optionLabel', { tier: tierLabel(item), hint: tierHint(item) })}
                                title={tierHint(item)}
                                onClick={() => { setChosenRating(item.score); setRatingMissing(false); }}
                                className="fm-pressable"
                                style={{
                                    minHeight: 44, padding: '4px 2px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                    border: `${selected ? 2 : 1}px solid ${selected ? item.tone : (ratingMissing ? 'var(--color-danger)' : 'var(--color-border)')}`,
                                    background: selected ? `color-mix(in srgb, ${item.tone} 14%, transparent)` : 'transparent',
                                    color: selected ? item.tone : 'var(--color-text-primary)', fontSize: 12, fontWeight: selected ? 700 : 500,
                                    whiteSpace: 'nowrap', touchAction: 'manipulation'
                                }}
                            >
                                {tierLabel(item)}
                            </button>
                        );
                    })}
                </div>
                {ratingMissing && <div id="add-place-rating-error" role="alert" style={{ marginTop: 4, fontSize: 12, color: 'var(--color-danger)' }}>{t('map:addForm.ratingRequired')}</div>}
            </div>
            <ScrollableView style={{ marginTop: 8, maxHeight: "200px", overflowY: "auto" }}>
                <PlaceImageInputs backendUrl={backendUrl} token={token} images={exteriorImages} setImages={setExteriorImages} label={t('map:addForm.exteriorImages')} />
                <PlaceImageInputs backendUrl={backendUrl} token={token} images={menuImages} setImages={setMenuImages} label={t('map:addForm.menuImages')} />
            </ScrollableView>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                {draftSaved && <span style={{ marginRight: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>{t('map:addForm.draft.saved')}</span>}
                <Button themeAware onClick={onCancel}>{t('common:action.cancel')}</Button>
                <Button themeAware onClick={handle}>{t('map:addForm.submit')}</Button>
            </div>
        </div>
    );
}
