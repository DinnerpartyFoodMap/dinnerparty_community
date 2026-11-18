export function resolveAvatarUrl(user, backendUrl, { defaultUrl = '', serverFallback = false } = {}) {
    const url = typeof user?.avatar_url === 'string' ? user.avatar_url.trim() : '';
    if (/^https?:\/\//i.test(url)) return url;

    const base = String(backendUrl || '').replace(/\/+$/, '');
    if (/^\/(?![\\/])/.test(url)) return `${base}${url}`;
    if (user?.id != null && (user.has_avatar || serverFallback)) {
        return `${base}/users/${encodeURIComponent(user.id)}/avatar${serverFallback ? '?fallback=default' : ''}`;
    }
    return defaultUrl;
}
