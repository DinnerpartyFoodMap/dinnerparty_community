// Async numeric API migration: assertions unchanged; await remote computations.
(async()=>{
// 六类餐饮偏好（preferences/services/tasteAxes.js）、AI 搜索筛选（discovery/services/searchFilter.js）、
// App 发版信息（appRelease）与高德落地页链接解析（discovery/services/alongRoute.js）。临时 SQLite，不访问网络。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-taste-axes-'));
Object.assign(process.env, { LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', DB_FILE: path.join(temp, 'test.sqlite'), APP_RELEASE_DIR: path.join(temp, 'release') });
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const taste = require('../../modules/preferences/services/tasteAxes');
const { normalizeSearchFilter, searchFilterPredicate } = require('../../modules/discovery/services/searchFilter');
const appRelease = require('../../modules/appRelease/services/appRelease');
const { parseAmapRouteUrl, isAllowedAmapUrl } = require('../../modules/discovery/services/alongRoute');
const sql = db._raw;
async function main() {
    init();
    for (const value of [0,0.2,0.49,0.5,0.8]) assert.equal(taste.usableEmbeddingEstimate({value,percentile:value,usable:false}).value,value,'all valid percentiles must remain displayable');
    for (const value of [null,undefined,NaN,-0.1,1.1]) assert.equal(taste.usableEmbeddingEstimate({value}),null);
    // 1. 规则分类：分类名关键词（多类可以同时成立）、店名强关键词、“法式甜品”不算异国料理；判断不了时为空
    assert.deepEqual(taste.ruleAxes({ category: '广东菜(粤菜), 甜品店' }), ['homestyle', 'dessert']);
    assert.deepEqual(taste.ruleAxes({ category: '法式甜品' }), ['dessert']);
    assert.deepEqual(taste.ruleAxes({ category: '意式咖啡' }), ['drinks']);
    assert.deepEqual(taste.ruleAxes({ category: '意大利菜, 咖啡' }), ['drinks','foreign']);
    assert.deepEqual(taste.ruleAxes({ category: '其他', name: '老王火锅' }), ['hotpotBbq']);
    assert.deepEqual(taste.ruleAxes({ category: '茶餐厅' }), ['noodles'], '茶餐厅 is not a drinks shop');
    assert.deepEqual(taste.ruleAxes({ category: '日本料理' }), ['foreign']);
    assert.deepEqual(taste.ruleAxes({ category: '咖啡厅', name:'意式咖啡' }), ['drinks']);
    assert.deepEqual(taste.ruleAxes({ category: '其他', name: '某某小馆' }), []);
    const users = {};
    for (const name of ['eater', 'creator', 'fan', 'peer']) {
        users[name] = randomUUID();
        sql.prepare('INSERT INTO User (id, username, password) VALUES (?, ?, ?)').run(users[name], name, 'x');
    }
    const addPlace = (name, category) => Number(sql.prepare(`INSERT INTO Place (name, category, latitude, longitude, creator_id)
        VALUES (?, ?, 23.1, 113.3, ?)`).run(name, category, users.creator).lastInsertRowid);
    const hotpot = addPlace('火锅一号', '火锅店');
    const hotpot2 = addPlace('火锅二号', '火锅店');
    const cafe = addPlace('咖啡馆', '咖啡厅');
    const mystery = addPlace('某某小馆', '其他');
    const rate = (who, place, score, source = 'user') => {
        sql.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0)`).run(place, users[who], score, source);
        if (source === 'user') require('../../modules/ratings/services/ratingHistory').appendRatingRevision({userId:users[who],placeId:place,before:null,after:{score},action:'rate',origin:'active'});
    };
    const axis = (list, key) => list.find((item) => item.key === key);
    // 2. 创建与迁移时补的评价不算偏好：只有这些评价的住民，六轴都是“待了解”
    rate('creator', hotpot, 4, 'create');
    rate('creator', cafe, 4, 'migration');
    assert.ok((await taste.userTasteAxes(users.creator)).every((item) => item.value === null && item.basis === null));
    assert.ok((await taste.userTasteAxes(users.creator)).every(item => item.unavailable_reason === 'no_eligible_evidence'));
    require('../../modules/ratings/services/ratingHistory').appendRatingRevision({userId:users.creator,placeId:hotpot,before:null,after:{score:4},action:'create',origin:'creation_explicit'});
    assert.equal(axis(await taste.userTasteAxes(users.creator),'hotpotBbq').basis,'evidence','explicit creation vote qualifies');
    // 3. 自己的评价是主要依据；同一家店只算一份证据；一次好评向全站水平收缩，不会满分
    rate('eater', hotpot, 4);
    taste.resetTastePopulationCache();
    let eater = await taste.userTasteAxes(users.eater);
    const hot = axis(eater, 'hotpotBbq');
    assert.equal(hot.basis, 'evidence');
    assert.equal(hot.store_count, 1);
    assert.equal(hot.positive_count, 1);
    assert.ok(hot.value > 0.5 && hot.value < 1, `one good rating is shrunk (${hot.value})`);
    assert.deepEqual(hot.sources, ['rating']);
    assert.deepEqual(hot.places.map((place) => place.id), [hotpot]);
    assert.ok(!('latitude' in hot.places[0]), 'representative shops carry no coordinates');
    assert.equal(axis(eater, 'drinks').value, null);
    // 更多好评 → 更高
    rate('eater', hotpot2, 4);
    taste.resetTastePopulationCache();
    eater = await taste.userTasteAxes(users.eater);
    assert.ok(axis(eater, 'hotpotBbq').value > hot.value);
    assert.equal(axis(eater, 'hotpotBbq').store_count, 2);
    // 4. 只收藏：弱线索，算依据但不是好评
    sql.prepare('INSERT INTO Favorite (user_id, place_id) VALUES (?, ?)').run(users.fan, cafe);
    const fan = await taste.userTasteAxes(users.fan);
    assert.equal(axis(fan, 'drinks').basis, 'evidence');
    assert.equal(axis(fan, 'drinks').favorite_count, 1);
    assert.equal(axis(fan, 'drinks').positive_count, 0);
    assert.deepEqual(axis(fan, 'drinks').sources, ['favorite']);
    assert.ok(axis(fan, 'drinks').value > 0.5 && axis(fan, 'drinks').value < axis(eater, 'hotpotBbq').value);
    // 5. 差评向下；自己填的覆盖自动推断，清除后回到自动
    rate('peer', hotpot, 1);
    taste.resetTastePopulationCache();
    assert.ok(axis(await taste.userTasteAxes(users.peer), 'hotpotBbq').value < 0.5);
    assert.equal(taste.setSelfLevel(users.peer, 'hotpotBbq', 4), true);
    assert.equal(axis(await taste.userTasteAxes(users.peer), 'hotpotBbq').basis, 'self');
    assert.equal(axis(await taste.userTasteAxes(users.peer), 'hotpotBbq').value, 1);
    assert.equal(taste.setSelfLevel(users.peer, 'hotpotBbq', null), true);
    assert.equal(axis(await taste.userTasteAxes(users.peer), 'hotpotBbq').basis, 'evidence');
    assert.equal(taste.setSelfLevel(users.peer, 'nope', 3), false);
    assert.equal(taste.setSelfLevel(users.peer, 'drinks', 7), false);
    // 6. 人工纠正优先于规则；撤销后回到规则
    assert.deepEqual(taste.setManualPlaceAxes(cafe, ['dessert']).axes, ['dessert']);
    assert.equal(taste.placeTasteClass(cafe).source, 'manual');
    assert.equal(axis(await taste.userTasteAxes(users.fan), 'drinks').value, null);
    assert.equal(axis(await taste.userTasteAxes(users.fan), 'dessert').favorite_count, 1);
    assert.deepEqual(taste.setManualPlaceAxes(cafe, null).axes, ['drinks']);
    // 7. 模型补分类：只问规则分不出的店；回了空数组记为“未知”且内容不变就不再问；不覆盖人工结果
    assert.deepEqual(taste.pendingLlmPlaces(10).map((place) => place.id), [mystery]);
    let asked = null;
    const fake = async ({ user }) => { asked = JSON.parse(user); return { results: [{ id: mystery, axes: ['homestyle', 'bogus'] }] }; };
    assert.equal(await taste.classifyBatchWithLlm(taste.pendingLlmPlaces(10), sql, fake), 1);
    assert.deepEqual(asked.places.map((place) => place.id), [mystery]);
    assert.deepEqual(taste.placeTasteClass(mystery), { place_id: mystery, axes: ['homestyle'], source: 'llm', rule_axes: [] });
    assert.deepEqual(taste.pendingLlmPlaces(10), [], 'already classified with the same content');
    sql.prepare("UPDATE Place SET description = '换了简介' WHERE id = ?").run(mystery);
    assert.deepEqual(taste.pendingLlmPlaces(10).map((place) => place.id), [mystery], 'content changed → ask again');
    taste.setManualPlaceAxes(mystery, []);
    assert.deepEqual(taste.pendingLlmPlaces(10), [], 'manual result is never overwritten');
    assert.equal(taste.placeTasteClass(mystery).source, 'manual');
    const malformed = addPlace('尚未分类', '其他');
    for (const axes of [undefined, 'drinks', null, ['not-an-axis']]) {
        assert.equal(await taste.classifyBatchWithLlm([{...sql.prepare('SELECT * FROM Place WHERE id=?').get(malformed)}], sql, async()=>({results:[{id:malformed,axes}]})),0);
        assert.ok(taste.pendingLlmPlaces(20).some(p=>p.id===malformed),'malformed axes must retry');
    }
    assert.equal(await taste.classifyBatchWithLlm([sql.prepare('SELECT * FROM Place WHERE id=?').get(malformed)], sql, async()=>({results:[{id:malformed,axes:[]}]})),1);
    assert.ok(!taste.pendingLlmPlaces(20).some(p=>p.id===malformed),'valid empty classification is cached');
    assert.ok(Math.abs(taste.normalCdf(0) - 0.5) < 1e-6 && taste.normalCdf(1.96) > 0.97 && taste.normalCdf(-1.96) < 0.03);
    // 8. AI 搜索筛选：标签必须是现有分类，人均范围整理好；什么都没有时为 null
    const categories = ['火锅店', '烧烤', '甜品店'];
    assert.deepEqual(normalizeSearchFilter({ tags: ['火锅店', '编的标签', '火锅店'], min_cost: 80, max_cost: '30.4' }, categories), { tags: ['火锅店'], exclude_tags: [], min_cost: 30, max_cost: 80 });
    assert.deepEqual(normalizeSearchFilter({ tags: [], min_cost: 0, max_cost: 40 }, categories), { tags: [], exclude_tags: [], min_cost: null, max_cost: 40 });
    assert.deepEqual(normalizeSearchFilter({ tags: ['火锅店', '烧烤'], exclude_tags: ['烧烤', '编的'] }, categories), { tags: ['火锅店'], exclude_tags: ['烧烤'], min_cost: null, max_cost: null }, 'a tag in both lists counts as excluded');
    assert.deepEqual(normalizeSearchFilter({ exclude_tags: ['甜品店'] }, categories), { tags: [], exclude_tags: ['甜品店'], min_cost: null, max_cost: null });
    assert.equal(normalizeSearchFilter({ tags: ['不存在'] }, categories), null);
    assert.equal(normalizeSearchFilter(null, categories), null);
    assert.equal(searchFilterPredicate(null), null);
    const accept = searchFilterPredicate({ tags: ['火锅店', '烧烤'], exclude_tags: ['甜品店'], min_cost: null, max_cost: 60 });
    assert.equal(accept({ category: '烧烤', per_person_cost: 50 }), true);
    assert.equal(accept({ category: '烧烤, 甜品店', per_person_cost: 50 }), false, 'excluded tags win over included ones');
    assert.equal(accept({ category: '粤菜', per_person_cost: 50 }), false);
    assert.equal(accept({ category: '火锅店', per_person_cost: 80 }), false);
    // 9. App 发版信息：读服务器本地的 release.json；安装包只能是目录里的 .apk 文件名
    fs.mkdirSync(path.join(temp, 'release'));
    assert.equal(appRelease.getReleases().android.build, null, 'no release file yet');
    assert.equal(appRelease.getReleases().ios.url, appRelease.DEFAULT_IOS_URL);
    fs.writeFileSync(path.join(temp, 'release', 'release.json'), JSON.stringify({
        android: { build: 30, version: '2.3.0', notes: '说明', file: '../secret.apk' },
        ios: { build: 31, url: 'http://not-https.example.com' }
    }));
    let releases = appRelease.getReleases();
    assert.deepEqual([releases.android.build, releases.android.available], [30, false], 'path-like file names are refused');
    assert.equal(releases.ios.url, appRelease.DEFAULT_IOS_URL, 'only https links');
    fs.writeFileSync(path.join(temp, 'release', 'app.apk'), 'apk');
    fs.writeFileSync(path.join(temp, 'release', 'release.json'), JSON.stringify({ android: { build: 32, file: 'app.apk' } }));
    releases = appRelease.getReleases();
    assert.deepEqual([releases.android.build, releases.android.available], [32, true]);
    assert.equal(appRelease.androidApk().name, 'app.apk');
    // 10. 顺路吃：surl.amap.com 短链会跳到 gaode.com 的落地页，起终点在内嵌的 amapuri 链接里
    const landing = new URL('https://static5.gaode.com/activity/2020CommonLanding97/index.html?id=263&schema='
        + encodeURIComponent('amapuri://busnavi/BusDetailPage?shareParam=x&slat=22.847225&slon=113.50001&sname=起点&dlat=23.557566&dlon=113.615098&dname=终点')
        + '&share_from=busnavi_BusDetailPage');
    assert.equal(isAllowedAmapUrl(landing), true);
    assert.deepEqual(parseAmapRouteUrl(landing), {
        origin: { lng: 113.50001, lat: 22.847225, name: '起点' },
        destination: { lng: 113.615098, lat: 23.557566, name: '终点' },
        mode: 'transit',
        waypoints: []
    });
    for (const bad of ['https://gaode.com.evil.cn/x', 'https://evilgaode.com/x', 'https://evilamap.com/x']) {
        assert.equal(isAllowedAmapUrl(new URL(bad)), false, bad);
    }
    // 内嵌的链接只读参数：不是高德 App 链接的 schema 不算
    const foreign = new URL(`https://static5.gaode.com/x?schema=${encodeURIComponent('https://evil.example.com/?slat=1&slon=2&dlat=3&dlon=4')}`);
    assert.equal(parseAmapRouteUrl(foreign), null);
    // Real vector fallback below the median must remain a valid estimate,
    // including an extreme rounded zero. A cancelled prototype remains unknown.
    if (require('../../infrastructure/database').isVectorSearchAvailable()) {
        for (const [id,x,y] of [[cafe,1,0],[mystery,-1,0],[hotpot,0,1],[hotpot2,0,-1]]) {
            const v=new Float32Array(1024);v[0]=x;v[1]=y;
            sql.prepare('INSERT INTO place_vectors(place_id,embedding) VALUES(?,?)').run(BigInt(id),Buffer.from(v.buffer));
            sql.prepare('UPDATE Place SET has_vector=1 WHERE id=?').run(id);
        }
        rate('eater',mystery,4);
        const [parallel] = await Promise.all([taste.userTasteAxes(users.eater),taste.userTasteAxes(users.fan)]);
        const low=axis(parallel,'drinks');
        assert.equal(low.basis,'embedding');assert.ok(low.value>=0&&low.value<0.5);assert.equal(low.unavailable_reason,null);
        const old=low.value;
        sql.prepare('UPDATE Place SET category=? WHERE id=?').run('日本料理',cafe);
        const changed=axis(await taste.userTasteAxes(users.eater),'drinks');
        // Name still classifies it as coffee: clearing that name removes the prototype.
        sql.prepare('UPDATE Place SET name=? WHERE id=?').run('新店',cafe);
        assert.equal(axis(await taste.userTasteAxes(users.eater),'drinks').unavailable_reason,'missing_prototype','classification changes invalidate cached prototype without manual reset');
        assert.ok(Number.isFinite(old));
    }
    console.log('Taste axes, explicit sources, low embedding estimates, malformed classifier retry, cache invalidation and support services passed.');
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    try {
        db._raw.close();
    }
    catch { /* 已关闭 */ }
    fs.rmSync(temp, { recursive: true, force: true });
});

})().catch(error=>{console.error(error);process.exitCode=1;});
