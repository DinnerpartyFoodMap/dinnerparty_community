// 聚合相关的缩放决定：打开地点时放大到它单独显示；点聚合后的放大没到时补一次或打开成员列表。
import assert from 'node:assert/strict';
import { createEngine, placeKey } from '../../../src/map/cluster/engine.js';
import { standaloneZoom, revealZoom, clusterZoomOutcome, nextClusterZoom, CLUSTER_ZOOM_MAX_RETRIES } from '../../../src/map/clusterZoom.js';
import { clusterMembersChromeSheet, findClusterMember, clusterMemberRowId } from '../../../src/map/clusterMembers.js';
import { sanitizeSheet, NATIVE_SHEETS } from '../../../src/platform/nativeMapChrome.js';

// ---- 打开地点：放大到它单独显示 ----
{
    // 甲乙相距约 20 米（18 级以上才分开），丙在 2 公里外
    const places = [
        { id: 1, name: '甲', longitude: 113.3000, latitude: 23.1000 },
        { id: 2, name: '乙', longitude: 113.3002, latitude: 23.1000 },
        { id: 3, name: '丙', longitude: 113.3200, latitude: 23.1000 },
        { id: 4, name: '重合', longitude: 113.3400, latitude: 23.1000 },
        { id: 5, name: '重合二', longitude: 113.3400, latitude: 23.1000 }
    ];
    const engine = createEngine(places, { maxZoom: 20 });
    const first = standaloneZoom(engine, places[0], 10);
    assert.ok(first > 17 && first <= 20, `相距 20 米的两家店 17 级仍在一起，更高层级分开（实际 ${first}）`);
    assert.equal(engine.query([113.29, 23.09, 113.31, 23.11], first).some((node) => node.key === placeKey(places[0])), true, '那一级确实单独显示');
    assert.equal(engine.query([113.29, 23.09, 113.31, 23.11], first - 1).some((node) => node.key === placeKey(places[0])), false, '低一级还在聚合里');
    assert.equal(standaloneZoom(engine, places[2], 14), 14, '附近没有别的店：从起点就单独显示');
    assert.equal(standaloneZoom(engine, places[3], 10), null, '坐标重合：到最大层级也分不开');
    assert.equal(standaloneZoom(engine, { id: 99, longitude: 113.3, latitude: 23.1 }, 10), null, '引擎里没有的地点');

    assert.equal(revealZoom({ engine, place: places[0], baseZoom: 17, maxZoom: 20 }), first, '列表点开：17 级被聚合时放大到单独显示');
    assert.equal(revealZoom({ engine, place: places[2], baseZoom: 17, maxZoom: 20 }), 17, '17 级已单独显示：保持 17 级');
    assert.equal(revealZoom({ engine, place: places[0], baseZoom: 17, maxZoom: first - 1 }), first - 1, '不超过地图的最大缩放');
    assert.equal(revealZoom({ engine, place: places[3], baseZoom: 17, maxZoom: 20 }), 17, '坐标重合：放大没有用，保持基准层级');

    // 地点还不在标记数据里（筛选掉了、快照还没有它）：按“现有地点 + 它”算
    const outsider = { id: 6, name: '新店', longitude: 113.3203, latitude: 23.1000 };
    const zoom = revealZoom({ engine, place: outsider, baseZoom: 16, maxZoom: 20 });
    const withOutsider = createEngine([...places, outsider], { maxZoom: 20 });
    assert.equal(zoom, standaloneZoom(withOutsider, outsider, 16), '把它加进现有地点后计算');
    assert.ok(zoom > 16 && zoom <= 20, '与丙相距约 30 米，16 级仍在一起');
    assert.equal(revealZoom({ engine: null, place: places[0], baseZoom: 16, maxZoom: 20 }), 16, '还没有标记层：只有它自己，基准层级即可');
    assert.equal(revealZoom({ engine, place: { name: '没有 id 和坐标' }, baseZoom: 16, maxZoom: 20 }), 16);
}

// ---- 点聚合后的放大 ----
{
    const base = { expansion: 14, targetZoom: 14, previousZoom: 13, attempts: 0 };
    assert.equal(clusterZoomOutcome({ ...base, zoom: 14, logicalZoom: 14 }), 'done', '到了展开层级');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.9, logicalZoom: 14 }), 'done', '聚合层级已到（含滞回）就算拆开了');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.97, logicalZoom: 13 }), 'done', '与目标差不到 0.05 算到了');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.13, logicalZoom: 13 }), 'retry', '动画被打断停在半路（安卓点按补发的 mousedown）：再放大');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.01, logicalZoom: 13 }), 'retry', '第一次没进展也再试一次');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13, logicalZoom: 13, moved: false }), 'members', '相机没动（已在可达的最大缩放）：打开成员列表');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.6, logicalZoom: 13, previousZoom: 13.13, attempts: 1 }), 'retry', '补放大有进展：继续');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.13, logicalZoom: 13, previousZoom: 13.13, attempts: 1 }), 'members', '补放大没进展（MapKit 到不了目标层级）：打开成员列表');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.8, logicalZoom: 13, previousZoom: 13.6, attempts: CLUSTER_ZOOM_MAX_RETRIES }), 'members', '补放大次数有上限');
    assert.equal(clusterZoomOutcome({ ...base, zoom: NaN }), 'done', '读不到缩放时不再跟进');

    // iOS：MapKit 把请求放进自己的可见区域，每次都差同样多（13→14 落在 13.37）。补放大多要差掉的那一截
    assert.equal(nextClusterZoom({ targetZoom: 14, requestedZoom: 14, zoom: 13.37, maxZoom: 20, compensate: true }), 14.63);
    assert.equal(clusterZoomOutcome({ ...base, zoom: 13.37, logicalZoom: 13 }), 'retry', '第一次落在 13.37：补放大');
    assert.equal(clusterZoomOutcome({ ...base, zoom: 14, logicalZoom: 14, previousZoom: 13.37, attempts: 1 }), 'done', '多要 0.63 后正好落到 14，聚合拆开');
    assert.equal(nextClusterZoom({ targetZoom: 14, requestedZoom: 14.63, zoom: 13.8, maxZoom: 20, compensate: true }), 14.83, '还差就继续累加');
    assert.equal(nextClusterZoom({ targetZoom: 19, requestedZoom: 19, zoom: 18.2, maxZoom: 20, compensate: true }), 19.8);
    assert.equal(nextClusterZoom({ targetZoom: 19, requestedZoom: 19.8, zoom: 18.2, maxZoom: 20, compensate: true }), 20, '不超过地图最大缩放');
    assert.equal(clusterZoomOutcome({ expansion: 19, targetZoom: 19, zoom: 18.2, logicalZoom: 18, previousZoom: 18.2, attempts: 1 }), 'members',
        'MapKit 到不了 19 级：补放大没进展，打开成员列表');
    // 高德：动画被打断，再要同一个目标
    assert.equal(nextClusterZoom({ targetZoom: 14, requestedZoom: 14, zoom: 13.13, maxZoom: 20, compensate: false }), 14);
    assert.equal(nextClusterZoom({ targetZoom: 14, requestedZoom: 14, zoom: 14.2, maxZoom: 20, compensate: true }), 14, '多放大了不往回补');
}

// ---- 成员列表（“此处有 N 家店”）：iOS 原生列表面板 ----
{
    const members = { key: 'cluster:1:5', places: [
        { id: 7, name: '甲', category: '拉面', per_person_cost: 40, longitude: 113.3, latitude: 23.1 },
        { id: 8, name: '', category: '', longitude: 113.3, latitude: 23.1, rating_count: 3, rating_average: 1.2 },
        { id: 'amap_B0', isMarked: false, name: '未收录', longitude: 113.3, latitude: 23.1 }
    ] };
    const sheet = clusterMembersChromeSheet(members);
    assert.equal(sheet.id, 'clusterMembers');
    assert.equal(sheet.title, '此处有 3 家店');
    assert.equal(sheet.size, 'list', '与收藏、住民的地点列表同一种原生面板');
    assert.deepEqual(sheet.sections[0].rows.map((row) => row.id), ['place:7', 'place:8', 'poi:amap:B0']);
    assert.equal(sheet.sections[0].rows[0].subtitle, '拉面 · 人均 ¥40');
    assert.equal(sheet.sections[0].rows[1].title, '未命名地点');
    assert.equal(sheet.sections[0].rows[1].tone, 'danger', '避雷的店标红');
    assert.equal(findClusterMember(members, 'place:8'), members.places[1]);
    assert.equal(findClusterMember(members, 'place:404'), null);
    assert.equal(clusterMemberRowId(members.places[2]), 'poi:amap:B0');
    assert.ok(NATIVE_SHEETS.includes('clusterMembers'));
    const clean = sanitizeSheet({ ...sheet, token: 4 });
    assert.equal(clean.id, 'clusterMembers', '原生桥接接受这个面板');
    assert.equal(clean.sections[0].rows.length, 3);
    assert.equal('longitude' in clean.sections[0].rows[0], false, '不向原生传坐标');
    assert.deepEqual(clusterMembersChromeSheet(null).sections, []);
}

console.log('cluster zoom tests passed');
