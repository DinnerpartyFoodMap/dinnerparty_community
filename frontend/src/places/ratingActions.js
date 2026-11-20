// 评价面板的两个操作（选一档 / 撤回）：网页评价面板与 iOS 原生玻璃面板共用。
// notify(text, tone) 报告结果：tone 为 'success' 或 'danger'。网页把它显示成 toast；原生面板只把失败写进面板提示
// （成功时选中格本身就是结果，网页 toast 会被原生面板盖住）。
import { t } from '../i18n/index.js';
import { ratingTierFor, tierLabel } from './rating.js';

export function ratingFailureText(error) {
    return error?.committed ? error.message : t('map:rating.panel.saveFailed', { message: error?.message || error });
}

export async function chooseRating(rating, score, { isAuthenticated, banned, onRequireAuth, notify } = {}) {
    if (!isAuthenticated) {
        onRequireAuth && onRequireAuth();
        return;
    }
    if (banned || rating.saving) return;
    try {
        await rating.submit(score);
        notify && notify(t('map:rating.panel.saved', { tier: tierLabel(ratingTierFor(score)) }), 'success');
    } catch (error) {
        notify && notify(ratingFailureText(error), 'danger');
        if (error && error.status === 429) rating.reload();
    }
}

export async function withdrawRating(rating, { notify } = {}) {
    if (rating.saving) return;
    try {
        await rating.withdraw();
        notify && notify(t('map:rating.panel.withdrawn'), 'success');
    } catch (error) {
        notify && notify(ratingFailureText(error), 'danger');
    }
}
