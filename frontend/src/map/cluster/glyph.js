// 标记图形尺寸与数量格式（纯函数，便于在 Node 中测试）。

export const PLACE_GLYPH = Object.freeze({ width: 36, height: 43 });
export const CLUSTER_GLYPH = Object.freeze({ width: 36, height: 52 });
export const MIN_HIT_SIZE = 44;
export const LABEL_MAX_WIDTH = 140;
export const LABEL_HEIGHT = 22;
export const LABEL_GAP = 3;

/** s(n) = min(1.55, 1 + 0.09 × log2(max(1, n / 2)))，n ≥ 2；表达密度，不表示面积与数量成比例。 */
export function clusterScale(count) {
    if (!(count >= 2)) return 1;
    return Math.min(1.55, 1 + 0.09 * Math.log2(Math.max(1, count / 2)));
}

export function glyphSize(node) {
    if (node.kind === 'cluster') {
        const s = clusterScale(node.count);
        return { width: Math.round(CLUSTER_GLYPH.width * s * 10) / 10, height: Math.round(CLUSTER_GLYPH.height * s * 10) / 10, scale: s };
    }
    return { width: PLACE_GLYPH.width, height: PLACE_GLYPH.height, scale: 1 };
}

export function hitSize(size) {
    return { width: Math.max(MIN_HIT_SIZE, size.width + 8), height: Math.max(MIN_HIT_SIZE, size.height + 4) };
}

/** 超长数量显示紧凑格式；完整数量保留在可访问名称和成员列表。 */
export function formatCount(count) {
    if (count < 1000) return String(count);
    if (count < 10000) return `${(Math.floor(count / 100) / 10).toFixed(1).replace(/\.0$/, '')}k`;
    return `${Math.floor(count / 1000)}k`;
}

export function countFontSize(text, scale) {
    const base = text.length <= 2 ? 20 : text.length === 3 ? 16 : 13;
    return Math.round(base * scale * 10) / 10;
}
