import React, { useRef, useState } from "react";
import Button from "../../components/primitives/Button";
import { useTips } from "../../components/feedback/Tips";
import { imageThumbnailUrl } from "../../platform/runtimeConfig";
import { pickImages, prepareImageForUpload, UPLOAD_LIMITS } from "../../platform/mediaPicker";
import { t } from "../../i18n/index.js";

// 一次最多选这么多张（每组）；后端没有张数上限，只是避免一次排太长的上传队列
export const PLACE_IMAGE_PICK_LIMIT = 20;

/** 上传一张地点图片（POST /upload），返回完整地址；iOS 原生地点表单也用它 */
export async function uploadPlaceImage(backendUrl, token, file) {
    const formData = new FormData();
    formData.append('image', file);
    const res = await fetch(`${backendUrl}/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData
    });
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        if (res.status === 413) throw Object.assign(new Error(data.error || t('map:imageInputs.tooLarge')), { tooLarge: true });
        throw new Error(data.error || t('common:error.uploadFailed'));
    }
    const data = await res.json();
    // 后端返回相对路径（/uploads/...）时拼成完整地址保存
    return data.url.startsWith('http') ? data.url : `${backendUrl}${data.url}`;
}

/**
 * 地点图片（外观 / 菜单）：可一次选多张（App 内为系统相册多选或拍照），按顺序逐张处理、上传。
 * 某张失败时其余照常，失败的可以一键重试，不必重新选。
 */
export default function PlaceImageInputs({ backendUrl, token, images, setImages, label }) {
    const [progress, setProgress] = useState(null);
    const [failedFiles, setFailedFiles] = useState([]);
    const showTip = useTips();
    // 上传期间 images 可能被删改：每张传完都在最新的列表后追加
    const imagesRef = useRef(images);
    imagesRef.current = images;

    const uploadFiles = async (files) => {
        if (!files.length) return;
        const failed = [];
        setFailedFiles([]);
        for (let index = 0; index < files.length; index += 1) {
            setProgress({ done: index, total: files.length });
            let file = files[index];
            try {
                // HEIC 检查、EXIF 方向与大图压缩；上限与后端 /upload 一致（20MB）
                file = await prepareImageForUpload(file, UPLOAD_LIMITS.placeImage);
            } catch (error) {
                showTip(error.message || t('map:imageInputs.processFailed'));
                continue;
            }
            try {
                const url = await uploadPlaceImage(backendUrl, token, file);
                const next = [...imagesRef.current, url];
                imagesRef.current = next;
                setImages(next);
            } catch (error) {
                if (error.tooLarge) showTip(error.message);
                else failed.push(file);
            }
        }
        setProgress(null);
        setFailedFiles(failed);
        if (failed.length) showTip(t('map:imageInputs.uploadFailedCount', { count: failed.length }));
    };

    // 选图 / 拍照（App 内为系统相册与相机），可多选；取消选择不提示
    const handleUploadClick = async () => {
        let files;
        try {
            files = await pickImages({ multiple: true, source: 'prompt', limit: PLACE_IMAGE_PICK_LIMIT });
        } catch (error) {
            showTip(error.message || t('map:imageInputs.pickFailed'));
            return;
        }
        await uploadFiles(Array.isArray(files) ? files : []);
    };

    const handleRemove = (index) => {
        setImages(images.filter((_, i) => i !== index));
    };

    const uploading = !!progress;
    return (
        <div style={{ marginBottom: "15px" }}>
            <div style={{ marginBottom: "6px", fontSize: "14px", fontWeight: "bold", color: 'var(--color-text-primary)' }}>
                {label}
            </div>

            {images.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                    {images.map((url, i) => (
                        <div key={`${url}-${i}`} style={{ position: 'relative', width: 64, height: 64 }}>
                            <img src={imageThumbnailUrl(url, 160)} alt={t('map:imageInputs.previewAlt', { index: i + 1 })}
                                style={{ width: 64, height: 64, objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--color-border)' }} />
                            <button
                                type="button"
                                onClick={() => handleRemove(i)}
                                aria-label={t('map:imageInputs.removeImage', { index: i + 1 })}
                                style={{
                                    position: 'absolute', top: -6, right: -6, width: 22, height: 22, padding: 0, borderRadius: '50%',
                                    border: 0, background: 'var(--color-danger)', color: 'var(--color-on-emphasis)', cursor: 'pointer',
                                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center'
                                }}
                            >
                                <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 16 }}>close</span>
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <Button variant="secondary" onClick={handleUploadClick} size="small" disabled={uploading}>
                    {uploading ? t('map:imageInputs.uploadingProgress', { done: progress.done + 1, total: progress.total }) : t('map:imageInputs.addImages')}
                </Button>
                {failedFiles.length > 0 && !uploading && (
                    <Button variant="secondary" onClick={() => uploadFiles(failedFiles)} size="small">
                        {t('map:imageInputs.retryUploadCount', { count: failedFiles.length })}
                    </Button>
                )}
            </div>
        </div>
    );
}
