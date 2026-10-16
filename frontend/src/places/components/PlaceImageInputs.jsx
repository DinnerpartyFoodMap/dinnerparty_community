import React, { useState } from "react";
import Button from "../../components/primitives/Button";
import { useTips } from "../../components/feedback/Tips";
import { imageThumbnailUrl } from "../../platform/runtimeConfig";
import { pickImages, prepareImageForUpload, UPLOAD_LIMITS } from "../../platform/mediaPicker";
import { t } from "../../i18n/index.js";

export default function PlaceImageInputs({ backendUrl, token, images, setImages, label }) {
    const [uploading, setUploading] = useState(false);
    const [failedFile, setFailedFile] = useState(null);
    const showTip = useTips();

    // 选图/拍照（App 内为系统相册与相机），取消选择不提示
    const handleUploadClick = async () => {
        let files;
        try {
            files = await pickImages({ multiple: false, source: 'prompt' });
        } catch (error) {
            showTip(error.message || t('map:imageInputs.pickFailed'));
            return;
        }
        if (files && files[0]) await uploadFile(files[0]);
    };

    const uploadFile = async (picked) => {
        setUploading(true);
        setFailedFile(null);
        let file;
        try {
            // HEIC 检查、EXIF 方向与大图压缩；上限与后端 /upload 一致（20MB）
            file = await prepareImageForUpload(picked, UPLOAD_LIMITS.placeImage);
        } catch (error) {
            showTip(error.message || t('map:imageInputs.processFailed'));
            setUploading(false);
            return;
        }

        try {
            const formData = new FormData();
            formData.append('image', file);

            const res = await fetch(`${backendUrl}/upload`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`
                },
                body: formData
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                if (res.status === 413) {
                    showTip(data.error || t('map:imageInputs.tooLarge'));
                    return;
                }
                throw new Error(data.error || t('common:error.uploadFailed'));
            }

            const data = await res.json();

            // 拼接完整URL用于保存，如果后端返回相对路径的话。如果后端返回 /uploads/... 
            const fullUrl = data.url.startsWith('http') ? data.url : `${backendUrl}${data.url}`;
            setImages([...images, fullUrl]);
        } catch (error) {
            // 网络中断等失败保留已处理的图片，允许一键重试而不必重新选择
            setFailedFile(file);
            showTip(error.message || t('map:imageInputs.uploadFailed'));
        } finally {
            setUploading(false);
        }
    };

    const handleRemove = (index) => {
        setImages(images.filter((_, i) => i !== index));
    };

    return (
        <div style={{ marginBottom: "15px" }}>
            <div
                style={{
                    marginBottom: "5px",
                    fontSize: "14px",
                    fontWeight: "bold",
                    color: 'var(--color-text-primary)'
                }}
            >
                {label}
            </div>

            {images.map((url, i) => (
                <div key={i} style={{ display: "flex", gap: "8px", marginBottom: "8px", alignItems: 'center' }}>
                    <img src={imageThumbnailUrl(url, 120)} alt={`Preview ${i}`} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 'var(--radius-sm)' }} />
                    <div style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>
                        {url}
                    </div>
                    <Button variant="danger" onClick={() => handleRemove(i)}>{t('common:action.delete')}</Button>
                </div>
            ))}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <Button variant="secondary" onClick={handleUploadClick} size="small" disabled={uploading}>
                    {uploading ? t('map:imageInputs.uploading') : t('map:imageInputs.addImage')}
                </Button>
                {failedFile && !uploading && (
                    <Button variant="secondary" onClick={() => uploadFile(failedFile)} size="small">
                        {t('map:imageInputs.retryUpload')}
                    </Button>
                )}
            </div>
        </div>
    );
}
