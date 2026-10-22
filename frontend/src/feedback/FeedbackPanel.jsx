import React, { useEffect, useRef, useState } from 'react';
import ResponsivePanel from "../components/overlay/ResponsivePanel";
import TextArea from "../components/forms/TextArea";
import SelectInput from "../components/forms/SelectInput";
import Button from "../components/primitives/Button";
import { useTips } from "../components/feedback/Tips";
import { pickImages, prepareImageForUpload, UPLOAD_LIMITS } from "../platform/mediaPicker";
import { FEEDBACK_LIMITS, FEEDBACK_TYPES } from "./feedbackTypes";
import { submitFeedback } from "./feedbackApi";
import { t } from "../i18n/index.js";

let imageSequence = 0;
const sectionTitleStyle = { fontSize: 13, fontWeight: 700, color: 'var(--color-text-secondary)', margin: '18px 0 8px' };

// 意见反馈：类型 + 内容 + 最多 4 张图片，一次提交。面板常驻（不随关闭卸载），误关后再打开草稿还在；提交成功才清空。
// prefill（{ type, content }，例如从地点详情举报）预填类型与内容开头；同一份预填再打开时保留草稿，
// 只有预填、没写别的内容时不能提交。iOS App 里由原生反馈页代替（见 useNativeFeedback），这里是网页、Android 与原生不可用时的版本。
export default function FeedbackPanel({ open, onClose, backendUrl, token, onRequireAuth, prefill = null }) {
    const showTip = useTips();
    const [type, setType] = useState('');
    const [content, setContent] = useState('');
    const [images, setImages] = useState([]);
    const [picking, setPicking] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState('');
    const [prefillText, setPrefillText] = useState('');
    const imagesRef = useRef(images);
    imagesRef.current = images;

    useEffect(() => () => imagesRef.current.forEach((image) => URL.revokeObjectURL(image.url)), []);

    useEffect(() => {
        if (!open || !prefill) return;
        setType(prefill.type);
        setContent((current) => (prefill.content && current.startsWith(prefill.content) ? current : prefill.content));
        setPrefillText(prefill.content.trim());
        setError('');
    }, [open, prefill]);

    const remaining = FEEDBACK_LIMITS.images - images.length;
    const trimmed = content.trim();
    const canSubmit = !!type && !!trimmed && trimmed !== prefillText && !submitting && !picking;
    const selectedType = FEEDBACK_TYPES.find((item) => item.value === type);

    const addImages = async () => {
        if (remaining <= 0 || picking) return;
        setPicking(true);
        try {
            const files = await pickImages({ multiple: true, source: 'prompt', limit: remaining });
            const added = [];
            for (const file of files.slice(0, remaining)) {
                try {
                    const prepared = await prepareImageForUpload(file, UPLOAD_LIMITS.feedbackImage);
                    added.push({ key: `feedback-image-${++imageSequence}`, file: prepared, url: URL.createObjectURL(prepared) });
                } catch (err) {
                    showTip(err.message || t('feedback:error.imageFailed'));
                }
            }
            if (added.length) setImages((current) => [...current, ...added].slice(0, FEEDBACK_LIMITS.images));
        } catch (err) {
            showTip(err.message || t('feedback:error.imageFailed'));
        } finally {
            setPicking(false);
        }
    };

    const removeImage = (key) => {
        setImages((current) => current.filter((image) => {
            if (image.key === key) URL.revokeObjectURL(image.url);
            return image.key !== key;
        }));
    };

    const submit = async () => {
        if (!canSubmit) return;
        setSubmitting(true);
        setError('');
        const result = await submitFeedback({ backendUrl, token, type, content: trimmed, images: images.map((image) => image.file) });
        setSubmitting(false);
        if (!result.ok) {
            setError(result.message);
            if (result.status === 401) onRequireAuth?.();
            return;
        }
        images.forEach((image) => URL.revokeObjectURL(image.url));
        setImages([]);
        setType('');
        setContent('');
        setPrefillText('');
        showTip(result.message);
        onClose?.('submitted');
    };

    return (
        <ResponsivePanel
            open={open}
            onClose={() => { if (!submitting) onClose?.('cancel'); }}
            title={t('feedback:title')}
            kind="feedback"
            desktop="center"
            mobile="sheet"
            width="min(520px, calc(100vw - 24px))"
            bodyStyle={{ padding: 0 }}
            footer={(
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {error && <div role="alert" style={{ fontSize: 13, color: 'var(--color-danger)', lineHeight: 1.5 }}>{error}</div>}
                    <Button full disabled={!canSubmit} onClick={submit}
                        style={{ minHeight: 44, border: 0, borderRadius: 'var(--radius-sm)', fontSize: 15, fontWeight: 700, color: '#FFFFFF', opacity: canSubmit ? 1 : 0.55 }}>
                        {submitting ? t('feedback:submitting') : t('feedback:submit')}
                    </Button>
                </div>
            )}
        >
            <div style={{ padding: '0 20px 16px', color: 'var(--color-text-primary)' }}>
                <div style={{ fontSize: 13, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>{t('feedback:intro')}</div>

                <label htmlFor="feedback-type" style={{ ...sectionTitleStyle, display: 'block' }}>{t('feedback:typeLabel')}</label>
                <SelectInput
                    id="feedback-type"
                    value={type}
                    disabled={submitting}
                    onChange={(event) => setType(event.target.value)}
                    style={{ width: '100%', borderRadius: 'var(--radius-sm)', fontSize: 16, color: type ? 'var(--color-text-primary)' : 'var(--color-text-muted)' }}
                >
                    <option value="" disabled>{t('feedback:typePlaceholder')}</option>
                    {FEEDBACK_TYPES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                </SelectInput>

                <label htmlFor="feedback-content" style={{ ...sectionTitleStyle, display: 'block' }}>{t('feedback:contentLabel')}</label>
                <TextArea
                    id="feedback-content"
                    markdown
                    value={content}
                    maxLength={FEEDBACK_LIMITS.contentLength}
                    rows={6}
                    disabled={submitting}
                    placeholder={selectedType ? selectedType.hint : t('feedback:contentPlaceholder')}
                    onChange={(event) => setContent(event.target.value)}
                    style={{ width: '100%', borderRadius: 'var(--radius-sm)', minHeight: 140 }}
                />
                <div style={{ marginTop: 4, textAlign: 'right', fontSize: 12, color: 'var(--color-text-muted)', fontVariantNumeric: 'tabular-nums' }}>
                    {t('feedback:counter', { count: content.length, max: FEEDBACK_LIMITS.contentLength })}
                </div>

                <div style={sectionTitleStyle}>{t('feedback:imagesLabel')}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {images.map((image, index) => (
                        <div key={image.key} style={{ position: 'relative', width: 76, height: 76 }}>
                            <img src={image.url} alt={t('feedback:imageAlt', { index: index + 1 })} draggable={false}
                                style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }} />
                            <button type="button" onClick={() => removeImage(image.key)} disabled={submitting}
                                aria-label={t('feedback:removeImage', { index: index + 1 })}
                                style={{ position: 'absolute', top: -6, right: -6, width: 24, height: 24, padding: 0, borderRadius: '50%', border: 0, cursor: 'pointer',
                                    background: 'rgba(0,0,0,0.65)', color: '#FFFFFF', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>close</span>
                            </button>
                        </div>
                    ))}
                    {remaining > 0 && (
                        <button type="button" onClick={addImages} disabled={picking || submitting} className="fm-pressable"
                            aria-label={t('feedback:addImage')}
                            style={{ width: 76, height: 76, borderRadius: 'var(--radius-sm)', border: '1px dashed var(--color-border)', background: 'var(--color-bg-overlay)',
                                color: 'var(--color-text-secondary)', cursor: picking ? 'progress' : 'pointer', display: 'inline-flex', flexDirection: 'column',
                                alignItems: 'center', justifyContent: 'center', gap: 2, fontSize: 11 }}>
                            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 24 }}>{picking ? 'hourglass_top' : 'add_photo_alternate'}</span>
                            {picking ? t('feedback:processingImage') : t('feedback:imageCount', { count: images.length, max: FEEDBACK_LIMITS.images })}
                        </button>
                    )}
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>{t('feedback:imagesHint', { max: FEEDBACK_LIMITS.images })}</div>
            </div>
        </ResponsivePanel>
    );
}
