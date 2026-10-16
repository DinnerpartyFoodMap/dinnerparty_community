import React, { useState } from 'react';
import Button from "../../components/primitives/Button";
import TextInput from "../../components/forms/TextInput";
import PlaceImageInputs from './PlaceImageInputs';
import { useTips } from "../../components/feedback/Tips";
import ScrollableView from "../../components/layout/ScrollableView";
import CategorySelector from "./CategorySelector";
import { t } from "../../i18n/index.js";
import { RATING_TIERS, defaultCreationScore, tierLabel, tierHint } from "../rating";

export default function AddForm({ backendUrl, token, defaultPos, defaultName = "", defaultCategory = "", defaultDescription = "", defaultAddress = "", onCancel, onSubmit }) {
    const [name, setName] = useState(defaultName);
    const [category, setCategory] = useState(defaultCategory);
    const [description, setDescription] = useState(defaultDescription);
    const [exteriorImages, setExteriorImages] = useState([]);
    const [menuImages, setMenuImages] = useState([]);
    const [perPersonCost, setPerPersonCost] = useState('');
    // 创建者的评价：没手动选过时跟着标签走（带“避雷”预选强烈拒绝，否则强烈推荐）
    const [chosenRating, setChosenRating] = useState(null);
    const rating = chosenRating ?? defaultCreationScore(category);
    const showTip = useTips();

    const handle = () => {
        if (!name) { showTip(t('map:addForm.nameRequired')); return; }
        const payload = {
            name,
            category,
            description,
            // 从高德地点收录时带上地址（单独的字段，不再塞进描述）
            ...(defaultAddress ? { address: defaultAddress } : {}),
            per_person_cost: perPersonCost ? parseInt(perPersonCost, 10) : null,
            rating,
            exterior_images: exteriorImages.filter(Boolean),
            menu_images: menuImages.filter(Boolean),
            longitude: defaultPos[0],
            latitude: defaultPos[1]
        };
        onSubmit(payload);
    };

    return (
        <div style={{ width: 'min(320px, 100%)', maxWidth: '100%', boxSizing: 'border-box' }}>
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
                <TextInput placeholder={t('map:common.label.description')} value={description} onChange={(e) => setDescription(e.target.value)} style={{ width: "100%" }} />
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
                <div id="add-place-rating-label" style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)' }}>{t('map:addForm.ratingLabel')}</div>
                <div role="radiogroup" aria-labelledby="add-place-rating-label" style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
                    {RATING_TIERS.map((item) => {
                        const selected = rating === item.score;
                        return (
                            <button
                                key={item.score}
                                type="button"
                                role="radio"
                                aria-checked={selected}
                                aria-label={t('map:rating.panel.optionLabel', { tier: tierLabel(item), hint: tierHint(item) })}
                                title={tierHint(item)}
                                onClick={() => setChosenRating(item.score)}
                                className="fm-pressable"
                                style={{
                                    minHeight: 44, padding: '4px 2px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                                    border: `${selected ? 2 : 1}px solid ${selected ? item.tone : 'var(--color-border)'}`,
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
                <div style={{ marginTop: 4, fontSize: 11, color: 'var(--color-text-muted)' }}>{t('map:addForm.ratingHint')}</div>
            </div>
            <ScrollableView style={{ marginTop: 8, maxHeight: "200px", overflowY: "auto" }}>
                <PlaceImageInputs backendUrl={backendUrl} token={token} images={exteriorImages} setImages={setExteriorImages} label={t('map:addForm.exteriorImages')} />
                <PlaceImageInputs backendUrl={backendUrl} token={token} images={menuImages} setImages={setMenuImages} label={t('map:addForm.menuImages')} />
            </ScrollableView>
            <div style={{ marginTop: 8, textAlign: "right" }}>
                <Button themeAware onClick={onCancel} style={{ marginRight: 8 }}>{t('common:action.cancel')}</Button>
                <Button themeAware onClick={handle}>{t('map:addForm.submit')}</Button>
            </div>
        </div>
    );
}
