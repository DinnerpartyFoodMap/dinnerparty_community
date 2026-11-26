// 住民评论（modules/community/routes/comments.js、services/residentComments.js）：
// 写入校验与规整、评分门槛、北京日配额、一人一店一条、初筛状态流转（通过 / 拦下 / 复核中修改 /
// 驳回后重提 / 内容竞态 / 重启恢复）、封禁与屏蔽、公开读取（可见性 / 50 条上限 / 自己那条）、
// 删除与复核（批准 / 驳回 / 过期申请）、删除地点 / 注销账号 / 管理员删除的连带，以及管理员修改依据
// 不含住民评论。临时 SQLite + 本地 express；模型调用用替身，不访问外网。
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-place-comments-'));
Object.assign(process.env, {
    LOG_TO_FILE: 'false',
    LOG_TO_CONSOLE: 'false',
    SILICONFLOW_API_KEY: '',
    DEEPSEEK_API_KEY: '',
    DB_FILE: path.join(temp, 'test.sqlite'),
    PLACE_MODERATION_ENABLED: 'true',
    PLACE_MODERATION_MIN_CONFIDENCE: '0.7'
});
delete process.env.PLACE_MODERATION_MAX_CHECKS;
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };

// 这个测试只关心评论。离线环境没有数值算法服务，读地点前的评分摘要刷新没有意义；
// 只放行这一层中间件，地点 / 评论 / 复核路由仍然跑真实代码。
const summaryAdapter = require('../../modules/ratings/services/ratingSummaryAdapter');
summaryAdapter.ratingsReadMiddleware = (req, res, next) => next();
summaryAdapter.ensureRatingSummaries = async () => 0;

const express = require('express');
const jwt = require('jsonwebtoken');
const { db, init } = require('../../infrastructure/database');
const moderation = require('../../modules/places/services/placeModeration');
const residentComments = require('../../modules/community/services/residentComments');
const { requireAuth } = require('../../modules/accounts/middleware/auth');
const sql = db._raw;

const PASS = Object.freeze({ flagged: false, reasons: [], confidence: 0, summary: '' });
const flagged = (reasons = ['harmful'], confidence = 0.9, summary = '明显违规') => ({
    flagged: true, reasons, confidence, summary
});

const users = {};
const tokens = {};
const model = { calls: [], available: true, behavior: () => PASS, gate: null, onCall: null };
let server = null;

function addUser(name, { admin = null, banned = false } = {}) {
    const id = randomUUID();
    sql.prepare('INSERT INTO User (id, username, password, admin_level, is_banned) VALUES (?, ?, ?, ?, ?)')
        .run(id, name, 'unused', admin, banned ? 1 : 0);
    users[name] = id;
    return id;
}

function tokenFor(name) {
    if (!tokens[name]) tokens[name] = jwt.sign({ id: users[name] }, process.env.JWT_SECRET || 'yuyuko_secret_key');
    return tokens[name];
}

function insertPlace(name, { creator = 'creator', status = 'visible', description = '测试地点描述，招牌菜和人均都写了' } = {}) {
    return Number(sql.prepare(`INSERT INTO Place (name, description, category, latitude, longitude, creator_id, moderation_status)
        VALUES (?, ?, '面馆', 23.1, 113.3, ?, ?)`).run(name, description, users[creator], status).lastInsertRowid);
}

function rate(placeId, name, score = 4) {
    const now = Date.now();
    sql.prepare(`INSERT INTO PlaceRating (place_id, user_id, score, source, created_at, updated_at)
        VALUES (?, ?, ?, 'user', ?, ?)
        ON CONFLICT(place_id, user_id) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`)
        .run(placeId, users[name], score, now, now);
}

function insertComment({ placeId, user, content, status = 'visible', source = 'resident', time, updatedAt = time, placeRevisionId = null }) {
    return Number(sql.prepare(`INSERT INTO Comment
        (place_id, user_id, content, rating, time, updated_at, source, moderation_status, place_revision_id)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)`).run(
        placeId, user == null ? null : (users[user] || user), content, time, updatedAt, source, status, placeRevisionId
    ).lastInsertRowid);
}

function deferred() {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
}

const waitIdle = () => residentComments.waitForCommentModerationIdle();

let base = '';
async function call(method, url, who, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (who) headers.Authorization = `Bearer ${tokenFor(who)}`;
    const response = await fetch(base + url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch (_) { /* 非 JSON 错误页 */ }
    return { status: response.status, body: parsed, text };
}

const postComment = (who, placeId, content, extra = {}) => call('POST', '/comments', who, { place_id: placeId, content, ...extra });
const getPlace = (placeId, who) => call('GET', `/places/${placeId}`, who);

async function getComments(placeId, who) {
    const response = await getPlace(placeId, who);
    assert.equal(response.status, 200, `GET /places/${placeId}: ${response.text}`);
    assert.ok(Array.isArray(response.body.comments), `GET /places/${placeId} has comments[]`);
    return response.body.comments;
}

function assertError(response, status, code, label = '') {
    assert.equal(response.status, status, `${label} status (body: ${response.text})`);
    assert.ok(response.body && typeof response.body === 'object', `${label} JSON body`);
    assert.equal(response.body.code, code, `${label} code (body: ${response.text})`);
    assert.equal(typeof response.body.error, 'string', `${label} error text`);
    assert.ok(response.body.error.length > 0, `${label} error text is not empty`);
}

function commentRow(id) {
    return sql.prepare('SELECT * FROM Comment WHERE id = ?').get(id);
}

function moderationRow(commentId) {
    return sql.prepare('SELECT * FROM CommentModeration WHERE comment_id = ?').get(commentId);
}

function openCommentRequest(commentId) {
    return sql.prepare(`SELECT * FROM PlaceRequest
        WHERE request_type = 'comment' AND status = 'pending'
            AND json_extract(proposed, '$.comment_id') = ?`).get(commentId);
}

function requestRow(id) {
    return sql.prepare('SELECT * FROM PlaceRequest WHERE id = ?').get(id);
}

function quotaRow(name) {
    return sql.prepare('SELECT * FROM ResidentCommentQuota WHERE user_id = ?').get(users[name]);
}

const results = [];
async function test(name, fn) {
    try {
        await fn();
        results.push({ name, ok: true });
    } catch (error) {
        results.push({ name, ok: false, error });
    } finally {
        // 失败的用例可能停在模型闸门前：先放行再清空队列，避免后续用例一直等
        if (model.gate) {
            try { model.gate.resolve(); } catch (_) { /* already released */ }
            model.gate = null;
        }
        try { await waitIdle(); } catch (_) { /* cleanup best effort */ }
        model.available = true;
        model.behavior = () => PASS;
        model.gate = null;
        model.onCall = null;
        delete process.env.PLACE_MODERATION_MAX_CHECKS;
        process.env.PLACE_MODERATION_ENABLED = 'true';
        process.env.PLACE_MODERATION_MIN_CONFIDENCE = '0.7';
    }
}

async function main() {
    init();
    addUser('creator');
    addUser('admin', { admin: 'YOUMU' });
    addUser('alice');
    addUser('bob');
    addUser('carol');

    moderation.setClientsForTesting({
        retryDelayMs: 0,
        textAvailable: () => model.available,
        visionAvailable: () => false,
        text: async ({ system, user }) => {
            const input = JSON.parse(user);
            model.calls.push({ system, input });
            if (model.onCall) {
                const notify = model.onCall;
                model.onCall = null;
                notify(input);
            }
            if (model.gate) await model.gate.promise;
            return model.behavior(input);
        }
    });

    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    app.use('/place-requests', require('../../modules/places/routes/placeRequests'));
    app.use('/comments', require('../../modules/community/routes/comments'));
    app.use('/admin/comments', requireAuth, require('../../modules/admin/routes/adminComments'));
    server = await new Promise((resolve) => {
        const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    base = `http://127.0.0.1:${server.address().port}`;

    await test('POST /comments requires auth and reports place/rating errors with codes', async () => {
        addUser('noRatingUser');
        const place = insertPlace('鉴权面馆');
        rate(place, 'alice');
        assertError(await postComment(null, place, '好吃'), 401, 'AUTH_REQUIRED', 'guest');
        assertError(await postComment('alice', 999999, '好吃'), 404, 'COMMENT_PLACE_NOT_FOUND', 'missing place');
        assertError(await postComment('noRatingUser', place, '好吃'), 400, 'COMMENT_RATING_REQUIRED', 'no rating');
        assertError(await postComment('alice', 0, '好吃'), 404, 'COMMENT_PLACE_NOT_FOUND', 'place 0');
        assertError(await postComment('alice', 'abc', '好吃'), 404, 'COMMENT_PLACE_NOT_FOUND', 'place abc');
    });

    await test('content is normalized and validated by code points (2/200/201 and emoji)', async () => {
        addUser('contentUser');
        addUser('adminContent', { admin: 'YOUMU' });
        const place = insertPlace('内容校验面馆');
        rate(place, 'contentUser');
        rate(place, 'adminContent');

        for (const content of [undefined, null, 42, true, [], {}]) {
            assertError(await postComment('contentUser', place, content), 400, 'COMMENT_INVALID', `content ${JSON.stringify(content)}`);
        }
        for (const content of [' \n\t ', 'a', 'a ']) {
            assertError(await postComment('contentUser', place, content), 400, 'COMMENT_TOO_SHORT', `short ${JSON.stringify(content)}`);
        }

        const normalized = await postComment('contentUser', place, '  a \n\t b   ');
        assert.equal(normalized.status, 200, normalized.text);
        assert.equal(normalized.body.comment.content, 'a b');
        await waitIdle();

        const long = await postComment('contentUser', place, '好'.repeat(201));
        assertError(long, 400, 'COMMENT_TOO_LONG', '201 Chinese chars');
        await waitIdle();
        const exact = await postComment('contentUser', place, '好'.repeat(200));
        assert.equal(exact.status, 200, exact.text);
        assert.equal(Array.from(exact.body.comment.content).length, 200);
        await waitIdle();

        assertError(await postComment('contentUser', place, '😀'.repeat(201)), 400, 'COMMENT_TOO_LONG', '201 emoji');
        const emoji = await postComment('contentUser', place, '😀'.repeat(200));
        assert.equal(emoji.status, 200, emoji.text);
        assert.equal(Array.from(emoji.body.comment.content).length, 200);
        await waitIdle();

        const plain = await postComment('adminContent', place, '  好\n\n好  ');
        assert.equal(plain.status, 200, plain.text);
        assert.equal(plain.body.comment.status, 'visible');
        assert.equal(commentRow(plain.body.comment.id).content, '好 好', 'newlines and runs of whitespace fold into one space');
    });

    await test('place must exist and be visible, and its creator must not be blocked by the author', async () => {
        addUser('visibilityUser');
        addUser('blockedCreator');
        addUser('blocker');
        addUser('otherViewer');
        const visible = insertPlace('可见面馆');
        rate(visible, 'visibilityUser');
        for (const status of ['checking', 'pending', 'rejected']) {
            const hidden = insertPlace(`不可见面馆-${status}`, { status });
            rate(hidden, 'visibilityUser');
            assertError(await postComment('visibilityUser', hidden, '好吃'), 404, 'COMMENT_PLACE_NOT_FOUND', status);
        }
        const blockedPlace = insertPlace('被屏蔽创建者的店', { creator: 'blockedCreator' });
        rate(blockedPlace, 'visibilityUser');
        rate(blockedPlace, 'otherViewer');
        sql.prepare('INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)').run(users.blocker, users.blockedCreator);
        assertError(await postComment('blocker', blockedPlace, '好吃'), 404, 'COMMENT_PLACE_NOT_FOUND', 'blocked creator');
        const allowed = await postComment('otherViewer', blockedPlace, '好吃');
        assert.equal(allowed.status, 200, allowed.text);
        await waitIdle();
    });

    await test('rating is required and a rating field in the body is ignored', async () => {
        addUser('ratingUser', { admin: 'YOUMU' });
        const place = insertPlace('评分忽略面馆');
        rate(place, 'ratingUser', 2);
        const response = await postComment('ratingUser', place, '评分请求字段应被忽略', { rating: 4 });
        assert.equal(response.status, 200, response.text);
        assert.equal(response.body.comment.status, 'visible');
        assert.deepEqual(Object.keys(response.body.comment).sort(), ['content', 'id', 'place_id', 'status', 'time', 'updated_at']);
        assert.equal(sql.prepare('SELECT score FROM PlaceRating WHERE place_id = ? AND user_id = ?').get(place, users.ratingUser).score, 2);
        assert.equal(commentRow(response.body.comment.id).rating, 2, 'the stored rating is the existing PlaceRating');
    });

    await test('banned residents cannot write comments even though they can still GET', async () => {
        addUser('bannedWriter', { banned: true });
        const place = insertPlace('封禁评论面馆');
        rate(place, 'bannedWriter');
        assertError(await postComment('bannedWriter', place, '不能写'), 403, 'AUTH_USER_BANNED', 'banned POST');
        const own = insertComment({ placeId: place, user: 'bannedWriter', content: '旧的', time: '2026-01-01T00:00:00.000Z' });
        assertError(await call('DELETE', `/comments/${own}`, 'bannedWriter'), 403, 'AUTH_USER_BANNED', 'banned DELETE');
        assert.equal((await getPlace(place, 'bannedWriter')).status, 200, 'banned residents may still read');
    });

    await test('a new comment starts checking, then passes to visible without touching the place description', async () => {
        addUser('newCommentUser');
        const place = insertPlace('新评论面馆', { description: '原来的描述' });
        rate(place, 'newCommentUser');
        const before = model.calls.length;
        const response = await postComment('newCommentUser', place, '  第一次评论：\n牛肉面很香  ');
        assert.equal(response.status, 200, response.text);
        const comment = response.body.comment;
        assert.deepEqual(Object.keys(comment).sort(), ['content', 'id', 'place_id', 'status', 'time', 'updated_at']);
        assert.equal(comment.status, 'checking', 'non-admin authors start in checking');
        assert.equal(comment.content, '第一次评论： 牛肉面很香');
        assert.equal(comment.time, comment.updated_at);
        const row = commentRow(comment.id);
        assert.equal(row.source, 'resident');
        assert.ok(['checking', 'visible'].includes(row.moderation_status), 'the row may already have been screened by the queued task');
        assert.equal(sql.prepare('SELECT description FROM Place WHERE id = ?').get(place).description, '原来的描述');

        await waitIdle();
        assert.equal(model.calls.length, before + 1);
        assert.equal(model.calls.at(-1).input.place.name, '新评论面馆');
        assert.equal(model.calls.at(-1).input.comment, '第一次评论： 牛肉面很香');
        assert.equal(commentRow(comment.id).moderation_status, 'visible');
        const own = await getComments(place, 'newCommentUser');
        assert.equal(own.length, 1);
        assert.deepEqual([own[0].id, own[0].status, own[0].mine, own[0].username],
            [comment.id, 'visible', true, 'newCommentUser']);
        const guest = await getComments(place, null);
        assert.equal(guest.length, 1);
        assert.equal(guest[0].mine, false);
        assert.equal(openCommentRequest(comment.id), undefined);
    });

    await test('an unchanged submission returns the current row and never re-screens or uses quota', async () => {
        addUser('duplicateUser');
        const place = insertPlace('重复提交面馆');
        rate(place, 'duplicateUser');

        const gate = deferred();
        const started = deferred();
        model.gate = gate;
        model.onCall = () => started.resolve();
        const first = await postComment('duplicateUser', place, '内容不变');
        assert.equal(first.status, 200, first.text);
        await started.promise;
        const callsBeforeDuplicate = model.calls.length;
        const duplicate = await postComment('duplicateUser', place, '内容不变');
        assert.equal(duplicate.status, 200, duplicate.text);
        assert.equal(duplicate.body.comment.id, first.body.comment.id);
        assert.equal(duplicate.body.comment.status, 'checking');
        assert.equal(duplicate.body.comment.updated_at, first.body.comment.updated_at);
        assert.equal(model.calls.length, callsBeforeDuplicate, 'unchanged content is not screened again');
        assert.equal(quotaRow('duplicateUser').writes, 1, 'unchanged content is not counted');
        model.gate = null;
        gate.resolve();
        await waitIdle();
        assert.equal(commentRow(first.body.comment.id).moderation_status, 'visible');

        const visibleBefore = model.calls.length;
        const again = await postComment('duplicateUser', place, '内容不变');
        assert.equal(again.status, 200);
        assert.equal(again.body.comment.updated_at, first.body.comment.updated_at);
        assert.equal(quotaRow('duplicateUser').writes, 1);
        assert.equal(model.calls.length, visibleBefore);
    });

    await test('editing updates the same comment, keeps id and first time, and moves updated_at', async () => {
        addUser('editCommentUser');
        const place = insertPlace('修改评论面馆');
        rate(place, 'editCommentUser');
        const first = await postComment('editCommentUser', place, '第一版评论');
        assert.equal(first.status, 200, first.text);
        await waitIdle();
        const firstRow = commentRow(first.body.comment.id);

        const second = await postComment('editCommentUser', place, '第二版评论');
        assert.equal(second.status, 200, second.text);
        assert.equal(second.body.comment.id, first.body.comment.id);
        assert.equal(second.body.comment.time, first.body.comment.time);
        assert.ok(second.body.comment.updated_at > first.body.comment.updated_at, 'updated_at advances');
        assert.equal(second.body.comment.status, 'checking');
        await waitIdle();
        const rows = sql.prepare("SELECT * FROM Comment WHERE place_id = ? AND user_id = ? AND source = 'resident'")
            .all(place, users.editCommentUser);
        assert.equal(rows.length, 1, 'one comment per resident and place');
        assert.equal(rows[0].id, first.body.comment.id);
        assert.equal(rows[0].content, '第二版评论');
        assert.equal(rows[0].time, firstRow.time);
        assert.equal(quotaRow('editCommentUser').writes, 2);
    });

    await test('manage_places authors and disabled moderation publish immediately without the model', async () => {
        addUser('adminAuthor', { admin: 'YOUMU' });
        addUser('offAuthor');
        const adminPlace = insertPlace('管理员评论面馆');
        const offPlace = insertPlace('关闭初筛评论面馆');
        rate(adminPlace, 'adminAuthor');
        rate(offPlace, 'offAuthor');
        const before = model.calls.length;
        const asAdmin = await postComment('adminAuthor', adminPlace, '管理员直接通过');
        assert.equal(asAdmin.status, 200, asAdmin.text);
        assert.equal(asAdmin.body.comment.status, 'visible');
        assert.equal(model.calls.length, before);

        process.env.PLACE_MODERATION_ENABLED = 'false';
        try {
            const off = await postComment('offAuthor', offPlace, '关闭初筛时直接通过');
            assert.equal(off.status, 200, off.text);
            assert.equal(off.body.comment.status, 'visible');
            assert.equal(model.calls.length, before);
        } finally {
            process.env.PLACE_MODERATION_ENABLED = 'true';
        }
    });

    await test('quota allows 20 writes per Beijing day, ignores unchanged repeats, and resets next day', async () => {
        addUser('quotaUser');
        const place = insertPlace('配额面馆');
        rate(place, 'quotaUser');
        process.env.PLACE_MODERATION_ENABLED = 'false';
        try {
            let last = await postComment('quotaUser', place, '00');
            assert.equal(last.status, 200, last.text);
            for (let i = 1; i <= 19; i += 1) {
                last = await postComment('quotaUser', place, String(i).padStart(2, '0'));
                assert.equal(last.status, 200, `write ${i + 1}: ${last.text}`);
            }
            assert.equal(quotaRow('quotaUser').writes, 20);
            assertError(await postComment('quotaUser', place, '20'), 429, 'COMMENT_QUOTA', '21st write');
            assert.equal(quotaRow('quotaUser').writes, 20);

            const duplicate = await postComment('quotaUser', place, '19');
            assert.equal(duplicate.status, 200, duplicate.text);
            assert.equal(duplicate.body.comment.updated_at, last.body.comment.updated_at);
            assert.equal(quotaRow('quotaUser').writes, 20, 'unchanged repeat is free even when quota is exhausted');

            const dayBefore = quotaRow('quotaUser').local_day;
            const nextDay = residentComments.submitComment(users.quotaUser,
                { place_id: place, content: '21' }, Date.now() + 24 * 60 * 60 * 1000);
            assert.equal(nextDay.status, 'visible');
            assert.notEqual(quotaRow('quotaUser').local_day, dayBefore);
            assert.equal(quotaRow('quotaUser').writes, 1, 'a new Beijing day resets the counter');
        } finally {
            process.env.PLACE_MODERATION_ENABLED = 'true';
        }
    });

    await test('a flagged comment becomes pending with one review request carrying the report', async () => {
        addUser('flaggedUser');
        const place = insertPlace('拦下评论面馆');
        rate(place, 'flaggedUser');
        model.behavior = () => flagged(['harmful', 'brief'], 0.9, '评论在加微信引流');
        const response = await postComment('flaggedUser', place, '加微信领券，进群每天发优惠码');
        assert.equal(response.status, 200, response.text);
        const comment = response.body.comment;
        assert.equal(comment.status, 'checking');
        await waitIdle();
        assert.equal(commentRow(comment.id).moderation_status, 'pending');
        const request = openCommentRequest(comment.id);
        assert.ok(request, 'a pending comment review request is created');
        assert.equal(request.request_type, 'comment');
        assert.equal(request.requester_id, users.flaggedUser);
        assert.deepEqual(JSON.parse(request.proposed), { comment_id: comment.id, content: comment.content });
        assert.deepEqual(JSON.parse(request.moderation).decision, { flagged: true, reasons: ['harmful'] });
        assert.equal(moderationRow(comment.id).checks, 1);
        assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM PlaceRequest
            WHERE request_type = 'comment' AND status = 'pending'
                AND json_extract(proposed, '$.comment_id') = ?`).get(comment.id).n, 1,
        'only one pending comment request exists for this comment');
    });

    await test('confidence threshold, unflag, brief-only and image-only answers are handled correctly', async () => {
        addUser('belowThreshold');
        addUser('exactThreshold');
        addUser('briefOnly');
        addUser('imageOnly');
        addUser('unflagged');
        const low = insertPlace('低把握面馆');
        const exact = insertPlace('阈值面馆');
        const brief = insertPlace('简略面馆');
        const image = insertPlace('图片理由面馆');
        const noFlag = insertPlace('未标记面馆');
        for (const [name, place] of [['belowThreshold', low], ['exactThreshold', exact], ['briefOnly', brief], ['imageOnly', image], ['unflagged', noFlag]]) {
            rate(place, name);
        }

        model.behavior = () => flagged(['harmful'], 0.69);
        assert.equal((await postComment('belowThreshold', low, '低于阈值的评论', {})).status, 200);
        await waitIdle();
        assert.equal(commentRow(sql.prepare("SELECT id FROM Comment WHERE user_id = ? AND place_id = ?").get(users.belowThreshold, low).id).moderation_status, 'visible');

        model.behavior = () => flagged(['harmful'], 0.7);
        assert.equal((await postComment('exactThreshold', exact, '正好达到阈值的评论')).status, 200);
        await waitIdle();
        assert.equal(commentRow(sql.prepare("SELECT id FROM Comment WHERE user_id = ? AND place_id = ?").get(users.exactThreshold, exact).id).moderation_status, 'pending');

        model.behavior = () => flagged(['brief'], 0.99);
        assert.equal((await postComment('briefOnly', brief, '只有 brief 理由')).status, 200);
        await waitIdle();
        assert.equal(commentRow(sql.prepare("SELECT id FROM Comment WHERE user_id = ? AND place_id = ?").get(users.briefOnly, brief).id).moderation_status, 'visible');

        model.behavior = () => flagged(['image'], 0.99);
        assert.equal((await postComment('imageOnly', image, '只有 image 理由')).status, 200);
        await waitIdle();
        assert.equal(commentRow(sql.prepare("SELECT id FROM Comment WHERE user_id = ? AND place_id = ?").get(users.imageOnly, image).id).moderation_status, 'visible');

        model.behavior = () => ({ flagged: false, reasons: ['harmful'], confidence: 0.99, summary: '其实没拦' });
        assert.equal((await postComment('unflagged', noFlag, 'flagged 为 false')).status, 200);
        await waitIdle();
        assert.equal(commentRow(sql.prepare("SELECT id FROM Comment WHERE user_id = ? AND place_id = ?").get(users.unflagged, noFlag).id).moderation_status, 'visible');
    });

    await test('model not configured, throwing, or returning junk all pass the comment', async () => {
        addUser('noModelUser');
        addUser('errorModelUser');
        addUser('junkModelUser');
        const noModelPlace = insertPlace('未配置模型面馆');
        const errorPlace = insertPlace('模型出错面馆');
        const junkPlace = insertPlace('模型乱答面馆');
        for (const [name, place] of [['noModelUser', noModelPlace], ['errorModelUser', errorPlace], ['junkModelUser', junkPlace]]) {
            rate(place, name);
        }

        model.available = false;
        assert.equal((await postComment('noModelUser', noModelPlace, '没配置模型也放行')).status, 200);
        await waitIdle();
        const noModelId = sql.prepare('SELECT id FROM Comment WHERE user_id = ? AND place_id = ?').get(users.noModelUser, noModelPlace).id;
        assert.equal(commentRow(noModelId).moderation_status, 'visible');
        const noModelReport = JSON.parse(moderationRow(noModelId).report);
        assert.deepEqual([noModelReport.text.status, noModelReport.text.reason, moderationRow(noModelId).checks],
            ['skipped', 'not_configured', 0]);

        model.available = true;
        model.behavior = () => { throw new Error('upstream timed out'); };
        assert.equal((await postComment('errorModelUser', errorPlace, '模型超时也放行')).status, 200);
        await waitIdle();
        const errorId = sql.prepare('SELECT id FROM Comment WHERE user_id = ? AND place_id = ?').get(users.errorModelUser, errorPlace).id;
        assert.equal(commentRow(errorId).moderation_status, 'visible');
        assert.deepEqual([JSON.parse(moderationRow(errorId).report).text.status, moderationRow(errorId).checks], ['error', 1]);

        model.behavior = () => 'this is not the expected JSON';
        assert.equal((await postComment('junkModelUser', junkPlace, '模型乱答也放行')).status, 200);
        await waitIdle();
        const junkId = sql.prepare('SELECT id FROM Comment WHERE user_id = ? AND place_id = ?').get(users.junkModelUser, junkPlace).id;
        assert.equal(commentRow(junkId).moderation_status, 'visible');
        assert.deepEqual([JSON.parse(moderationRow(junkId).report).text.status, moderationRow(junkId).checks], ['error', 1]);
    });

    await test('a pending edit with AI budget left re-checks and withdraws the old review', async () => {
        process.env.PLACE_MODERATION_MAX_CHECKS = '4';
        addUser('pendingEditUser');
        const place = insertPlace('复核中修改面馆');
        rate(place, 'pendingEditUser');
        model.behavior = () => flagged(['harmful'], 0.9);
        const first = await postComment('pendingEditUser', place, '第一次被拦下的内容');
        assert.equal(first.status, 200, first.text);
        await waitIdle();
        const request = openCommentRequest(first.body.comment.id);
        assert.ok(request, 'first review request');
        assert.equal(moderationRow(first.body.comment.id).checks, 1);

        const gate = deferred();
        const started = deferred();
        model.behavior = () => PASS;
        model.gate = gate;
        model.onCall = () => started.resolve();
        const edited = await postComment('pendingEditUser', place, '修改后的正常内容');
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.body.comment.status, 'checking');
        assert.equal(requestRow(request.id).status, 'withdrawn', 'the old review is withdrawn immediately');
        await started.promise;
        model.gate = null;
        gate.resolve();
        await waitIdle();
        assert.equal(commentRow(first.body.comment.id).moderation_status, 'visible');
        assert.equal(openCommentRequest(first.body.comment.id), undefined);
        assert.equal(moderationRow(first.body.comment.id).checks, 2);
    });

    await test('a pending edit with exhausted AI budget stays pending and updates the same request', async () => {
        process.env.PLACE_MODERATION_MAX_CHECKS = '1';
        addUser('cappedEditUser');
        const place = insertPlace('次数用完面馆');
        rate(place, 'cappedEditUser');
        model.behavior = () => flagged(['harmful'], 0.9);
        const first = await postComment('cappedEditUser', place, '第一次被拦下的内容');
        assert.equal(first.status, 200, first.text);
        await waitIdle();
        const request = openCommentRequest(first.body.comment.id);
        assert.ok(request);
        assert.equal(moderationRow(first.body.comment.id).checks, 1);

        const callsBefore = model.calls.length;
        const edited = await postComment('cappedEditUser', place, '次数用完后的修改');
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.body.comment.status, 'pending');
        assert.equal(model.calls.length, callsBefore, 'no AI call after the budget is exhausted');
        assert.equal(requestRow(request.id).status, 'pending');
        assert.deepEqual(JSON.parse(requestRow(request.id).proposed),
            { comment_id: first.body.comment.id, content: '次数用完后的修改' });
        assert.equal(sql.prepare(`SELECT COUNT(*) AS n FROM PlaceRequest
            WHERE request_type = 'comment' AND status = 'pending'
                AND json_extract(proposed, '$.comment_id') = ?`).get(first.body.comment.id).n, 1);
    });

    await test('editing a rejected comment goes straight to pending with a new request and no AI', async () => {
        addUser('rejectedEditUser');
        const place = insertPlace('驳回后修改面馆');
        rate(place, 'rejectedEditUser');
        model.behavior = () => flagged(['harmful'], 0.9);
        const first = await postComment('rejectedEditUser', place, '先被拦下的内容');
        assert.equal(first.status, 200, first.text);
        await waitIdle();
        const firstRequest = openCommentRequest(first.body.comment.id);
        assert.ok(firstRequest);
        assert.equal((await call('POST', `/place-requests/${firstRequest.id}/review`, 'admin', { action: 'reject' })).status, 200);
        assert.equal(commentRow(first.body.comment.id).moderation_status, 'rejected');
        assert.equal(requestRow(firstRequest.id).status, 'rejected');

        const callsBefore = model.calls.length;
        const edited = await postComment('rejectedEditUser', place, '修改后的内容');
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.body.comment.status, 'pending');
        assert.equal(model.calls.length, callsBefore, 'rejected comments are not sent to the model again');
        const secondRequest = openCommentRequest(first.body.comment.id);
        assert.ok(secondRequest);
        assert.notEqual(secondRequest.id, firstRequest.id);
        assert.equal(requestRow(firstRequest.id).status, 'rejected');
        assert.deepEqual(JSON.parse(secondRequest.proposed), { comment_id: first.body.comment.id, content: '修改后的内容' });
    });

    await test('a model result for old content is discarded and the new content is re-queued', async () => {
        addUser('raceCommentUser');
        const place = insertPlace('评论竞态面馆');
        rate(place, 'raceCommentUser');
        model.behavior = (input) => input.comment.includes('内容B')
            ? flagged(['harmful'], 0.9, '内容B违规')
            : PASS;
        const callsBefore = model.calls.length;
        const gate = deferred();
        const started = deferred();
        model.gate = gate;
        model.onCall = () => started.resolve();
        const first = await postComment('raceCommentUser', place, '内容A');
        assert.equal(first.status, 200, first.text);
        await started.promise;
        const second = await postComment('raceCommentUser', place, '内容B');
        assert.equal(second.status, 200, second.text);
        assert.equal(second.body.comment.status, 'checking');
        model.gate = null;
        gate.resolve();
        await waitIdle();

        assert.equal(model.calls.length, callsBefore + 2, 'the edited content is re-queued after the stale answer');
        assert.equal(commentRow(first.body.comment.id).moderation_status, 'pending');
        assert.equal(commentRow(first.body.comment.id).content, '内容B');
        const request = openCommentRequest(first.body.comment.id);
        assert.ok(request);
        assert.equal(JSON.parse(request.proposed).content, '内容B');
        assert.equal(JSON.parse(moderationRow(first.body.comment.id).report).decision.flagged, true);
        assert.equal(moderationRow(first.body.comment.id).checks, 2, 'both AI answers are accounted for');
    });

    await test('checking comments left by a restart are queued again', async () => {
        addUser('resumeCommentUser');
        const place = insertPlace('重启恢复面馆');
        rate(place, 'resumeCommentUser');
        const id = insertComment({
            placeId: place, user: 'resumeCommentUser', content: '重启前没查完的评论',
            status: 'checking', time: '2026-02-01T00:00:00.000Z'
        });
        const callsBefore = model.calls.length;
        assert.ok(residentComments.resumeCommentModeration() >= 1);
        await waitIdle();
        assert.equal(commentRow(id).moderation_status, 'visible');
        assert.equal(model.calls.length, callsBefore + 1);
        assert.equal(model.calls.at(-1).input.comment, '重启前没查完的评论');
    });

    await test('GET comments shows only visible residents, hides blocked/banned authors, and keeps mine any status', async () => {
        addUser('listBob');
        addUser('listCarol');
        addUser('listDave');
        addUser('listErin');
        addUser('listBanned', { banned: true });
        addUser('listBlocked');
        const place = insertPlace('评论可见性面馆');
        const times = {
            bob: '2026-03-01T00:00:01.000Z',
            carol: '2026-03-01T00:00:02.000Z',
            dave: '2026-03-01T00:00:03.000Z',
            erin: '2026-03-01T00:00:04.000Z',
            system: '2026-03-01T00:00:05.000Z',
            banned: '2026-03-01T00:00:06.000Z',
            blocked: '2026-03-01T00:00:07.000Z',
            alice: '2026-03-01T00:00:08.000Z'
        };
        const ids = {
            bob: insertComment({ placeId: place, user: 'listBob', content: 'Bob 的公开评论', time: times.bob }),
            carol: insertComment({ placeId: place, user: 'listCarol', content: 'Carol 审核中', status: 'checking', time: times.carol }),
            dave: insertComment({ placeId: place, user: 'listDave', content: 'Dave 的公开评论', time: times.dave }),
            erin: insertComment({ placeId: place, user: 'listErin', content: 'Erin 被驳回', status: 'rejected', time: times.erin }),
            system: insertComment({ placeId: place, user: 'creator', content: '修改依据', source: null, time: times.system }),
            banned: insertComment({ placeId: place, user: 'listBanned', content: '封禁者的评论', time: times.banned }),
            blocked: insertComment({ placeId: place, user: 'listBlocked', content: '被屏蔽者的评论', time: times.blocked }),
            alice: insertComment({ placeId: place, user: 'alice', content: 'Alice 审核中', status: 'pending', time: times.alice })
        };
        sql.prepare('INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)').run(users.alice, users.listBlocked);

        const fields = ['content', 'id', 'mine', 'status', 'time', 'updated_at', 'user_id', 'username'].sort();
        const aliceView = await getComments(place, 'alice');
        assert.deepEqual(aliceView.map((item) => item.id), [ids.bob, ids.dave, ids.alice],
            'only visible others plus my pending comment');
        assert.deepEqual(aliceView.map((item) => item.mine), [false, false, true]);
        assert.equal(aliceView.at(-1).status, 'pending');
        assert.deepEqual(Object.keys(aliceView[0]).sort(), fields);
        assert.equal(aliceView[0].username, 'listBob');

        const bobView = await getComments(place, 'listBob');
        assert.deepEqual(bobView.map((item) => item.id), [ids.bob, ids.dave, ids.blocked],
            'no banned author, no system row, no checking/rejected rows');
        assert.deepEqual(bobView.map((item) => item.mine), [true, false, false]);

        const guestView = await getComments(place, null);
        assert.deepEqual(guestView.map((item) => item.id), [ids.bob, ids.dave, ids.blocked]);
        assert.ok(guestView.every((item) => item.mine === false), 'guests never own a comment');

        const carolView = await getComments(place, 'listCarol');
        assert.deepEqual(carolView.map((item) => item.id), [ids.bob, ids.carol, ids.dave, ids.blocked]);
        assert.deepEqual([carolView[1].status, carolView[1].mine], ['checking', true]);

        const bannedView = await getComments(place, 'listBanned');
        assert.ok(bannedView.some((item) => item.id === ids.banned && item.mine === true),
            'the viewer\'s own comment always appears, even while banned');
        assert.ok(!bannedView.some((item) => item.id === ids.system));
    });

    await test('GET comments keeps the newest 50 visible comments and adds the viewer\'s own without using a slot', async () => {
        const place = insertPlace('五十条评论面馆');
        const bulk = {};
        const bulkIds = [];
        for (let i = 0; i < 55; i += 1) {
            const name = `bulkViewer${i}`;
            addUser(name);
            bulk[i] = name;
            bulkIds.push(insertComment({
                placeId: place,
                user: name,
                content: `第 ${i} 条评论`,
                time: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`
            }));
        }
        sql.prepare('UPDATE User SET is_banned = 1 WHERE id = ?').run(users[bulk[54]]);
        sql.prepare('INSERT INTO UserBlock (user_id, blocked_id) VALUES (?, ?)').run(users.alice, users[bulk[53]]);

        const aliceView = await getComments(place, 'alice');
        assert.equal(aliceView.length, 50, 'at most 50 visible comments');
        assert.deepEqual(aliceView.map((item) => item.id), bulkIds.slice(3, 53),
            'newest 50 after removing the banned and blocked authors, ordered by time');

        const guestView = await getComments(place, null);
        assert.deepEqual(guestView.map((item) => item.id), bulkIds.slice(4, 54),
            'a guest has no own comment, so the newest 50 run one row later');

        const ownView = await getComments(place, bulk[0]);
        assert.equal(ownView.length, 51, 'the viewer\'s own comment does not consume a slot');
        assert.deepEqual(ownView.map((item) => item.id), [bulkIds[0], ...bulkIds.slice(4, 54)]);
        assert.equal(ownView[0].mine, true);
        assert.ok(!ownView.slice(1).some((item) => item.mine));
    });

    await test('DELETE only removes the author\'s resident comment and withdraws its pending review', async () => {
        addUser('deleteUser');
        addUser('deleteOther');
        addUser('deletePendingUser');
        addUser('deleteBannedUser', { banned: true });
        const place = insertPlace('删除评论面馆');
        const otherPlace = insertPlace('别人的评论面馆');
        rate(place, 'deletePendingUser');
        rate(otherPlace, 'deletePendingUser');

        const otherComment = insertComment({ placeId: place, user: 'deleteOther', content: '别人的评论', time: '2026-04-01T00:00:00.000Z' });
        assertError(await call('DELETE', `/comments/${otherComment}`, 'deleteUser'), 404, 'COMMENT_NOT_FOUND', 'other author');
        assertError(await call('DELETE', '/comments/999999', 'deleteUser'), 404, 'COMMENT_NOT_FOUND', 'missing');
        assertError(await call('DELETE', `/comments/${otherComment}`, null), 401, 'AUTH_REQUIRED', 'guest');

        const system = insertComment({ placeId: place, user: 'creator', content: '系统记录', source: null, time: '2026-04-01T00:00:01.000Z' });
        assertError(await call('DELETE', `/comments/${system}`, 'deleteUser'), 404, 'COMMENT_NOT_FOUND', 'system row');
        assert.ok(commentRow(system), 'a system row is never deleted through the resident endpoint');

        const banned = insertComment({ placeId: place, user: 'deleteBannedUser', content: '封禁者的旧评论', time: '2026-04-01T00:00:02.000Z' });
        assertError(await call('DELETE', `/comments/${banned}`, 'deleteBannedUser'), 403, 'AUTH_USER_BANNED', 'banned author');

        const visible = insertComment({ placeId: place, user: 'deleteUser', content: '我的公开评论', time: '2026-04-01T00:00:03.000Z' });
        const deleted = await call('DELETE', `/comments/${visible}`, 'deleteUser');
        assert.equal(deleted.status, 200, deleted.text);
        assert.deepEqual(deleted.body, { success: true });
        assert.equal(commentRow(visible), undefined);
        assert.ok(!(await getComments(place, 'deleteUser')).some((item) => item.id === visible));

        model.behavior = () => flagged(['harmful'], 0.9);
        const pending = await postComment('deletePendingUser', otherPlace, '待删除的待审评论');
        assert.equal(pending.status, 200, pending.text);
        await waitIdle();
        const request = openCommentRequest(pending.body.comment.id);
        assert.ok(request);
        const removed = await call('DELETE', `/comments/${pending.body.comment.id}`, 'deletePendingUser');
        assert.equal(removed.status, 200, removed.text);
        assert.equal(commentRow(pending.body.comment.id), undefined);
        assert.equal(requestRow(request.id).status, 'withdrawn');
        assert.ok(!(await getComments(otherPlace, 'deletePendingUser')).some((item) => item.id === pending.body.comment.id));
    });

    await test('manual review lists comment requests, approves/rejects with audit, and rejects stale targets', async () => {
        addUser('reviewApproveUser');
        addUser('reviewRejectUser');
        addUser('reviewDeleteUser');
        addUser('reviewEditUser');
        addUser('nobody', { admin: 'NOBODY' });
        const approvePlace = insertPlace('复核通过面馆');
        const rejectPlace = insertPlace('复核驳回面馆');
        const deletePlace = insertPlace('复核已删面馆');
        const editPlace = insertPlace('复核已改面馆');
        rate(approvePlace, 'reviewApproveUser');
        rate(rejectPlace, 'reviewRejectUser');
        rate(deletePlace, 'reviewDeleteUser');
        rate(editPlace, 'reviewEditUser');
        model.behavior = () => flagged(['harmful'], 0.9);
        const approveComment = await postComment('reviewApproveUser', approvePlace, '需要复核通过的评论');
        const rejectComment = await postComment('reviewRejectUser', rejectPlace, '需要复核驳回的评论');
        const deleteComment = await postComment('reviewDeleteUser', deletePlace, '复核前作者删除的评论');
        const editComment = await postComment('reviewEditUser', editPlace, '复核前作者修改的评论');
        for (const response of [approveComment, rejectComment, deleteComment, editComment]) assert.equal(response.status, 200, response.text);
        await waitIdle();

        const approveRequest = openCommentRequest(approveComment.body.comment.id);
        const rejectRequest = openCommentRequest(rejectComment.body.comment.id);
        const deleteRequest = openCommentRequest(deleteComment.body.comment.id);
        const editRequest = openCommentRequest(editComment.body.comment.id);
        for (const request of [approveRequest, rejectRequest, deleteRequest, editRequest]) assert.ok(request);

        const listed = await call('GET', '/place-requests', 'admin');
        assert.equal(listed.status, 200, listed.text);
        const listedApprove = listed.body.find((row) => row.id === approveRequest.id);
        assert.ok(listedApprove, 'pending comment request is listed');
        assert.equal(listedApprove.request_type, 'comment');
        assert.equal(listedApprove.place_name, '复核通过面馆');
        assert.deepEqual(listedApprove.comment, {
            id: approveComment.body.comment.id,
            content: '需要复核通过的评论',
            status: 'pending',
            username: 'reviewApproveUser'
        });
        assertError(await call('GET', '/place-requests', 'alice'), 403, 'ADMIN_FORBIDDEN', 'ordinary resident list');
        assertError(await call('GET', '/place-requests', null), 401, 'AUTH_REQUIRED', 'guest list');
        assertError(await call('GET', '/place-requests', 'nobody'), 403, 'ADMIN_FORBIDDEN', 'admin without manage_places');

        assertError(await call('POST', `/place-requests/${approveRequest.id}/review`, 'alice', { action: 'approve' }),
            403, 'ADMIN_FORBIDDEN', 'ordinary resident review');
        assertError(await call('POST', `/place-requests/${approveRequest.id}/review`, 'nobody', { action: 'approve' }),
            403, 'ADMIN_FORBIDDEN', 'admin without manage_places review');

        const approved = await call('POST', `/place-requests/${approveRequest.id}/review`, 'admin', { action: 'approve' });
        assert.equal(approved.status, 200, approved.text);
        assert.equal(commentRow(approveComment.body.comment.id).moderation_status, 'visible');
        assert.equal(requestRow(approveRequest.id).status, 'approved');
        const approveAudit = sql.prepare(`SELECT * FROM AdminAudit WHERE action = 'place-request-review'
            AND admin_id = ? ORDER BY id DESC LIMIT 1`).get(users.admin);
        assert.ok(approveAudit, 'approval writes AdminAudit');
        assert.deepEqual(JSON.parse(approveAudit.details),
            { request_id: approveRequest.id, comment_id: approveComment.body.comment.id, action: 'approve' });
        assert.equal((await getPlace(approvePlace, 'bob')).status, 200);
        assert.ok((await getComments(approvePlace, 'bob')).some((item) => item.id === approveComment.body.comment.id));

        const rejected = await call('POST', `/place-requests/${rejectRequest.id}/review`, 'admin', { action: 'reject' });
        assert.equal(rejected.status, 200, rejected.text);
        assert.equal(commentRow(rejectComment.body.comment.id).moderation_status, 'rejected');
        assert.equal(requestRow(rejectRequest.id).status, 'rejected');
        const rejectAudit = sql.prepare(`SELECT * FROM AdminAudit WHERE action = 'place-request-review'
            AND admin_id = ? ORDER BY id DESC LIMIT 1`).get(users.admin);
        assert.equal(JSON.parse(rejectAudit.details).action, 'reject');
        const ownRejected = (await getComments(rejectPlace, 'reviewRejectUser')).find((item) => item.id === rejectComment.body.comment.id);
        assert.deepEqual([ownRejected.status, ownRejected.mine], ['rejected', true]);
        assert.ok(!(await getComments(rejectPlace, 'bob')).some((item) => item.id === rejectComment.body.comment.id));
        assert.equal((await call('POST', `/place-requests/${rejectRequest.id}/review`, 'admin', { action: 'approve' })).status, 409,
            'already reviewed requests cannot be reviewed again');

        await call('DELETE', `/comments/${deleteComment.body.comment.id}`, 'reviewDeleteUser');
        assert.equal(requestRow(deleteRequest.id).status, 'withdrawn');
        assertError(await call('POST', `/place-requests/${deleteRequest.id}/review`, 'admin', { action: 'approve' }),
            409, 'COMMENT_REVIEW_STALE', 'deleted comment');

        const edited = await postComment('reviewEditUser', editPlace, '复核前已经改过的内容');
        assert.equal(edited.status, 200, edited.text);
        assert.equal(edited.body.comment.status, 'checking');
        assert.equal(requestRow(editRequest.id).status, 'withdrawn');
        assertError(await call('POST', `/place-requests/${editRequest.id}/review`, 'admin', { action: 'approve' }),
            409, 'COMMENT_REVIEW_STALE', 'edited comment');
    });

    await test('admin deletion, place deletion and account deletion remove comments and withdraw reviews', async () => {
        addUser('adminDeleteVisibleUser');
        addUser('adminDeletePendingUser');
        addUser('placeDeleteUser');
        addUser('accountDeleteUser');
        const adminVisiblePlace = insertPlace('管理员删除公开评论面馆');
        const adminPendingPlace = insertPlace('管理员删除待审评论面馆');
        const placeDeletePlace = insertPlace('删除地点连带面馆');
        const accountVisiblePlace = insertPlace('注销账号公开评论面馆');
        const accountPendingPlace = insertPlace('注销账号待审评论面馆');
        rate(adminPendingPlace, 'adminDeletePendingUser');
        rate(placeDeletePlace, 'placeDeleteUser');
        rate(accountVisiblePlace, 'accountDeleteUser');
        rate(accountPendingPlace, 'accountDeleteUser');

        const adminVisible = insertComment({
            placeId: adminVisiblePlace, user: 'adminDeleteVisibleUser', content: '管理员要删除的公开评论',
            time: '2026-05-01T00:00:00.000Z'
        });
        const adminDeleted = await call('DELETE', `/admin/comments/${adminVisible}`, 'admin');
        assert.equal(adminDeleted.status, 200, adminDeleted.text);
        assert.equal(commentRow(adminVisible), undefined);
        assert.ok(!(await getComments(adminVisiblePlace, 'alice')).some((item) => item.id === adminVisible));
        assert.ok(sql.prepare("SELECT 1 FROM AdminAudit WHERE action = 'delete-comment' AND admin_id = ?").get(users.admin));

        model.behavior = () => flagged(['harmful'], 0.9);
        const adminPending = await postComment('adminDeletePendingUser', adminPendingPlace, '管理员要删除的待审评论');
        assert.equal(adminPending.status, 200, adminPending.text);
        await waitIdle();
        const adminPendingRequest = openCommentRequest(adminPending.body.comment.id);
        assert.ok(adminPendingRequest);
        assert.equal((await call('DELETE', `/admin/comments/${adminPending.body.comment.id}`, 'admin')).status, 200);
        assert.equal(commentRow(adminPending.body.comment.id), undefined);
        assert.equal(requestRow(adminPendingRequest.id).status, 'withdrawn');
        assertError(await call('DELETE', `/admin/comments/${adminVisible}`, 'admin'), 404, 'COMMENT_NOT_FOUND', 'admin delete missing');

        const placePending = await postComment('placeDeleteUser', placeDeletePlace, '删除地点前的待审评论');
        assert.equal(placePending.status, 200, placePending.text);
        await waitIdle();
        const placePendingRequest = openCommentRequest(placePending.body.comment.id);
        assert.ok(placePendingRequest);
        assert.equal((await call('DELETE', `/places/${placeDeletePlace}`, 'creator')).status, 200);
        assert.equal(commentRow(placePending.body.comment.id), undefined);
        assert.equal(requestRow(placePendingRequest.id).status, 'withdrawn');
        assert.equal((await getPlace(placeDeletePlace, 'alice')).status, 404);

        const accountVisible = insertComment({
            placeId: accountVisiblePlace, user: 'accountDeleteUser', content: '注销前的公开评论',
            time: '2026-05-01T00:00:01.000Z'
        });
        const accountPending = await postComment('accountDeleteUser', accountPendingPlace, '注销前的待审评论');
        assert.equal(accountPending.status, 200, accountPending.text);
        await waitIdle();
        const accountPendingRequest = openCommentRequest(accountPending.body.comment.id);
        assert.ok(accountPendingRequest);
        assert.equal((await getComments(accountVisiblePlace, 'alice')).some((item) => item.id === accountVisible), true);
        sql.prepare('DELETE FROM User WHERE id = ?').run(users.accountDeleteUser); // DELETE /users/me 的同一操作
        assert.equal(commentRow(accountVisible), undefined);
        assert.equal(commentRow(accountPending.body.comment.id), undefined);
        assert.equal(requestRow(accountPendingRequest.id).status, 'withdrawn');
        assert.ok(!(await getComments(accountVisiblePlace, 'alice')).some((item) => item.id === accountVisible));
    });

    await test('admin edit evidence never includes resident comments', async () => {
        addUser('evidenceUser');
        const place = insertPlace('修改依据面馆');
        const revisionComment = insertComment({
            placeId: place, user: 'creator', content: '这是一条修改依据', source: null,
            time: '2026-06-01T00:00:00.000Z', placeRevisionId: 'revision-1'
        });
        const legacyComment = insertComment({
            placeId: place, user: 'creator', content: '旧格式的系统记录', source: null,
            time: '2026-06-01T00:00:01.000Z'
        });
        const resident = insertComment({
            placeId: place, user: 'evidenceUser', content: '住民公开评论',
            time: '2026-06-01T00:00:02.000Z'
        });

        const editOnly = await call('GET', `/comments/place/${place}?kind=edit`, 'admin');
        assert.equal(editOnly.status, 200, editOnly.text);
        assert.deepEqual(editOnly.body.map((row) => row.id), [revisionComment]);
        assert.ok(editOnly.body.every((row) => row.id !== resident));

        const all = await call('GET', `/comments/place/${place}`, 'admin');
        assert.equal(all.status, 200, all.text);
        assert.deepEqual(all.body.map((row) => row.id), [legacyComment, revisionComment]);
        assert.ok(!all.body.some((row) => row.id === resident), 'resident comment is not an edit record');
        const oldKind = await call('GET', `/comments/place/${place}?kind=other`, 'admin');
        assert.deepEqual(oldKind.body.map((row) => row.id), [legacyComment, revisionComment]);
        assertError(await call('GET', `/comments/place/${place}?kind=edit`, 'alice'), 403, 'ADMIN_FORBIDDEN', 'ordinary edit history');
        assertError(await call('GET', `/comments/place/${place}?kind=edit`, null), 401, 'AUTH_REQUIRED', 'guest edit history');
    });

    await test('parallel duplicate submissions stay one comment and one quota write', async () => {
        addUser('concurrentUser');
        const place = insertPlace('并发提交面馆');
        rate(place, 'concurrentUser');
        const before = model.calls.length;
        const [first, second] = await Promise.all([
            postComment('concurrentUser', place, '并发相同内容'),
            postComment('concurrentUser', place, '并发相同内容')
        ]);
        assert.equal(first.status, 200, first.text);
        assert.equal(second.status, 200, second.text);
        assert.equal(first.body.comment.id, second.body.comment.id);
        assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM Comment WHERE place_id = ? AND user_id = ? AND source = 'resident'")
            .get(place, users.concurrentUser).n, 1);
        assert.equal(quotaRow('concurrentUser').writes, 1);
        await waitIdle();
        assert.equal(model.calls.length, before + 1, 'the second identical request is an unchanged submission');

        const [a, b] = await Promise.all([
            postComment('concurrentUser', place, '并发内容 A'),
            postComment('concurrentUser', place, '并发内容 B')
        ]);
        assert.equal(a.status, 200, a.text);
        assert.equal(b.status, 200, b.text);
        assert.equal(a.body.comment.id, b.body.comment.id);
        const row = sql.prepare("SELECT * FROM Comment WHERE place_id = ? AND user_id = ? AND source = 'resident'")
            .get(place, users.concurrentUser);
        assert.ok(['并发内容 A', '并发内容 B'].includes(row.content));
        assert.equal(quotaRow('concurrentUser').writes, 3);
        await waitIdle();
    });

    await test('all screening calls use the comment prompt and carry the place and comment payload', async () => {
        assert.ok(model.calls.length > 0);
        for (const callRecord of model.calls) {
            assert.equal(callRecord.system, moderation.COMMENT_SYSTEM_PROMPT);
            assert.equal(typeof callRecord.input.comment, 'string');
            assert.equal(typeof callRecord.input.place.name, 'string');
            assert.ok(Array.isArray(callRecord.input.place.categories));
        }
    });

    const failed = results.filter((result) => !result.ok);
    console.log(`place comment tests: ${results.length - failed.length}/${results.length} passed`);
    if (failed.length) {
        console.error(`${failed.length} failed:`);
        for (const result of failed) {
            console.error(`FAIL ${result.name}`);
            console.error(result.error && result.error.stack ? result.error.stack : String(result.error));
        }
        process.exitCode = 1;
    } else {
        console.log('place comment tests passed: validation, ratings, quota, transitions, screening races, visibility, review, deletion cascades and edit-history isolation.');
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    if (server) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
    try { sql.close(); } catch (_) { /* already closed */ }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
