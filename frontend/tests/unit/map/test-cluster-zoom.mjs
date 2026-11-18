// 聚合相关的缩放决定：打开地点时放大到它单独显示；点聚合后的放大没到时补一次或打开成员列表。
import assert from 'node:assert/strict';
import { createEngine, placeKey } from '../../../src/map/cluster/engine.js';
import { standaloneZoom, revealZoom, clusterZoomOutcome, CLUSTER_ZOOM_MAX_RETRIES } from '../../../src/map/clusterZoom.js';

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
}

console.log('cluster zoom tests passed');
