// 提交住民反馈：网页面板与 iOS 原生反馈页共用（原生只把输入交过来，凭证与请求留在网页层）。
// 返回 { ok, message, status?, id? }，由调用方决定如何提示；网络异常也转成 { ok: false }。
import { APP_VERSION, getPlatform } from '../platform/env';
import { t } from '../i18n/index.js';

export async function submitFeedback({ backendUrl, token, type, content, images = [] }) {
    if (!backendUrl || !token) return { ok: false, status: 401, message: t('feedback:error.loginRequired') };
    const form = new FormData();
    form.append('type', type);
    form.append('content', content);
    form.append('platform', getPlatform());
    form.append('app_version', APP_VERSION || '');
    images.forEach((blob, index) => form.append('images', blob, blob.name || `feedback-${index + 1}.jpg`));
    let res;
    try {
        res = await fetch(`${backendUrl}/api/feedback`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    } catch (error) {
        return { ok: false, message: t('feedback:error.network') };
    }
    const data = await res.json().catch(() => null);
    if (!res.ok) {
        const fallback = res.status === 401 ? t('feedback:error.loginRequired') : t('feedback:error.failed', { status: res.status });
        return { ok: false, status: res.status, message: (data && typeof data.error === 'string' && data.error) || fallback };
    }
    return { ok: true, id: data && data.id, message: t('feedback:submitted') };
}
