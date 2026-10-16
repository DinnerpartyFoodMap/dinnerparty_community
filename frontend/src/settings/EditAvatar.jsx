import React, { useState, useRef, useEffect, useCallback } from 'react';
import Button from "../components/primitives/Button";
import useDarkMode from "../theme/useDarkMode";
import defaultAvatar from '../img/default.png';
import { TipsContext } from "../components/feedback/Tips";
import Cropper from 'react-easy-crop';
import getCroppedImg from "./media/cropImage";
import PageTemplate from "../components/layout/PageTemplate";
import { getThemeColor, pickContrastTextColor } from "../theme/theme";
import { pickImages, prepareImageForUpload, UPLOAD_LIMITS } from '../platform/mediaPicker';
import { t } from '../i18n/index.js';
import { uploadAvatar } from './accountSettings';

export default function EditAvatar({ user, onBack, backendUrl, token, onUpdateUser }) {
    const themeColor = getThemeColor() || '#E2789F';
    const dark = useDarkMode();
    const [file, setFile] = useState(null);
    const [previewUrl, setPreviewUrl] = useState('');
    const [uploading, setUploading] = useState(false);
    const [error, setError] = useState('');
    const { showTip } = React.useContext(TipsContext);

    // Cropper state
    const [crop, setCrop] = useState({ x: 0, y: 0 });
    const [zoom, setZoom] = useState(1);
    const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);

    const onCropComplete = useCallback((croppedArea, croppedAreaPixels) => {
        setCroppedAreaPixels(croppedAreaPixels);
    }, []);

    useEffect(() => {
        if (file) {
            const url = URL.createObjectURL(file);
            setPreviewUrl(url);
            return () => URL.revokeObjectURL(url);
        } else {
            setPreviewUrl('');
        }
    }, [file]);

    // 选图（App 内为系统相册/相机）：先摆正方向并压缩大图，再交给裁剪器；取消选择不提示
    const handlePickImage = async () => {
        try {
            const files = await pickImages({ multiple: false, source: 'prompt' });
            if (!files || !files[0]) return;
            setError('');
            setFile(await prepareImageForUpload(files[0], UPLOAD_LIMITS.avatar));
        } catch (e) {
            setError(e.message || t('settings:editAvatar.unreadable'));
        }
    };

    const handleUpload = async () => {
        if (!file || !previewUrl || !croppedAreaPixels) {
            setError(t('settings:editAvatar.cropRequired'));
            return;
        }
        setUploading(true);
        setError('');

        try {
            const croppedImageBlob = await getCroppedImg(previewUrl, croppedAreaPixels, 0);

            const result = await uploadAvatar({ backendUrl, token, blob: croppedImageBlob });
            if (!result.ok) throw new Error(result.message);
            onUpdateUser(result.user, token);
            showTip(result.message);
            onBack();
        } catch (e) {
            setError(e.message);
        } finally {
            setUploading(false);
        }
    };

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.editAvatar') }]} onBack={onBack}>
            <div style={{ maxWidth: 500, margin: '0 auto', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
                {previewUrl ? (
                    <div style={{ position: 'relative', width: '100%', height: 300, background: '#333', borderRadius: 8, overflow: 'hidden' }}>
                        <Cropper
                            image={previewUrl}
                            crop={crop}
                            zoom={zoom}
                            aspect={1}
                            cropShape="round"
                            showGrid={false}
                            onCropChange={setCrop}
                            onZoomChange={setZoom}
                            onCropComplete={onCropComplete}
                        />
                    </div>
                ) : (
                    <div style={{
                        width: 150, height: 150, borderRadius: '50%', background: 'var(--color-bg-overlay)',
                        display: 'flex', justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
                        border: '1px solid var(--color-border)'
                    }}>
                        {user && user.has_avatar ? (
                            <img src={`${backendUrl}/users/${user.id}/avatar?t=${Date.now()}`} alt="Current Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                            <img src={defaultAvatar} alt="Default Avatar" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        )}
                    </div>
                )}

                {previewUrl && (
                    <div style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ fontSize: 14 }}>{t('settings:editAvatar.zoom')}</span>
                        <input
                            type="range"
                            min={1}
                            max={3}
                            step={0.1}
                            value={zoom}
                            onChange={(e) => setZoom(Number(e.target.value))}
                            style={{ flex: 1 }}
                        />
                    </div>
                )}
                <div>
                    <Button
                        themeAware
                        onClick={handlePickImage}
                        style={{ padding: '8px 16px', background: 'var(--color-bg-overlay)', color: 'var(--color-text-primary)', border: '1px solid var(--color-border)' }}
                    >
                        {t('settings:editAvatar.chooseImage')}
                    </Button>
                </div>

                {error && <div style={{ color: 'var(--color-danger)', fontSize: 14 }}>{error}</div>}

                <div style={{ marginTop: 10, width: '100%' }}>
                    <Button
                        themeAware
                        onClick={handleUpload}
                        disabled={uploading || !file}
                        style={{
                            width: '100%', padding: '12px', background: !file ? 'var(--color-bg-overlay)' : themeColor,
                            color: !file ? 'var(--color-text-muted)' : pickContrastTextColor(themeColor), border: 'none',
                            fontWeight: 600
                        }}
                    >
                        {uploading ? t('settings:editAvatar.uploading') : t('settings:editAvatar.saveChanges')}
                    </Button>
                </div>
            </div>
        </PageTemplate>
    );
}
