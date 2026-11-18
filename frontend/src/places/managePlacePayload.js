export function buildManagePayload(edit, original) {
    const payload = {
        name: (edit.name || '').trim(),
        category: (edit.category || '').trim(),
        per_person_cost: edit.per_person_cost
    };
    const description = (edit.description || '').trim();
    if (description !== (original.description || '').trim()) payload.description = description;

    for (const field of ['exterior_images', 'menu_images']) {
        const images = (edit[field] || []).filter(Boolean);
        const previous = (original[field] || []).filter(Boolean);
        if (images.length !== previous.length || images.some((image, index) => image !== previous[index])) {
            payload[field] = images;
        }
    }

    if (!Object.is(Number(edit.longitude), Number(original.longitude)) || !Object.is(Number(edit.latitude), Number(original.latitude))) {
        payload.longitude = edit.longitude;
        payload.latitude = edit.latitude;
    }
    return payload;
}
