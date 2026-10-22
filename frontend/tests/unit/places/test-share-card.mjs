// 分享卡片的数据与版式：npm run test:share-card
// Canvas 绘制需要浏览器环境，这里只核对可测的纯逻辑与版式边界。
import assert from 'node:assert/strict';
import {
    CARD_LAYOUTS,
    CARD_SIZE,
    DEFAULT_MAP_ZOOM,
    buildMapUrl,
    buildShareCardModel,
    sanitizeFileName,
    truncate
} from '../../../src/places/shareCard.js';

const basePlace = {
    name: '  PIPA枇杷小厨\n披萨研究所 ',
    category: '外国餐厅',
    description: ' 手工披萨\n现烤 ',
    address: '南边路2-12号',
    longitude: 113.26,
    latitude: 23.08
};

const baseOptions = {
    title: '东方饭联地图',
    subtitle: 'dinnerparty.cc',
    siteName: '东方饭联地图',
    tagline: '与饭搭子一起发现身边的好店',
    metaText: '人均 ¥80',
    ratingText: '推荐 4.5 · 12 人评价',
    scanHint: '扫码查看地点',
    url: 'https://dinnerparty.cc/p/1049216',
    mapServiceUrl: 'https://dinnerparty.cc/api/amap/staticmap',
    fallbackName: '地点',
    fallbackCategory: '未分类'
};

const model = buildShareCardModel(basePlace, baseOptions);
assert.equal(model.name, 'PIPA枇杷小厨 披萨研究所', '换行与多余空格压成一行');
assert.equal(model.category, '外国餐厅');
assert.equal(model.meta, '人均 ¥80  ·  推荐 4.5 · 12 人评价', '人均与评分合成一行');
assert.equal(model.address, '南边路2-12号');
assert.equal(model.description, '手工披萨 现烤', '简介压成一行');
assert.equal(model.subtitle, 'dinnerparty.cc');
assert.equal(model.hasCoordinates, true);
assert.equal(model.zoom, DEFAULT_MAP_ZOOM);
assert.equal(model.fileNameBase, 'PIPA枇杷小厨_披萨研究所');

// 缺字段时的回退与截断
const empty = buildShareCardModel({}, { ...baseOptions, metaText: '', ratingText: '' });
assert.equal(empty.name, '地点');
assert.equal(empty.category, '未分类');
assert.equal(empty.meta, '');
assert.equal(empty.address, '');
assert.equal(empty.description, '');
assert.equal(empty.hasCoordinates, false);
assert.equal(buildMapUrl(empty, 'portrait'), '', '没有坐标就不请求地图');

const longName = buildShareCardModel({ ...basePlace, name: '店'.repeat(40) }, baseOptions);
assert.equal(longName.name.length, 26);
assert.ok(longName.name.endsWith('…'));
const longDescription = buildShareCardModel({ ...basePlace, description: '好吃'.repeat(60) }, baseOptions);
assert.equal(longDescription.description.length, 80, '简介超长截断');
assert.ok(longDescription.description.endsWith('…'));
assert.equal(truncate('  多  空格  ', 10), '多 空格');

// 坐标越界按无坐标处理
assert.equal(buildShareCardModel({ ...basePlace, latitude: 91 }, baseOptions).hasCoordinates, false);
assert.equal(buildShareCardModel({ ...basePlace, longitude: 'abc' }, baseOptions).hasCoordinates, false);
// 非法缩放回落到默认值
assert.equal(buildShareCardModel(basePlace, { ...baseOptions, zoom: 21 }).zoom, DEFAULT_MAP_ZOOM);

// 静态地图请求：2x 尺寸正好铺满对应版式
const portraitUrl = new URL(buildMapUrl(model, 'portrait'));
assert.equal(portraitUrl.pathname, '/api/amap/staticmap');
assert.equal(portraitUrl.searchParams.get('location'), '113.26,23.08');
assert.equal(portraitUrl.searchParams.get('zoom'), '16');
assert.equal(portraitUrl.searchParams.get('scale'), '2');
assert.equal(portraitUrl.searchParams.get('size'), '536*350');

const landscapeUrl = new URL(buildMapUrl(model, 'landscape'));
assert.equal(landscapeUrl.searchParams.get('size'), '454*386');

// 版式：地图、二维码都在画布内，信息区不与二维码重叠
for (const [key, layout] of Object.entries(CARD_LAYOUTS)) {
    const size = CARD_SIZE[key];
    const map = layout.map;
    assert.ok(map.x >= 0 && map.y >= 0, `${key} 地图起点在画布内`);
    assert.ok(map.x + map.w <= size.width && map.y + map.h <= size.height, `${key} 地图不超出画布`);
    const qr = layout.qr;
    assert.ok(qr.x + qr.box <= size.width - 24, `${key} 二维码不压到外框`);
    assert.ok(qr.y + qr.box <= size.height - 24, `${key} 二维码不压到底框`);
    const separated = qr.x >= layout.name.x + layout.name.maxWidth || qr.y >= layout.name.bottom + 20;
    assert.ok(separated, `${key} 店名不会写进二维码区域`);
    // 简介、地址各两行时，最后一行仍在分隔线之上，且不写进二维码区域
    const lastAddressLine = layout.description.y + layout.description.lineHeight + layout.address.gap + layout.address.lineHeight;
    assert.ok(lastAddressLine + 10 <= layout.divider.y, `${key} 简介与地址不压分隔线`);
    const textClearOfQr = qr.x >= layout.description.x + layout.description.maxWidth || qr.y >= layout.divider.y;
    assert.ok(textClearOfQr, `${key} 简介不会写进二维码区域`);
    assert.ok(layout.scanHint.y < size.height - layout.border.hairline, `${key} 扫码提示在内框里`);
}

// 文件名去掉各平台不接受的字符
assert.equal(sanitizeFileName('PIPA/枇杷:小厨*?'), 'PIPA_枇杷_小厨');
assert.equal(sanitizeFileName('   '), 'place-card');

console.log('place share card tests passed');
