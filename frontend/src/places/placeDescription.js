// 地点描述最少字数：去掉所有空白后按字符（码点）数。与后端 modules/places/services/placeService.js 的
// PLACE_DESCRIPTION_MIN_LENGTH / placeDescriptionLength 保持一致。新增地点必查，编辑只在描述有改动时查。
export const PLACE_DESCRIPTION_MIN_LENGTH = 15;

export function placeDescriptionLength(text) {
    return Array.from(String(text ?? '').replace(/\s/g, '')).length;
}

export function placeDescriptionTooShort(text) {
    return placeDescriptionLength(text) < PLACE_DESCRIPTION_MIN_LENGTH;
}
