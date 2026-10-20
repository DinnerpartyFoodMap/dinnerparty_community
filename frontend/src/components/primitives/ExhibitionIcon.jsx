import React, { useState } from 'react';
import { resolveResourceUrl } from '../../platform/runtimeConfig';

/** 展会图标地址：站内上传走后端，其余按资源地址解析；没有图标时为空 */
export function exhibitionIconSource(url, backendUrl) {
    if (!url) return '';
    return url.startsWith('/uploads/') ? `${backendUrl}${url}` : resolveResourceUrl(url);
}

export default function ExhibitionIcon({ url, backendUrl, ...props }) {
    const [failedUrl, setFailedUrl] = useState(null);
    const source = url && failedUrl !== url ? exhibitionIconSource(url, backendUrl) : '/favicon.png';
    return <img {...props} src={source} width={44} height={44} alt=""
        onError={() => { if (url && failedUrl !== url) setFailedUrl(url); }}
        style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 10, display: 'block', ...props.style }} />;
}
