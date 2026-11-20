// iOS 原生打卡面板（协议 v19 的 checkIn，从右侧按钮组展开的玻璃外壳，同筛选、收藏）：与网页 PlaceCheckInPanel 同一份状态
// （usePlaceCheckIn）。原生只拿到展示字段：补充描述是 input 分组（输入经 input 事件回传），评分是标签，照片是缩略图行；
// 点按回传行 id（score:<分数> / photo:<id> / photos:add / submit / done），由 MapUI 查表执行。纯函数，test:rating 覆盖。
import { t } from '../i18n/index.js';
import { sfSymbol } from '../platform/iconRegistry.js';
import { RATING_TIERS, tierLabel } from './rating.js';
import { CHECK_IN_DESCRIPTION_LIMIT, CHECK_IN_PHOTO_LIMIT } from './checkInSubmission.js';

/** 原生面板回传的行 id → 操作；未知 id 返回 null */
export function checkInSheetAction(rowId) {
    const id = String(rowId || '');
    const score = /^score:([1-4])$/.exec(id);
    if (score) return { type: 'score', score: Number(score[1]) };
    const photo = /^photo:(\d+)$/.exec(id);
    if (photo) return { type: 'removePhoto', id: Number(photo[1]) };
    if (id === 'photos:add') return { type: 'addPhotos' };
    return ['submit', 'done'].includes(id) ? { type: id } : null;
}

export function checkInChromeSheet({ place, checkIn }) {
    const { description, score, photos, pending, error, receipt, retryRating } = checkIn;
    const busy = !!pending;
    const reviewed = receipt && Object.keys(receipt.reviews || {}).length > 0;
    const finished = !!receipt && !retryRating;
    return {
        id: 'checkIn',
        size: 'fit',
        title: t('map:checkIn.title'),
        subtitle: place?.name || t('common:label.unnamedPlace'),
        // 提交、选图期间不能关闭（与网页面板一致）
        locked: busy,
        message: error || (receipt ? t('map:checkIn.success') : undefined),
        messageTone: error ? 'danger' : receipt ? 'success' : undefined,
        sections: receipt ? [
            reviewed && { id: 'review', footer: t('map:checkIn.review'), rows: [] }
        ].filter(Boolean) : [
            { id: 'distance', footer: t('map:checkIn.distance'), rows: [] },
            {
                id: 'description',
                style: 'input',
                title: t('map:checkIn.description'),
                field: { id: 'description', value: description, maxLength: CHECK_IN_DESCRIPTION_LIMIT, disabled: busy },
                rows: []
            },
            {
                id: 'score',
                style: 'chips',
                title: t('map:checkIn.rating'),
                // 再点一次取消（评分选填）
                rows: RATING_TIERS.map((tier) => ({
                    id: `score:${tier.score}`,
                    title: tierLabel(tier),
                    tone: score === tier.score ? 'accent' : undefined,
                    disabled: busy,
                    keepsOpen: true
                }))
            },
            {
                id: 'photos',
                style: 'photos',
                title: t('map:checkIn.photos', { count: photos.length }),
                rows: [
                    // 点缩略图移除这张（缩略图右上角画移除标记）
                    ...photos.map((photo, index) => ({
                        id: `photo:${photo.id}`,
                        title: t('map:checkIn.photoItem', { index: index + 1 }),
                        subtitle: t('common:action.remove'),
                        ...(photo.thumbnail ? { image: photo.thumbnail } : null),
                        symbol: sfSymbol('photo'),
                        // 原生在缩略图右上角画移除标记
                        badge: 'remove',
                        disabled: busy,
                        keepsOpen: true
                    })),
                    photos.length < CHECK_IN_PHOTO_LIMIT && {
                        id: 'photos:add',
                        title: t('map:checkIn.photos', { count: photos.length }),
                        symbol: sfSymbol('addPhoto'),
                        disabled: busy,
                        keepsOpen: true
                    }
                ].filter(Boolean)
            }
        ],
        actions: [finished
            ? { id: 'done', title: t('map:checkIn.done'), tone: 'accent' }
            : {
                id: 'submit',
                title: pending === 'submit' ? t('map:checkIn.submitting') : retryRating ? t('map:checkIn.retryRating') : t('map:checkIn.submit'),
                symbol: sfSymbol('centerLocation'),
                tone: 'accent',
                disabled: busy,
                keepsOpen: true
            }]
    };
}
