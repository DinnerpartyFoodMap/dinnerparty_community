// 新增地点的 AI 初筛与人工复核（modules/places/doc/placeModeration.md）：本地规则、模型回答解析、
// 提示词与文档一致、状态流转（通过 / 拦下 / 复查 / 驳回 / 重新提交 / 删除）、对他人的可见性、
// 群推送延后，以及复用地点申请的复核接口。临时 SQLite + 本地 express，模型调用用替身，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-moderation-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false', SILICONFLOW_API_KEY: '', DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'), PLACE_MODERATION_ENABLED: 'true'
});
delete process.env.PLACE_MODERATION_MAX_CHECKS;
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

const express = require('express');
const jwt = require('jsonwebtoken');
const sharp = require('sharp');
const { db, init } = require('../../infrastructure/database');
const botConfig = require('../../modules/qqbot/runtime/config');
const moderation = require('../../modules/places/services/placeModeration');
const { enqueuePlaceCreatedNotifications } = require('../../modules/places/services/placeNotifications');
const sql = db._raw;
const GROUP = '700000001';

function unitChecks() {
    const { ruleBrief, parseTextVerdict, parseVisionVerdict, decide, readConfig } = moderation;
    for (const text of [null, '', '   ', '暂无描述', '无', '求探', '**冰**', '史', '。。。', '111', '啊啊啊', '😋😋', 'test', '<p>  </p>']) {
        assert.equal(ruleBrief(text, 'web'), true, `brief: ${JSON.stringify(text)}`);
    }
    for (const text of ['不好吃', '夯，实诚', '河粉好吃喵', '臊子面和肉夹馍好吃']) assert.equal(ruleBrief(text, 'web'), false, text);
    assert.equal(ruleBrief('', 'diary'), false, 'diary markers keep their description in the diary');

    assert.equal(parseTextVerdict('not an object', 'web'), null);
    assert.deepEqual(parseTextVerdict({ flagged: true, reasons: ['unrelated', 'image', 'x', 'unrelated'], confidence: 3, summary: ' 电影院 ' }, 'web'),
        { flagged: true, reasons: ['unrelated'], confidence: 1, summary: '电影院' });
    assert.equal(parseTextVerdict({ flagged: true, reasons: [], confidence: 0.9, summary: 'x' }, 'web').flagged, false, 'no known reason, no flag');
    assert.equal(parseTextVerdict({ flagged: true, reasons: ['brief'], confidence: 0.9 }, 'diary').flagged, false, 'brief ignored for diary');
    assert.deepEqual(parseVisionVerdict({ flagged: true, images: [3, 1, 9, '2', 0, 1], confidence: 0.8, summary: '二维码' }, 3),
        { flagged: true, images: [1, 2, 3], confidence: 0.8, summary: '二维码' });

    const ok = (extra) => ({ status: 'ok', flagged: false, reasons: [], confidence: 0, summary: '', ...extra });
    assert.deepEqual(decide({ rule: { brief: false }, text: ok({ flagged: true, reasons: ['harmful'], confidence: 0.69 }), vision: { status: 'skipped' } }, 0.7),
        { flagged: false, reasons: [] }, 'below the confidence threshold');
    assert.deepEqual(decide({ rule: { brief: true }, text: ok({ flagged: true, reasons: ['unrelated'], confidence: 0.9 }), vision: ok({ flagged: true, confidence: 0.95 }) }, 0.7),
        { flagged: true, reasons: ['brief', 'unrelated', 'image'] });
    assert.deepEqual(decide({ rule: { brief: false }, text: { status: 'error' }, vision: { status: 'error' } }, 0.7), { flagged: false, reasons: [] }, 'failures pass');

    const config = readConfig({ PLACE_MODERATION_MIN_CONFIDENCE: '2', PLACE_MODERATION_MAX_CHECKS: 'x', PLACE_MODERATION_MODEL: ' deepseek-flash ' });
    assert.deepEqual([config.enabled, config.minConfidence, config.maxChecks, config.model], [true, 1, 4, 'deepseek-flash']);
    assert.equal(readConfig({}).model, '', 'empty = DEEPSEEK_MODEL');
    assert.equal(readConfig({ PLACE_MODERATION_ENABLED: 'FALSE' }).enabled, false);

    // 提示词改了要同步文档
    const doc = fs.readFileSync(path.join(__dirname, '../../modules/places/doc/placeModeration.md'), 'utf8');
    const block = (heading) => doc.split(heading)[1].split('```text\n')[1].split('\n```')[0];
    assert.equal(block('### 文本初筛'), moderation.TEXT_SYSTEM_PROMPT, 'text prompt matches the document');
    assert.equal(block('### 图片初筛'), moderation.VISION_SYSTEM_PROMPT, 'vision prompt matches the document');
    const payload = JSON.parse(moderation.textUserPayload({ name: '店', category: '面馆，小吃', description: '**牛肉面**', per_person_cost: 20, menu_images: '["/uploads/a.jpg"]' }, 'qq_bot'));
    assert.deepEqual(payload, { source: 'qq_bot', name: '店', categories: ['面馆', '小吃'], description: '牛肉面', address: '', per_person_cost: 20, image_count: 1 });
}

// 模型替身：按店名决定回答，记录每次调用
const calls = { text: [], vision: [] };
let textBehavior = null;
let textGate = null; // 未释放前模型不回答，用来观察 checking 状态
let server = null;
function useFakeModels() {
    moderation.setClientsForTesting({
        retryDelayMs: 0,
        textAvailable: () => true,
        visionAvailable: () => true,
        loadImage: async () => sharp({ create: { width: 1600, height: 900, channels: 3, background: '#cc8844' } }).png().toBuffer(),
        text: async ({ system, user }) => {
            assert.equal(system, moderation.TEXT_SYSTEM_PROMPT);
            const input = JSON.parse(user);
            calls.text.push(input);
            if (textGate) await textGate.promise;
            if (textBehavior) return textBehavior(input);
            if (input.name.includes('电影院')) return { flagged: true, reasons: ['unrelated'], confidence: 0.9, summary: '电影院与美食和东方无关' };
            if (input.name.includes('广告')) return { flagged: true, reasons: ['harmful'], confidence: 0.95, summary: '加微信引流' };
            if (input.name.includes('拿不准')) return { flagged: true, reasons: ['harmful'], confidence: 0.5, summary: '可能有问题' };
            return { flagged: false, reasons: [], confidence: 0.05, summary: '' };
        },
        vision: async ({ system, text, images }) => {
            assert.equal(system, moderation.VISION_SYSTEM_PROMPT);
            calls.vision.push({ text, images });
            images.forEach((url) => assert.match(url, /^data:image\/jpeg;base64,/));
            const sizes = await Promise.all(images.map((url) => sharp(Buffer.from(url.split(',')[1], 'base64')).metadata()));
            sizes.forEach((meta) => assert.ok(Math.max(meta.width, meta.height) <= 768, 'images are shrunk before sending'));
            return text.includes('菜单')
                ? { flagged: true, images: [images.length], confidence: 0.9, summary: `第 ${images.length} 张有个人二维码` }
                : { flagged: false, images: [], confidence: 0.02, summary: '' };
        }
    });
}

async function main() {
    unitChecks();
    init();
    botConfig.setForTesting({ enabled: true, notify: { enabled: true, groupIds: [GROUP] } });
    useFakeModels();

    const users = {}, tokens = {};
    for (const [name, level] of [['owner', null], ['other', null], ['admin', 'YOUMU']]) {
        users[name] = randomUUID();
        sql.prepare('INSERT INTO User (id, username, password, admin_level) VALUES (?, ?, ?, ?)').run(users[name], name, 'x', level);
        tokens[name] = jwt.sign({ id: users[name] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    }
    const { requireAuth } = require('../../modules/accounts/middleware/auth');
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    app.use('/p', require('../../modules/places/routes/placeShare'));
    app.use('/api', require('../../modules/discovery/routes/search'));
    app.use('/api/favorites', require('../../modules/preferences/routes/favorites'));
    app.use('/api/ratings', require('../../modules/ratings/routes/placeRatings'));
    app.use('/comments', require('../../modules/community/routes/comments'));
    app.use('/api/admin-check', requireAuth, (req, res) => res.json({ ok: true }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, url, who, body) => {
        const headers = { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${who === 'expired' ? 'not-a-jwt' : tokens[who]}` } : {}) };
        const res = await fetch(base + url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch (_) { }
        return { status: res.status, body: json, text };
    };
    const nearbyIds = async (who) => (await call('GET', '/places/nearby?minLng=110&minLat=20&maxLng=120&maxLat=30', who)).body.map((p) => p.id).sort((a, b) => a - b);
    const statusOf = (id) => sql.prepare('SELECT moderation_status FROM Place WHERE id = ?').get(id)?.moderation_status;
    const notified = (id) => sql.prepare('SELECT COUNT(*) AS n FROM QQBotNotification WHERE place_id = ?').get(id).n;
    const openRequest = (id) => sql.prepare("SELECT * FROM PlaceRequest WHERE place_id = ? AND request_type = 'create' AND status = 'pending'").get(id);
    const create = async (who, fields) => {
        const res = await call('POST', '/places', who, { latitude: 23.1, longitude: 113.3, description: '招牌牛肉面，汤底浓，人均二十', ...fields });
        assert.equal(res.status, 200, res.text);
        return res.body;
    };
    const idle = () => moderation.waitForModerationIdle();

    // 1. 正常地点：先 checking（只有自己看得到、没有群推送），初筛通过后公开并推送
    let release;
    textGate = { promise: new Promise((resolve) => { release = resolve; }) };
    const good = await create('owner', { name: '好吃牛肉面' });
    assert.equal(good.moderation_status, 'checking');
    assert.equal(notified(good.id), 0, 'no group push before the check passes');
    assert.deepEqual(await nearbyIds('other'), []);
    assert.deepEqual(await nearbyIds('owner'), [good.id], 'the creator sees it at once');
    textGate = null;
    release();
    await idle();
    assert.equal(statusOf(good.id), 'visible');
    assert.equal(notified(good.id), 1);
    assert.deepEqual(await nearbyIds(null), [good.id]);
    const goodJob = sql.prepare('SELECT * FROM PlaceModeration WHERE place_id = ?').get(good.id);
    assert.deepEqual([goodJob.status, goodJob.checks, goodJob.source], ['passed', 1, 'web']);
    assert.equal(JSON.parse(goodJob.report).vision.reason, 'no_images');

    // 2. 与美食和东方无关：拦下，开一条新增复核申请；对别人完全不存在
    const cinema = await create('owner', { name: '万达电影院', category: '其他' });
    await idle();
    assert.equal(statusOf(cinema.id), 'pending');
    assert.equal(notified(cinema.id), 0);
    const request = openRequest(cinema.id);
    assert.ok(request, 'review request created');
    assert.equal(request.requester_id, users.owner);
    assert.match(request.note, /电影院/);
    assert.deepEqual(JSON.parse(request.moderation).decision, { flagged: true, reasons: ['unrelated'] });
    assert.equal(JSON.parse(request.proposed).name, '万达电影院');
    assert.deepEqual(await nearbyIds('other'), [good.id]);
    assert.deepEqual(await nearbyIds('expired'), [good.id], 'an invalid token falls back to guest instead of 401');
    assert.deepEqual(await nearbyIds('owner'), [good.id, cinema.id]);
    assert.equal((await call('GET', `/places/${cinema.id}`, 'other')).status, 404);
    assert.equal((await call('GET', `/places/${cinema.id}`, null)).status, 404);
    assert.equal((await call('GET', `/places/${cinema.id}`, 'owner')).body.moderation_status, 'pending');
    assert.equal((await call('GET', `/places/${cinema.id}`, 'admin')).status, 200, 'admins can open it from the review list');
    assert.equal((await call('GET', '/places', 'other')).body.some((p) => p.id === cinema.id), false);
    assert.equal((await call('GET', `/api/places/search/fast?q=${encodeURIComponent('电影院')}`, 'other')).body.length, 0);
    assert.equal((await call('GET', `/api/places/search/fast?q=${encodeURIComponent('电影院')}`, 'owner')).body.length, 1);
    assert.equal((await call('GET', `/p/${cinema.id}`, null)).status, 404, 'share page');
    assert.equal((await call('POST', `/api/favorites/${cinema.id}`, 'other')).status, 404);
    assert.equal((await call('POST', `/api/favorites/${cinema.id}`, 'owner')).status, 200, 'the creator may favorite it');
    assert.equal((await call('GET', '/api/favorites', 'other')).body.length, 0);
    assert.equal((await call('GET', `/api/ratings/places/${cinema.id}`, null)).status, 404);
    assert.equal((await call('PUT', `/api/ratings/places/${cinema.id}`, 'other', { score: 4 })).status, 404);
    assert.equal((await call('POST', '/comments', 'other', { place_id: cinema.id, content: 'x' })).status, 404);
    assert.equal((await call('POST', '/place-requests', 'other', { place_id: cinema.id, proposed: { name: 'x' } })).status, 404);
    assert.equal((await call('PUT', `/places/${cinema.id}`, 'other', { name: 'x' })).status, 404);
    assert.equal((await call('DELETE', `/places/${cinema.id}`, 'other')).status, 404);

    // 3. 管理员在地点申请页看到它（带地点内容和报告），通过后公开并补发群推送
    const list = await call('GET', '/place-requests', 'admin');
    const listed = list.body.find((r) => r.id === request.id);
    assert.equal(listed.request_type, 'create');
    assert.equal(listed.place.name, '万达电影院');
    assert.equal(listed.place.creator_name, 'owner');
    assert.deepEqual(listed.moderation.decision.reasons, ['unrelated']);
    assert.equal(list.body.find((r) => r.place_id === good.id), undefined, 'passed places create no request');
    assert.equal((await call('POST', `/place-requests/${request.id}/review`, 'other', { action: 'approve' })).status, 403);
    assert.equal((await call('POST', `/place-requests/${request.id}/review`, 'admin', { action: 'approve' })).status, 200);
    assert.equal(statusOf(cinema.id), 'visible');
    assert.equal(notified(cinema.id), 1);
    assert.equal((await call('GET', `/places/${cinema.id}`, 'other')).status, 200);
    assert.equal((await call('POST', `/place-requests/${request.id}/review`, 'admin', { action: 'reject' })).status, 409);
    assert.ok(sql.prepare("SELECT 1 FROM AdminAudit WHERE action = 'place-moderation-review' AND admin_id = ?").get(users.admin));

    // 4. 描述明显简略：本地规则拦下（模型说没问题也一样）；创建者补充描述后重新初筛，通过就公开，申请自动撤回
    const brief = await create('owner', { name: '沙县小吃', description: '好' });
    await idle();
    assert.equal(statusOf(brief.id), 'pending');
    const briefRequest = openRequest(brief.id);
    assert.deepEqual(JSON.parse(briefRequest.moderation).decision.reasons, ['brief']);
    assert.match(briefRequest.note, /描述为空/);
    const edited = await call('PUT', `/places/${brief.id}`, 'owner', { description: '拌面和蒸饺都不错，十块钱吃饱' });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.moderation_status, 'checking');
    await idle();
    assert.equal(statusOf(brief.id), 'visible');
    assert.equal(sql.prepare('SELECT status FROM PlaceRequest WHERE id = ?').get(briefRequest.id).status, 'withdrawn');
    assert.equal(notified(brief.id), 1);
    assert.equal(sql.prepare('SELECT checks FROM PlaceModeration WHERE place_id = ?').get(brief.id).checks, 2);

    // 5. 不良信息：驳回后只留给创建者；创建者再改直接回到人工复核（不再走 AI），通过后公开
    const ad = await create('owner', { name: '广告烧烤' });
    await idle();
    const adRequest = openRequest(ad.id);
    assert.deepEqual(JSON.parse(adRequest.moderation).decision.reasons, ['harmful']);
    assert.equal((await call('POST', `/place-requests/${adRequest.id}/review`, 'admin', { action: 'reject' })).status, 200);
    assert.equal(statusOf(ad.id), 'rejected');
    assert.equal(notified(ad.id), 0);
    assert.equal((await call('GET', `/places/${ad.id}`, 'other')).status, 404);
    assert.equal((await call('GET', `/places/${ad.id}`, 'owner')).body.moderation_status, 'rejected');
    const textCallsBefore = calls.text.length;
    const resubmitted = await call('PUT', `/places/${ad.id}`, 'owner', { description: '炭烤生蚝和羊肉串，人均八十' });
    assert.equal(resubmitted.body.moderation_status, 'pending');
    await idle();
    assert.equal(calls.text.length, textCallsBefore, 'a rejected place is not sent to the model again');
    const second = openRequest(ad.id);
    assert.ok(second && second.id !== adRequest.id, 'a fresh review request');
    assert.match(second.note, /重新提交/);
    assert.equal((await call('POST', `/place-requests/${second.id}/review`, 'admin', { action: 'approve' })).status, 200);
    assert.equal(statusOf(ad.id), 'visible');

    // 6. 图片：门面 + 菜单，菜单里的个人二维码被拦下，报告里带出对应图片地址
    const photos = await create('owner', { name: '图片店', exterior_images: ['/uploads/door.jpg'], menu_images: ['/uploads/menu.jpg'] });
    await idle();
    assert.equal(statusOf(photos.id), 'pending');
    const photoReport = JSON.parse(openRequest(photos.id).moderation);
    assert.deepEqual(photoReport.decision.reasons, ['image']);
    assert.deepEqual(photoReport.vision.flagged_urls, ['/uploads/menu.jpg']);
    assert.match(calls.vision.at(-1).text, /共 2 张照片：第 1 张门面，第 2 张菜单/);
    assert.match(openRequest(photos.id).note, /图片：第 2 张有个人二维码/);

    // 7. 把握不足不拦；模型失败（两次都出错）按通过处理，报告记下错误
    const unsure = await create('owner', { name: '拿不准小馆' });
    textBehavior = () => { throw new Error('upstream timed out'); };
    const failing = await create('owner', { name: '模型故障面馆' });
    await idle();
    textBehavior = null;
    assert.equal(statusOf(unsure.id), 'visible');
    assert.equal(statusOf(failing.id), 'visible');
    const failedReport = JSON.parse(sql.prepare('SELECT report FROM PlaceModeration WHERE place_id = ?').get(failing.id).report);
    assert.deepEqual([failedReport.text.status, failedReport.text.error], ['error', 'upstream timed out']);

    // 8. 初筛期间内容被改：结果作废并按新内容重查
    let mutated = false;
    textBehavior = (input) => {
        if (!mutated) {
            mutated = true;
            sql.prepare("UPDATE Place SET name = '万达电影院二号厅' WHERE name = '竞态面馆'").run();
            return { flagged: false, reasons: [], confidence: 0, summary: '' };
        }
        return input.name.includes('电影院') ? { flagged: true, reasons: ['unrelated'], confidence: 0.9, summary: '电影院' } : { flagged: false, reasons: [], confidence: 0, summary: '' };
    };
    const race = await create('owner', { name: '竞态面馆' });
    await idle();
    textBehavior = null;
    assert.equal(statusOf(race.id), 'pending', 'judged on the latest content');

    // 9. AI 次数用完后，创建者再改只等人工复核
    process.env.PLACE_MODERATION_MAX_CHECKS = '1';
    const capped = await create('owner', { name: '另一家电影院' });
    await idle();
    const cappedEdit = await call('PUT', `/places/${capped.id}`, 'owner', { name: '另一家电影院小吃部' });
    assert.equal(cappedEdit.body.moderation_status, 'pending');
    delete process.env.PLACE_MODERATION_MAX_CHECKS;

    // 10. 删除复核中的地点：申请记为撤回
    const cappedRequest = openRequest(capped.id);
    assert.equal((await call('DELETE', `/places/${capped.id}`, 'owner')).status, 200);
    assert.equal(sql.prepare('SELECT status FROM PlaceRequest WHERE id = ?').get(cappedRequest.id).status, 'withdrawn');

    // 11. 管理员新建：直接公开，不建初筛任务
    const byAdmin = await create('admin', { name: '管理员的电影院', description: '' });
    assert.equal(byAdmin.moderation_status, 'visible');
    await idle();
    assert.equal(sql.prepare('SELECT 1 FROM PlaceModeration WHERE place_id = ?').get(byAdmin.id), undefined);
    assert.equal(notified(byAdmin.id), 1);

    // 12. 公开日记建的标记：描述为空不算简略
    const diaryId = Number(sql.prepare("INSERT INTO Place (name, description, latitude, longitude, category, creator_id) VALUES ('日记里的面馆', '', 23.2, 113.2, '面馆', ?)").run(users.owner).lastInsertRowid);
    assert.equal(moderation.registerNewPlaceSync(diaryId, users.owner, 'diary'), 'checking');
    assert.equal(enqueuePlaceCreatedNotifications([diaryId], { source: 'diary' }), 0, 'hidden places are never announced');
    assert.equal(await moderation.moderatePlace(diaryId), 'visible');
    assert.equal(calls.text.at(-1).source, 'diary');

    // 13. 重启恢复：还是 checking 的地点重新排队
    const stuck = Number(sql.prepare("INSERT INTO Place (name, description, latitude, longitude, creator_id) VALUES ('重启前的店', '鱼粥很鲜', 23.3, 113.3, ?)").run(users.owner).lastInsertRowid);
    moderation.registerNewPlaceSync(stuck, users.owner, 'qq_bot');
    assert.equal(moderation.resumeModeration(), 1);
    await idle();
    assert.equal(statusOf(stuck), 'visible');

    // 14. 关闭初筛：新地点直接公开（旧行为）
    process.env.PLACE_MODERATION_ENABLED = 'false';
    const off = await create('owner', { name: '关闭时的电影院', description: '' });
    assert.equal(off.moderation_status, 'visible');
    process.env.PLACE_MODERATION_ENABLED = 'true';

    // 15. 创建者修改已公开的地点：只查这次改出来的问题；明显不合规的修改转成修改申请，地点对所有人保持原样
    const textCalls = () => calls.text.length;
    const placeRow = (id) => sql.prepare('SELECT * FROM Place WHERE id = ?').get(id);
    let before = textCalls();
    const priceOnly = await call('PUT', `/places/${good.id}`, 'owner', { name: '好吃牛肉面', description: '招牌牛肉面，汤底浓，人均二十', per_person_cost: 25 });
    assert.equal(priceOnly.status, 200, priceOnly.text);
    assert.equal(priceOnly.body.per_person_cost, 25);
    assert.equal(textCalls(), before, 'unchanged text is not sent to the model');
    const fine = await call('PUT', `/places/${good.id}`, 'owner', { description: '招牌牛肉面，汤底浓，加了卤蛋' });
    assert.equal(fine.status, 200);
    assert.equal(textCalls(), before + 1);
    assert.equal(calls.text.at(-1).description, '招牌牛肉面，汤底浓，加了卤蛋', 'the model judges the edited content');

    const held = await call('PUT', `/places/${good.id}`, 'owner', { name: '广告牛肉面', description: '加微信领券' });
    assert.equal(held.status, 202, held.text);
    assert.deepEqual([held.body.pending_review, held.body.reasons], [true, ['harmful']]);
    assert.deepEqual([placeRow(good.id).name, placeRow(good.id).moderation_status], ['好吃牛肉面', 'visible'], 'the place keeps its old content');
    const heldRequest = sql.prepare('SELECT * FROM PlaceRequest WHERE id = ?').get(held.body.request_id);
    assert.deepEqual([heldRequest.request_type, heldRequest.status, heldRequest.requester_id], ['modify', 'pending', users.owner]);
    assert.deepEqual(JSON.parse(heldRequest.proposed).name, '广告牛肉面');
    assert.match(heldRequest.note, /AI 初筛/);
    assert.deepEqual(JSON.parse(heldRequest.moderation).decision.reasons, ['harmful']);
    const listedEdit = (await call('GET', '/place-requests', 'admin')).body.find((r) => r.id === heldRequest.id);
    assert.deepEqual(listedEdit.moderation.decision.reasons, ['harmful']);
    assert.equal((await call('POST', `/place-requests/${heldRequest.id}/review`, 'admin', { action: 'approve' })).status, 200);
    assert.deepEqual([placeRow(good.id).name, placeRow(good.id).description], ['广告牛肉面', '加微信领券'], 'approval applies the held edit');

    // “简略”只在这次改了描述时才算：老地点描述本来是空的，改名不拦；把描述改成一个字要拦
    textBehavior = () => ({ flagged: true, reasons: ['brief'], confidence: 0.9, summary: '描述为空' });
    const legacy = Number(sql.prepare("INSERT INTO Place (name, description, latitude, longitude, creator_id) VALUES ('老店', '', 23.4, 113.4, ?)").run(users.owner).lastInsertRowid);
    assert.equal((await call('PUT', `/places/${legacy}`, 'owner', { name: '老店新名' })).status, 200);
    assert.equal(placeRow(legacy).name, '老店新名');
    const shortened = await call('PUT', `/places/${legacy}`, 'owner', { description: '好' });
    assert.deepEqual([shortened.status, shortened.body.reasons], [202, ['brief']]);
    textBehavior = null;

    // 图片只看新加的：已有的图不再送审
    const visionBefore = calls.vision.length;
    assert.equal((await call('PUT', `/places/${unsure.id}`, 'owner', { exterior_images: ['/uploads/new-door.jpg'] })).status, 200);
    assert.equal(calls.vision.length, visionBefore + 1);
    assert.equal(calls.vision.at(-1).images.length, 1);
    const menuEdit = await call('PUT', `/places/${unsure.id}`, 'owner', { exterior_images: ['/uploads/new-door.jpg'], menu_images: ['/uploads/new-menu.jpg'] });
    assert.deepEqual([menuEdit.status, menuEdit.body.reasons], [202, ['image']]);
    assert.match(calls.vision.at(-1).text, /共 1 张照片：第 1 张菜单/, 'only the added photo is sent');
    assert.equal(placeRow(unsure.id).menu_images, null);
    assert.equal((await call('PUT', `/places/${unsure.id}`, 'owner', { exterior_images: ['/uploads/new-door.jpg'], per_person_cost: 30 })).status, 200);
    assert.equal(calls.vision.length, visionBefore + 2, 'no new photos, no image check');

    // 管理员修改不检查；模型出错时修改照常保存
    before = textCalls();
    assert.equal((await call('PUT', `/places/${good.id}`, 'admin', { name: '管理员改的电影院' })).status, 200);
    assert.equal(textCalls(), before);
    textBehavior = () => { throw new Error('upstream timed out'); };
    const failedEdit = await call('PUT', `/places/${failing.id}`, 'owner', { description: '新写的描述：汤底浓郁' });
    textBehavior = null;
    assert.equal(failedEdit.status, 200);
    assert.equal(textCalls(), before + 1, 'edits are not retried while the user waits');
    process.env.PLACE_MODERATION_ENABLED = 'false';
    assert.equal((await call('PUT', `/places/${failing.id}`, 'owner', { name: '关闭时改成电影院' })).status, 200);
    process.env.PLACE_MODERATION_ENABLED = 'true';

    moderation.setClientsForTesting(null);
    console.log('place moderation tests passed: rules, verdict parsing, prompt/doc sync, pass/flag/recheck/reject/resubmit/delete, images, failures, races, limits, admin and diary paths, visibility, deferred group pushes and owner edits held for review.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    if (server) { server.closeAllConnections(); server.close(); }
    try { db._raw.close(); } catch (_) { }
    fs.rmSync(temp, { recursive: true, force: true });
});
