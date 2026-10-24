// 添加地点表单的草稿：面板不管怎么关上（点外部、下滑、返回键、取消），再次添加地点时都能接着填。
// 只保存表单内容（文字、评价与已上传图片的 URL）；坐标和地址跟着这次打开的位置走，不从草稿恢复。
// 草稿在提交成功或用户清空时删除。
import { saveLocalPlaceDraft, loadLocalPlaceDraft, deleteLocalPlaceDraft } from '../platform/localDraftStore.js';
import { RATING_TIERS } from './rating.js';

const text = (value) => (typeof value === 'string' ? value : '');
const urls = (value) => (Array.isArray(value) ? value.filter((url) => typeof url === 'string' && url) : []);

/** 规整表单内容；也用来校验从本机读回的草稿。 */
export function normalizePlaceContent(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const cost = text(value.perPersonCost);
    return {
        name: text(value.name),
        category: text(value.category),
        description: text(value.description).slice(0, 1000),
        perPersonCost: /^[1-9]\d*$/.test(cost) ? cost : '',
        chosenRating: RATING_TIERS.some((tier) => tier.score === value.chosenRating) ? value.chosenRating : null,
        exteriorImages: urls(value.exteriorImages),
        menuImages: urls(value.menuImages)
    };
}

/** 这次打开时的空表单：从高德地点收录时带着它的店名和分类。 */
export function emptyPlaceContent({ name = '', category = '', description = '' } = {}) {
    return normalizePlaceContent({ name, category, description });
}

export const placeContentKey = (content) => JSON.stringify(normalizePlaceContent(content));

/** 草稿来自哪个高德地点（店名 + 地址）；在地图上点选的没有来源。 */
export function placeDraftSource({ name = '', address = '' } = {}) {
    return name || address ? { name, address } : null;
}

const sameSource = (a, b) => !!a && !!b && a.name === b.name && a.address === b.address;

/**
 * 表单打开时读草稿。在地图上点选或从同一个高德地点收录时直接恢复（restored）；
 * 从另一个高德地点收录时先用那个地点的信息，草稿只作为 pending 让用户选择恢复。
 * @returns {{content: object, restored: boolean, pending: object|null}}
 */
export function openPlaceDraft(userId, baseline, source) {
    const record = loadLocalPlaceDraft(userId);
    const draft = record ? normalizePlaceContent(record.content) : null;
    if (!draft || placeContentKey(draft) === placeContentKey(baseline)) return { content: baseline, restored: false, pending: null };
    if (!source || sameSource(record.source, source)) return { content: draft, restored: true, pending: null };
    return { content: baseline, restored: false, pending: draft };
}

/** 保存当前内容；和空表单一样时删除草稿。返回本机是否存着这份草稿。 */
export function persistPlaceDraft(userId, content, baseline, source) {
    if (!userId) return false;
    if (placeContentKey(content) === placeContentKey(baseline)) {
        deleteLocalPlaceDraft(userId);
        return false;
    }
    return saveLocalPlaceDraft(userId, { content: normalizePlaceContent(content), source: source || null });
}

export function discardPlaceDraft(userId) {
    deleteLocalPlaceDraft(userId);
}
