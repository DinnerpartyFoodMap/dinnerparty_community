// 标记 DOM：图标、名称、数量放在同一个 AMap Marker content 内，随地图同帧移动。
//
// AMap 管理的地理定位外层（不添加 transform transition）
// └─ .fm-marker            0×0 锚点根节点，左上角即地理坐标；尺寸固定，锚点不随名称长度或缩放漂移
//    └─ .fm-marker__travel 吸附位移层（只有转场时有 transform）
//       ├─ .fm-marker__glyph  图形与数量；缩放与轻微回弹只作用在这里，名称不会被放大变糊
//       ├─ .fm-marker__label  名称；单点显示时总是显示，只在转场期间隐藏
//       └─ .fm-marker__hit    点击区域，至少 44 CSS px

import yesIcon from '../img/yes.png';
import noIcon from '../img/no.png';
import unionIcon from '../img/union.png';
import './marker-motion.css';

export { PLACE_GLYPH, CLUSTER_GLYPH, MIN_HIT_SIZE, LABEL_MAX_WIDTH, LABEL_HEIGHT, LABEL_GAP, clusterScale, glyphSize, hitSize, formatCount, countFontSize } from './cluster/glyph.js';
import { glyphSize, hitSize, formatCount, countFontSize } from './cluster/glyph.js';
import { t } from '../i18n/index.js';
import { isAvoidedPlace } from "../places/rating.js";
import { skinSlot, skinRevision } from '../skins/skinStore.js';

/** 标记图：皮肤提供时用皮肤的图，否则用默认图（图片加载失败时也回到默认图，见 createMarkerParts） */
function markerIcon(slot, fallback) {
    const src = skinSlot(slot);
    return typeof src === 'string' && src ? src : fallback;
}

function setMarkerImage(img, src, fallback) {
    img.dataset.fallback = fallback;
    if (img.getAttribute('src') !== src) img.src = src;
}

/** 避雷图标：综合评价落在“均线之下 / 强烈拒绝”；没人评价时看“避雷”标签（见 rating.js） */
export function isThunderPlace(place) {
    return isAvoidedPlace(place);
}

export function createMarkerParts() {
    const root = document.createElement('div');
    root.className = 'fm-marker';
    const travel = document.createElement('div');
    travel.className = 'fm-marker__travel';
    const glyph = document.createElement('div');
    glyph.className = 'fm-marker__glyph';
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    img.decoding = 'async';
    img.addEventListener('error', () => {
        const fallback = img.dataset.fallback;
        if (fallback && img.getAttribute('src') !== fallback) img.src = fallback;
    });
    glyph.appendChild(img);
    const label = document.createElement('div');
    label.className = 'fm-marker__label';
    label.dataset.hidden = '';
    const hit = document.createElement('div');
    hit.className = 'fm-marker__hit';
    hit.setAttribute('role', 'button');
    hit.tabIndex = 0;
    travel.appendChild(glyph);
    travel.appendChild(label);
    travel.appendChild(hit);
    root.appendChild(travel);
    return { root, travel, glyph, img, count: null, label, hit, appearance: '' };
}

/** 只在外观真正变化时写 DOM（名称、收藏状态、主题变化只更新外观，不重建标记）。 */
export function applyNodeAppearance(parts, node, { selected = false } = {}) {
    const size = glyphSize(node);
    const place = node.kind === 'place' ? node.place || {} : null;
    const thunder = place ? isThunderPlace(place) : false;
    const name = place ? String(place.name || '') : '';
    const signature = `${node.kind}|${node.count}|${thunder}|${name}|${selected}|${skinRevision()}`;
    if (parts.appearance === signature) return size;
    parts.appearance = signature;

    const { root, glyph, img, label, hit } = parts;
    root.dataset.kind = node.kind;
    root.toggleAttribute('data-selected', !!selected);
    glyph.style.width = `${size.width}px`;
    glyph.style.height = `${size.height}px`;
    glyph.style.left = `${-size.width / 2}px`;
    glyph.style.top = `${-size.height}px`;

    const hitBox = hitSize(size);
    hit.style.width = `${hitBox.width}px`;
    hit.style.height = `${hitBox.height}px`;
    hit.style.left = `${-hitBox.width / 2}px`;
    hit.style.top = `${-Math.max(hitBox.height, size.height + 2)}px`;

    if (node.kind === 'cluster') {
        setMarkerImage(img, markerIcon('markers.cluster', unionIcon), unionIcon);
        if (!parts.count) {
            parts.count = document.createElement('div');
            parts.count.className = 'fm-marker__count';
            parts.count.setAttribute('aria-hidden', 'true');
            glyph.appendChild(parts.count);
        }
        const text = formatCount(node.count);
        parts.count.textContent = text;
        parts.count.style.fontSize = `${countFontSize(text, size.scale)}px`;
        label.textContent = '';
        label.dataset.hidden = '';
        hit.setAttribute('aria-label', t('map:marker.clusterLabel', { count: node.count }));
    } else {
        setMarkerImage(img, thunder ? markerIcon('markers.avoid', noIcon) : markerIcon('markers.place', yesIcon), thunder ? noIcon : yesIcon);
        if (parts.count) {
            parts.count.remove();
            parts.count = null;
        }
        label.textContent = name;
        label.title = name;
        label.toggleAttribute('data-thunder', thunder);
        hit.setAttribute('aria-label', name ? `${name}${thunder ? t('map:marker.avoidSuffix') : ''}` : t('map:marker.defaultLabel'));
    }
    return size;
}
