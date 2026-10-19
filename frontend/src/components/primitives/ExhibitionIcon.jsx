import React, { useState } from 'react';
import { resolveResourceUrl } from '../../platform/runtimeConfig';

export default function ExhibitionIcon({ url, backendUrl, ...props }) {
    const [failedUrl, setFailedUrl] = useState(null);
    const source = url && failedUrl !== url
        ? (url.startsWith('/uploads/') ? `${backendUrl}${url}` : resolveResourceUrl(url))
        : '/favicon.png';
    return <img {...props} src={source} width={44} height={44} alt=""
        onError={() => { if (url && failedUrl !== url) setFailedUrl(url); }}
        style={{ width: 44, height: 44, objectFit: 'contain', borderRadius: 10, display: 'block', ...props.style }} />;
}
