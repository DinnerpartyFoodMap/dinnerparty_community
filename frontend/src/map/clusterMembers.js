// 聚合成员列表（“此处有 N 家店”：最大缩放下仍重合、或相机放不大时点聚合打开）：
// 网页面板与 iOS 原生列表面板共用的行文案与行 id（纯函数，纳入 test:map 的 test-cluster-zoom）。
// iOS 原生控件接管时用原生玻璃列表面板（协议 v18 的 clusterMembers），与收藏、住民的地点列表同一种外观。
import { t } from '../i18n/index.js';
import { isAvoidedPlace } from '../places/rating.js';
import { sfSymbol } from '../platform/iconRegistry.js';
import { placeKey } from './cluster/engine.js';

/** 成员行的 id：与聚合引擎同一个 key（place:<id> / poi:amap:<id>） */
export function clusterMemberRowId(place) {
    return placeKey(place);
}

export function clusterMembersTitle(members) {
    return t('map:ui.clusterTitle', { count: members?.places?.length || 0 });
}

/** 行的第二行：标签与人均 */
export function clusterMemberDetail(place) {
    const category = place?.category || t('common:label.uncategorized');
    const cost = place?.per_person_cost != null ? t('common:label.perPersonCost', { per_person_cost: place.per_person_cost }) : '';
    return `${category}${cost}`;
}

/** 按行 id 找回成员（原生面板点按回传的 id） */
export function findClusterMember(members, rowId) {
    return (members?.places || []).find((place) => clusterMemberRowId(place) === rowId) || null;
}

/** iOS 原生列表面板快照（list 样式，同收藏、住民的地点列表） */
export function clusterMembersChromeSheet(members) {
    const places = members?.places || [];
    return {
        id: 'clusterMembers',
        title: clusterMembersTitle(members),
        size: 'list',
        sections: places.length ? [{
            id: 'places',
            rows: places.map((place) => ({
                id: clusterMemberRowId(place),
                title: place.name || t('common:label.unnamedPlace'),
                subtitle: clusterMemberDetail(place),
                symbol: sfSymbol('placeRow'),
                tone: isAvoidedPlace(place) ? 'danger' : undefined
            }))
        }] : []
    };
}
