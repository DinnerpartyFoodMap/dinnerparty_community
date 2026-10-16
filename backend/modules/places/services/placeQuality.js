// Shared by search ranking and rating contribution scores.
function placeDetailCompleteness(place) {
    const rawDescription = String(place?.description || '').replace(/\s+/g, ' ').trim();
    const description = /^(暂无描述|无描述|未提供|无|[-—]+)$/i.test(rawDescription) ? '' : rawDescription;
    const descriptionLength = Array.from(description).length;
    const descriptionScore = descriptionLength >= 80 ? 1
        : descriptionLength >= 40 ? 0.8
            : descriptionLength >= 16 ? 0.5
                : descriptionLength > 0 ? 0.2 : 0;

    const genericCategories = new Set(['其他', '未分类', '餐厅', '美食', '其他美食', '地点']);
    const categories = String(place?.category || '').split(/[,，/、|]+/).map((value) => value.trim()).filter(Boolean);
    const categoryScore = categories.some((category) => !genericCategories.has(category)) ? 1 : 0;
    const price = Number(place?.per_person_cost);
    const priceScore = Number.isFinite(price) && price > 0 ? 1 : 0;
    return Number((descriptionScore * 0.7 + categoryScore * 0.2 + priceScore * 0.1).toFixed(3));
}

module.exports = { placeDetailCompleteness };
