// Async numeric API migration: assertions unchanged; await remote computations.
(async()=>{
// QQ Bot: conversation drafts, submission idempotency, identity, whitelist sync,
// notification queue/worker, keyword search and the OneBot client, against an
// isolated SQLite file and a fake NapCat WebSocket. No network access.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-qq-bot-'));
process.env.DB_FILE = path.join(temp, 'test.sqlite');
process.env.LOG_TO_FILE = 'false';
process.env.LOG_TO_CONSOLE = 'false';
process.env.SILICONFLOW_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
// New places are public at once here; the moderation flow has its own test (test_place_moderation.js).
process.env.PLACE_MODERATION_ENABLED = 'false';
require.cache[require.resolve('../../infrastructure/redis')] = { exports: { isReady: () => false } };
const { db, init } = require('../../infrastructure/database');
const sql = db._raw;
const botConfig = require('../../modules/qqbot/runtime/config');
const { parseMessage, parseLocationCard, parseCommand } = require('../../modules/qqbot/runtime/messageParser');
const commands = require('../../modules/qqbot/runtime/commands');
const conversation = require('../../modules/qqbot/runtime/placeConversation');
const { MemberSync } = require('../../modules/qqbot/runtime/memberSync');
const { NotificationWorker, buildMessage, retryNotification } = require('../../modules/qqbot/runtime/notificationWorker');
const { OneBotClient } = require('../../modules/qqbot/runtime/onebotClient');
const placeService = require('../../modules/places/services/placeService');
const { fastSearch } = require('../../modules/discovery/services/placeSearch');
const BOT = '900001';
const GROUP_A = '30001';
const GROUP_B = '30002';
const silentLogger = { debug() { }, info() { }, notice() { }, warn() { }, error() { } };
function configure(overrides = {}) {
    botConfig.setForTesting({
        enabled: true,
        wsUrl: 'ws://fake',
        accessToken: 'secret-token',
        selfId: BOT,
        publicWebUrl: 'https://dinnerparty.cc',
        publicWebUrlError: null,
        commands: { enabled: true, privateEnabled: true, groupIds: [GROUP_A, GROUP_B] },
        whitelist: { mode: 'on', groupIds: [GROUP_A, GROUP_B], intervalMs: 3600000 },
        notify: { enabled: true, groupIds: [GROUP_A, GROUP_B] },
        ...overrides
    });
}
let clock = new Date('2026-10-12T04:00:00.000Z');
const tick = (ms) => { clock = new Date(clock.getTime() + ms); };
let botMessageId = 7000;
// The structure of a real QQ location card captured from NapCat 4.18.38.
const REAL_CARD = '{"app":"com.tencent.map","config":{"autosize":false,"ctime":1791800859,"forward":true,"token":"x","type":"normal"},"desc":"","from":1,"meta":{"Location.Search":{"address":"广东省广州市番禺区大学城内环东路","enum_relation_type":1,"from":"plusPanel","from_account":3131421042,"id":"","lat":"23.050701","lng":"113.401693","name":"华南理工大学(大学城校区)","uint64_peer_account":994716945}},"prompt":"[位置]华南理工大学(大学城校区)","ver":"1.1.2.21","view":"LocationShare"}\n';
function card({ name = '测试地点', address = '测试路 1 号', lat = 23.05, lng = 113.4 } = {}) {
    return JSON.stringify({ app: 'com.tencent.map', view: 'LocationShare', meta: { 'Location.Search': { name, address, lat: String(lat), lng: String(lng) } } });
}
function ctxFor({ chatType = 'private', chatId, qq, text = '', location = null, rawCard = null, atSelf = false, replyId = null, role = 'member' }) {
    const message = [];
    if (replyId)
        message.push({ type: 'reply', data: { id: String(replyId) } });
    if (atSelf)
        message.push({ type: 'at', data: { qq: BOT } });
    if (text)
        message.push({ type: 'text', data: { text } });
    if (location || rawCard)
        message.push({ type: 'json', data: { data: rawCard || card(location) } });
    const isGroup = chatType === 'group';
    return {
        botId: BOT, chatType, chatId: isGroup ? String(chatId) : String(qq), senderQq: String(qq), senderRole: isGroup ? role : 'member', isGroup,
        parsed: parseMessage({ message }, BOT), now: clock
    };
}
// Simulates sending the replies: tracked prompts/previews get message ids like NapCat returns.
async function say(options) {
    const replies = await commands.handle(ctxFor(options));
    return replies.map((reply) => {
        const id = ++botMessageId;
        if (reply.draftId && reply.track)
            conversation.recordBotMessage(reply.draftId, reply.track, id, reply.draftVersion);
        return { ...reply, messageId: String(id) };
    });
}
const textOf = (replies) => replies.filter((r) => r.text).map((r) => r.text).join('\n');
const cardsOf = (replies) => replies.filter((r) => r.card).map((r) => r.card.placeId);
/** The bot's async entry point with a fake DeepSeek interpreter. */
async function sayAsync(options, interpret = async () => null) {
    const replies = await commands.handleMessage(ctxFor(options), { interpret });
    return replies.map((reply) => {
        const id = ++botMessageId;
        if (reply.draftId && reply.track)
            conversation.recordBotMessage(reply.draftId, reply.track, id, reply.draftVersion);
        return { ...reply, messageId: String(id) };
    });
}
const codeOf = (replies) => (textOf(replies).match(/!确认提交 (\d{4})/) || [])[1];
const count = (table, where = '1=1', ...args) => sql.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
function user(name, qq, extra = {}) {
    const id = randomUUID();
    sql.prepare('INSERT INTO User (id, username, password, qq, is_banned, ban_reason, ban_expires) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, 'unused', qq, extra.is_banned || 0, extra.ban_reason || null, extra.ban_expires || null);
    return id;
}
/** Runs a private add-place flow up to the preview and returns the preview replies. */
async function flowToPreview(qq, { name, lat = 23.05, lng = 113.4, chat = {} }) {
    await say({ ...chat, qq, text: '！添加地点' });
    await say({ ...chat, qq, location: { name: `${name}附近`, address: '大学城', lat, lng } });
    await say({ ...chat, qq, text: `!店名 ${name}` });
    return await say({ ...chat, qq, text: '!跳过' });
}
function testParser() {
    const real = parseLocationCard(REAL_CARD);
    assert.equal(real.lat, 23.050701);
    assert.equal(real.lng, 113.401693, 'lat/lng are not swapped');
    assert.equal(real.name, '华南理工大学(大学城校区)');
    assert.equal(real.address, '广东省广州市番禺区大学城内环东路');
    assert.equal(parseLocationCard('{"app":"com.tencent.miniapp","meta":{}}'), null, 'other json cards are not locations');
    assert.equal(parseLocationCard('not json'), null);
    assert.ok(parseLocationCard(card({ lat: '', lng: '113' })).invalid, 'missing coordinates are rejected');
    assert.ok(parseLocationCard(card({ lat: 0, lng: 0 })).invalid, '0,0 is rejected');
    assert.ok(parseLocationCard(card({ lat: 91, lng: 113 })).invalid, 'latitude bound');
    assert.ok(parseLocationCard(card({ lat: 23, lng: -181 })).invalid, 'longitude bound');
    const parsed = parseMessage({ message: [{ type: 'reply', data: { id: 12 } }, { type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: ' 店 名 ' } }] }, BOT);
    assert.deepEqual([parsed.replyId, parsed.atSelf, parsed.text], ['12', true, '店 名']);
    assert.deepEqual(['!roll', '！ROLL', '!随机', '!吃什么', '!random'].map((t) => parseCommand(t).name), ['random', 'random', 'random', 'random', 'random']);
    assert.equal(parseCommand('!rollx').name, 'unknown', 'English aliases need a word boundary');
    assert.deepEqual([parseCommand('!find 烧烤').name, parseCommand('!add 老王烧烤').args], ['search', '老王烧烤']);
}
async function testPrivateFlowAndIdempotency() {
    const alice = user('爱丽丝', '100001');
    assert.match(textOf(await say({ qq: '199999', text: '！添加地点' })), /注册/, 'an unknown QQ is asked to register');
    assert.equal(count('QQBotDraft'), 0);
    assert.match(textOf(await say({ qq: '100001', text: '！添加地点' })), /位置/);
    assert.match(textOf(await say({ qq: '100001', text: '!添加地点' })), /未完成的草稿/, 'a second start never overwrites the draft');
    assert.match(textOf(await say({ qq: '100001', text: '华南理工大学饭堂' })), /原生“位置”/, 'text cannot replace a location');
    assert.match(textOf(await say({ qq: '100001', rawCard: REAL_CARD })), /已收到“华南理工大学\(大学城校区\)”的位置，请发送店名/);
    assert.match(textOf(await say({ qq: '100001', text: '!查询 不存在的店' })), /没有找到/, 'a query in the middle keeps the draft');
    assert.match(textOf(await say({ qq: '100001', text: '华南理工大学饭堂' })), /请发送描述/);
    const firstReview = await say({ qq: '100001', text: '示例描述' });
    assert.match(textOf(firstReview), /描述已更新。\n请核对：[\s\S]*可选补充[\s\S]*!人均 20/, 'the description goes straight to the review');
    assert.match(textOf(await say({ qq: '100009', text: '添加地点' })), /你好/, 'the bare phrase is no longer a command');
    assert.match(textOf(await say({ qq: '100001', text: '!人均 20.5' })), /正整数/, 'decimal cost is rejected, not truncated');
    assert.match(textOf(await say({ qq: '100001', text: '!人均 0' })), /正整数/);
    assert.match(textOf(await say({ qq: '100001', text: '!人均 20元' })), /人均已设为 20 元。已重新生成核对信息。\n请核对：/, 'each supplement re-sends the review');
    assert.match(textOf(await say({ qq: '100001', text: '!tag 这是一个非常非常长的标签名字' })), /不能超过8个汉字/);
    assert.match(textOf(await say({ qq: '100001', text: '!tag <b>x</b>' })), /纯文本/);
    assert.match(textOf(await say({ qq: '100001', text: '！tag 快餐，避雷,快餐' })), /快餐、避雷/, 'Chinese commas work and duplicates are removed');
    const draft = sql.prepare("SELECT * FROM QQBotDraft WHERE sender_qq = '100001' AND status = 'active'").get();
    assert.equal(draft.user_id, alice);
    const preview = await say({ qq: '100001', text: '!提交' });
    const code = codeOf(preview);
    assert.ok(code, textOf(preview));
    assert.match(textOf(preview), /店名：华南理工大学饭堂[\s\S]*地址：广东省广州市番禺区大学城内环东路[\s\S]*人均：20 元[\s\S]*标签：快餐、避雷[\s\S]*作者：爱丽丝/);
    assert.equal(count('Place'), 0, 'preview creates nothing');
    assert.match(textOf(await say({ qq: '100001', text: '!确认提交 0000' })), /确认码不正确/);
    const done = await say({ qq: '100001', text: `!确认提交 ${code}` });
    assert.match(textOf(done), /添加成功！在地图中查看：https:\/\/dinnerparty\.cc\/\?place=\d+/);
    const place = sql.prepare('SELECT * FROM Place').get();
    assert.deepEqual([place.name, place.description, place.category, place.per_person_cost, place.address, place.creator_id, place.updated_by], ['华南理工大学饭堂', '示例描述', '快餐, 避雷', 20, '广东省广州市番禺区大学城内环东路', alice, alice]);
    assert.deepEqual([place.latitude, place.longitude], [23.050701, 113.401693]);
    assert.equal(count('QQBotSubmission'), 1);
    assert.deepEqual(sql.prepare('SELECT group_id FROM QQBotNotification WHERE place_id = ? ORDER BY group_id').all(place.id).map((r) => r.group_id), [GROUP_A, GROUP_B]);
    assert.ok(sql.prepare("SELECT 1 FROM Category WHERE name = '避雷'").get());
    // Repeated confirmation (e.g. the success reply was lost) returns the same place.
    assert.match(textOf(await say({ qq: '100001', text: `!确认提交 ${code}` })), new RegExp(`已经提交过了[\\s\\S]*place=${place.id}`));
    const submitted = sql.prepare("SELECT * FROM QQBotDraft WHERE sender_qq = '100001' AND status = 'submitted'").get();
    const replay = conversation.submitDraft(submitted.id, submitted.preview_request_id, clock);
    assert.deepEqual([replay.status, replay.placeId], ['replayed', place.id]);
    assert.equal(count('Place'), 1);
    assert.equal(count('QQBotNotification'), 2, 'one task per group, even after retries');
}
async function testGroupIsolationAndVersions() {
    user('鲍勃', '100002');
    user('卡罗尔', '100003');
    const inA = { chatType: 'group', chatId: GROUP_A };
    const inB = { chatType: 'group', chatId: GROUP_B };
    assert.deepEqual(await say({ ...inA, qq: '100002', text: '添加地点' }), [], 'groups need a prefix or @ to start');
    assert.deepEqual(await say({ chatType: 'group', chatId: '39999', qq: '100002', text: '' }), []);
    const start = await say({ ...inA, qq: '100002', text: '!添加地点' });
    assert.match(textOf(start), /位置/);
    await say({ ...inB, qq: '100002', text: '!添加地点' });
    await say({ qq: '100002', text: '！添加地点' });
    assert.equal(count('QQBotDraft', "sender_qq = '100002' AND status = 'active'"), 3, 'group A, group B and private are separate drafts');
    // A location is taken in the group without @ while this sender waits for one.
    const located = await say({ ...inA, qq: '100002', location: { name: '东门', lat: 23.1, lng: 113.5 } });
    assert.match(textOf(located), /请发送店名[\s\S]*回复本条消息/);
    assert.deepEqual(await say({ ...inA, qq: '100002', location: { name: '别处', lat: 23.2, lng: 113.6 } }), [], 'a second card without @ is ignored');
    // Ordinary chat is not collected; a reply to the bot's question or an @ is.
    assert.deepEqual(await say({ ...inA, qq: '100002', text: '今天吃什么' }), []);
    assert.deepEqual(await say({ ...inA, qq: '100003', text: '我来回答', replyId: located[0].messageId }), [], 'other members cannot answer for the draft owner');
    assert.match(textOf(await say({ ...inA, qq: '100002', text: '东门烧腊', replyId: located[0].messageId })), /请发送描述/);
    assert.match(textOf(await say({ ...inA, qq: '100002', text: '叉烧不错', atSelf: true })), /描述已更新。\n请核对：/, 'answering the description in the group shows the review');
    const fields = (key) => JSON.parse(sql.prepare("SELECT fields FROM QQBotDraft WHERE chat_id = ? AND sender_qq = '100002' AND status = 'active'").get(key).fields);
    assert.equal(fields(GROUP_A).name, '东门烧腊');
    assert.equal(fields(GROUP_B).name, undefined, 'group B draft is untouched');
    const preview = await say({ ...inA, qq: '100002', text: '!提交' });
    const oldCode = codeOf(preview);
    await say({ ...inA, qq: '100002', text: '!店名 东门烧腊（二店）' });
    assert.match(textOf(await say({ ...inA, qq: '100002', text: `!确认提交 ${oldCode}` })), /确认码不正确/, 'editing re-issues the review, so the old code no longer works');
    assert.match(textOf(await say({ ...inA, qq: '100002', text: '确认提交', replyId: preview[0].messageId })), /预览已失效/, 'quoting the old preview fails');
    const fresh = await say({ ...inA, qq: '100002', text: '!提交' });
    assert.match(textOf(await say({ ...inA, qq: '100002', text: '确认提交', replyId: preview[0].messageId })), /这条预览已失效/);
    tick(conversation.PREVIEW_TTL_MS + 1000);
    assert.match(textOf(await say({ ...inA, qq: '100002', text: '确认提交', replyId: fresh[0].messageId })), /预览已过期/);
    const latest = await say({ ...inA, qq: '100002', text: '!提交' });
    const done = await say({ ...inA, qq: '100002', text: '确认提交', replyId: latest[0].messageId });
    assert.match(textOf(done), /添加成功！「东门烧腊（二店）」已加入地图/, 'quoting the current preview confirms without a code');
    assert.equal(count('QQBotDraft', "chat_id = ? AND sender_qq = '100002' AND status = 'active'", GROUP_B), 1, 'other drafts stay open');
}
async function testPauseExpiryAndCancel() {
    user('戴夫', '100004');
    await say({ qq: '100004', text: '！添加地点' });
    await say({ qq: '100004', location: { lat: 22.5, lng: 114 } });
    tick(conversation.PAUSE_AFTER_MS + 60000);
    assert.match(textOf(await say({ qq: '100004', text: '深夜面馆' })), /暂停/);
    assert.equal(JSON.parse(sql.prepare("SELECT fields FROM QQBotDraft WHERE sender_qq = '100004' AND status = 'active'").get().fields).name, undefined);
    assert.match(textOf(await say({ qq: '100004', text: '!继续' })), /当前草稿[\s\S]*请发送店名/);
    assert.match(textOf(await say({ qq: '100004', text: '深夜面馆' })), /请发送描述/, 'resumed drafts collect text again');
    assert.match(textOf(await say({ qq: '100004', text: '!定位' })), /重新发送/);
    assert.match(textOf(await say({ qq: '100004', location: { name: '新址', lat: 22.6, lng: 114.1 } })), /定位已更新/);
    tick(conversation.DRAFT_TTL_MS + 60000);
    assert.match(textOf(await say({ qq: '100004', text: '!草稿' })), /没有进行中的草稿/, 'drafts expire after 24 h');
    assert.equal(count('QQBotDraft', "sender_qq = '100004' AND status = 'expired'"), 1);
    await say({ qq: '100004', text: '！添加地点' });
    assert.match(textOf(await say({ qq: '100004', text: '!取消' })), /已取消/);
    assert.equal(count('QQBotDraft', "sender_qq = '100004' AND status = 'active'"), 0);
}
async function testIdentityChecks() {
    const eve = user('伊芙', '100005');
    const preview = await flowToPreview('100005', { name: '封禁测试店', lat: 24, lng: 115 });
    sql.prepare("UPDATE User SET is_banned = 1, ban_reason = '测试' WHERE id = ?").run(eve);
    assert.match(textOf(await say({ qq: '100005', text: `!确认提交 ${codeOf(preview)}` })), /受限/, 'banned after preview: rejected');
    assert.equal(count('Place', "name = '封禁测试店'"), 0);
    sql.prepare("UPDATE User SET ban_expires = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(eve);
    assert.match(textOf(await say({ qq: '100005', text: `!确认提交 ${codeOf(preview)}` })), /添加成功/, 'an expired ban no longer blocks');
    const frank = user('弗兰克', '100006');
    const preview2 = await flowToPreview('100006', { name: '删号测试店', lat: 24.1, lng: 115.1 });
    sql.prepare('DELETE FROM User WHERE id = ?').run(frank);
    user('新弗兰克', '100006');
    assert.match(textOf(await say({ qq: '100006', text: `!确认提交 ${codeOf(preview2)}` })), /账号信息已变化/, 'a deleted/rebound account cannot submit');
    assert.equal(count('Place', "name = '删号测试店'"), 0);
    // Several accounts with one QQ: never pick one of them.
    sql.exec('DROP INDEX idx_user_qq');
    user('重复甲', '100007');
    user('重复乙', '100007');
    assert.match(textOf(await say({ qq: '100007', text: '！添加地点' })), /多个网站账号/);
    sql.exec("DELETE FROM User WHERE qq = '100007'");
    sql.exec('CREATE UNIQUE INDEX idx_user_qq ON User(qq)');
}
async function testDuplicatesAndRollback() {
    user('格蕾丝', '100008');
    const existing = await placeService.createPlace({ name: '阿强牛肉面', latitude: 25, longitude: 116 }, null, { source: 'web' });
    const preview = await flowToPreview('100008', { name: '阿强牛肉面', lat: 25.0005, lng: 116.0005 });
    assert.match(textOf(preview), new RegExp(`附近已有名称相似的地点[\\s\\S]*阿强牛肉面（约 \\d+ 米） https://dinnerparty\\.cc/\\?place=${existing.id}`));
    // A similar place that appears after the preview sends the user back to a fresh preview.
    await placeService.createPlace({ name: '阿强牛肉面(分店)', latitude: 25.0006, longitude: 116.0006 }, null, { source: 'web' });
    assert.match(textOf(await say({ qq: '100008', text: `!确认提交 ${codeOf(preview)}` })), /附近刚出现名称相似的地点/);
    assert.match(textOf(await say({ qq: '100008', text: `!确认提交 ${codeOf(preview)}` })), /预览已失效/);
    await say({ qq: '100008', text: '!tag 回滚专用标签' });
    const preview2 = await say({ qq: '100008', text: '!提交' });
    // A failure late in the submit transaction rolls back place, categories and notifications together.
    const placesBefore = count('Place');
    const notificationsBefore = count('QQBotNotification');
    sql.exec("CREATE TEMP TRIGGER fail_submission BEFORE INSERT ON QQBotSubmission BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await assert.rejects(async () => await say({ qq: '100008', text: `!确认提交 ${codeOf(preview2)}` }), /boom/);
    assert.equal(count('Place'), placesBefore);
    assert.equal(count('QQBotNotification'), notificationsBefore);
    assert.equal(count('Category', "name = '回滚专用标签'"), 0);
    assert.equal(count('QQBotDraft', "sender_qq = '100008' AND status = 'active'"), 1, 'the draft survives');
    sql.exec('DROP TRIGGER fail_submission');
    assert.match(textOf(await say({ qq: '100008', text: `!确认提交 ${codeOf(preview2)}` })), /添加成功/, 'confirming again after the failure works');
    assert.equal(count('Place'), placesBefore + 1);
    // Website creation: strict validation, address column and a rollback with the notification insert.
    await assert.rejects(async () => await placeService.createPlace({ name: '空坐标', latitude: null, longitude: 116 }, null, { source: 'web' }), /纬度必须是有效数字/);
    await assert.rejects(async () => await placeService.createPlace({ name: '空串坐标', latitude: '', longitude: 116 }, null, { source: 'web' }), /纬度必须是有效数字/);
    await assert.rejects(async () => await placeService.createPlace({ name: '小数人均', latitude: 25, longitude: 116, per_person_cost: 12.5 }, null, { source: 'web' }), /正整数/);
    const web = await placeService.createPlace({ name: '网页新店', latitude: '25.1', longitude: 116.1, per_person_cost: '30', address: '网页路 2 号', category: '甜品店' }, null, { source: 'web' });
    assert.deepEqual([web.address, web.per_person_cost, web.latitude], ['网页路 2 号', 30, 25.1]);
    assert.equal(count('QQBotNotification', 'place_id = ?', web.id), 2);
    sql.exec("CREATE TEMP TRIGGER fail_notification BEFORE INSERT ON QQBotNotification BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    await assert.rejects(async () => await placeService.createPlace({ name: '回滚网页店', latitude: 25.2, longitude: 116.2, category: '回滚网页标签' }, null, { source: 'web' }), /boom/);
    sql.exec('DROP TRIGGER fail_notification');
    assert.equal(count('Place', "name = '回滚网页店'"), 0);
    assert.equal(count('Category', "name = '回滚网页标签'"), 0);
    // With pushes switched off nothing is queued, and nothing is back-filled later.
    configure({ notify: { enabled: false, groupIds: [GROUP_A, GROUP_B] } });
    const quiet = await placeService.createPlace({ name: '推送关闭时的店', latitude: 25.3, longitude: 116.3 }, null, { source: 'web' });
    configure();
    assert.equal(count('QQBotNotification', 'place_id = ?', quiet.id), 0);
}
async function testSearch() {
    const add = (name, category, description, created) => sql.prepare('INSERT INTO Place (name, category, description, latitude, longitude, created_time) VALUES (?, ?, ?, 20, 110, ?)').run(name, category, description, created).lastInsertRowid;
    assert.equal((await fastSearch('完全没有的词', 5)).length, 0);
    const only = add('孤品螺蛳粉', '', '', '2026-01-01 00:00:00');
    assert.deepEqual((await fastSearch('孤品螺蛳', 5)).map((p) => p.id), [only]);
    const descOld = add('甲店', '', '这里的拉面王很好吃', '2026-01-01 00:00:00');
    const tag = add('乙店', '拉面王', '', '2026-01-02 00:00:00');
    const contains = add('拉面王二号店', '', '', '2026-01-03 00:00:00');
    const exact = add('拉面王', '', '', '2026-01-01 00:00:00');
    const descNew = add('丙店', '', '拉面王风格', '2026-01-05 00:00:00');
    const extra = add('丁店', '', '拉面王', '2026-01-06 00:00:00');
    const results = await fastSearch('拉面王', 5);
    assert.equal(results.length, 5, 'capped at 5');
    assert.deepEqual(results.map((p) => p.id), [exact, contains, tag, extra, descNew], 'exact → name → tag → description, newest first');
    assert.ok(!results.some((p) => p.id === descOld));
    const message = commands.formatSearchResults('拉面王', results);
    assert.match(message, /找到 5 个地点/);
    assert.match(message, new RegExp(`place=${exact}`));
    commands._resetRateLimitsForTesting();
    const found = await say({ qq: '188888', text: '!查询 拉面王' });
    assert.match(textOf(found), /找到 5 个地点/, 'queries do not need an account');
    assert.deepEqual(cardsOf(found), [exact], 'the first result is also sent as a card');
    assert.match(textOf(await say({ qq: '188888', text: '!查询 拉面王' })), /太频繁/);
    assert.match(textOf(await say({ qq: '188889', text: '!查询' })), /用法/);
    assert.deepEqual(cardsOf(await say({ qq: '188887', text: '!查询 完全没有的词' })), [], 'no card without results');
}
class FakeBotClient {
    constructor() {
        this.connected = true;
        this.selfId = BOT;
        this.calls = [];
        this.handlers = {};
    }
    on(action, handler) { this.handlers[action] = handler; }
    async call(action, params) {
        this.calls.push({ action, params });
        const handler = this.handlers[action];
        if (!handler)
            throw Object.assign(new Error(`no handler for ${action}`), { code: 'failed' });
        return handler(params);
    }
}
async function testMemberSync() {
    const client = new FakeBotClient();
    sql.prepare('INSERT INTO QQWhitelist (qq) VALUES (?)').run('500001');
    const members = { [GROUP_A]: ['500001', '500002', '500003'], [GROUP_B]: ['500003', '500004'] };
    client.on('get_group_member_list', ({ group_id }) => {
        const list = members[String(group_id)];
        if (list instanceof Error)
            throw list;
        return (list || []).map((qq) => ({ user_id: Number(qq) }));
    });
    let mode = 'dry-run';
    const sync = new MemberSync({ client, logger: silentLogger, getConfig: () => ({ whitelist: { mode, groupIds: [GROUP_A, GROUP_B], intervalMs: 3600000 } }) });
    const whitelistSize = () => count('QQWhitelist');
    const before = whitelistSize();
    let results = await sync.syncAll('test');
    assert.equal(whitelistSize(), before, 'dry run writes nothing');
    assert.deepEqual(results.map((r) => r.missingCount), [2, 2]);
    const stateA = sql.prepare('SELECT * FROM QQBotSyncState WHERE group_id = ?').get(GROUP_A);
    assert.deepEqual(JSON.parse(stateA.missing_sample), ['500002', '500003']);
    mode = 'on';
    results = await sync.syncAll('test');
    assert.deepEqual(results.map((r) => r.addedCount), [2, 1], 'members of both groups are merged without duplicates');
    assert.equal(whitelistSize(), before + 3);
    results = await sync.syncAll('test');
    assert.deepEqual(results.map((r) => r.addedCount), [0, 0], 'repeated sync is idempotent');
    members[GROUP_A] = [];
    members[GROUP_B] = Object.assign(new Error('机器人不在群内'), { code: 'failed' });
    results = await sync.syncAll('test');
    assert.deepEqual(results.map((r) => r.status), ['error', 'error']);
    assert.equal(whitelistSize(), before + 3, 'empty lists and failures never remove anyone');
    assert.ok(sql.prepare('SELECT last_success_at FROM QQBotSyncState WHERE group_id = ?').get(GROUP_A).last_success_at, 'last success is kept');
    members[GROUP_A] = ['500005'];
    results = await sync.syncAll('test');
    assert.deepEqual(results.map((r) => r.status), ['ok', 'error'], 'one failing group does not block the other');
    assert.equal(sync.addMember(GROUP_B, '500006').added, true, 'a join is added right away');
    assert.equal(sync.addMember('39999', '500007'), null, 'groups outside the sync list are ignored');
    client.connected = false;
    assert.deepEqual(await sync.syncAll('test'), [], 'nothing runs while disconnected');
}
async function testNotificationWorker() {
    sql.exec('DELETE FROM QQBotNotification');
    const client = new FakeBotClient();
    let nextMessageId = 1;
    const sent = [];
    let failMode = null;
    client.on('send_group_msg', (params) => {
        if (failMode === 'failed')
            throw Object.assign(new Error('风控'), { code: 'failed' });
        if (failMode === 'timeout')
            throw Object.assign(new Error('timed out'), { code: 'timeout', outcomeUnknown: true });
        sent.push(params);
        return { message_id: nextMessageId++ };
    });
    let history = [];
    client.on('get_group_msg_history', () => ({ messages: history }));
    const worker = new NotificationWorker({ client, logger: silentLogger, getConfig: botConfig.get });
    worker.start();
    worker.stop();
    const a = await placeService.createPlace({ name: '通知一号', latitude: 30, longitude: 120, address: '一号路', category: '快餐, 避雷', per_person_cost: 15, description: '描述'.repeat(50) }, null, { source: 'web' });
    const b = await placeService.createPlace({ name: '通知二号', latitude: 30.1, longitude: 120.1 }, null, { source: 'web' });
    await worker.runOnce();
    assert.equal(sent.length, 2, 'two new places in a burst go out as one message per group');
    const text = sent[0].message[0].data.text;
    assert.match(text, /【新地点 ×2】[\s\S]*店名：通知一号[\s\S]*地址：一号路[\s\S]*标签：快餐、避雷[\s\S]*人均：15 元[\s\S]*描述：描述[\s\S]*…[\s\S]*在地图中查看：https:\/\/dinnerparty\.cc\/\?place=/);
    assert.ok(!/@全体成员|"type":"at"/.test(JSON.stringify(sent[0])), 'no @all');
    assert.equal(count('QQBotNotification', "status = 'sent' AND message_id IS NOT NULL"), 4);
    assert.match(buildMessage([{ id: 1, name: '单个', creator_name: '作者' }]), /^【新地点】\n店名：单个\n作者：作者/);
    // Explicit failure: retried later with backoff.
    failMode = 'failed';
    const c = await placeService.createPlace({ name: '通知三号', latitude: 30.2, longitude: 120.2 }, null, { source: 'web' });
    await worker.runOnce();
    const retry = sql.prepare('SELECT * FROM QQBotNotification WHERE place_id = ?').all(c.id);
    assert.ok(retry.every((r) => r.status === 'pending' && r.attempts === 1 && r.next_attempt_at > new Date().toISOString()));
    sql.prepare("UPDATE QQBotNotification SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE place_id = ?").run(c.id);
    // Unknown outcome: never resent blindly; found in history → sent, otherwise left for an admin.
    failMode = 'timeout';
    await worker.runOnce();
    assert.equal(count('QQBotNotification', "place_id = ? AND status = 'unknown'", c.id), 2);
    failMode = null;
    sql.prepare("UPDATE QQBotNotification SET updated_at = '2000-01-01T00:00:00.000Z' WHERE status = 'unknown'").run();
    history = [{ message_id: 99, user_id: Number(BOT), message: [{ type: 'text', data: { text: `在地图中查看：https://dinnerparty.cc/?place=${c.id}` } }] }];
    client.on('get_group_msg_history', ({ group_id }) => ({ messages: String(group_id) === GROUP_A ? history : [] }));
    await worker.runOnce();
    assert.equal(sql.prepare('SELECT status FROM QQBotNotification WHERE place_id = ? AND group_id = ?').get(c.id, GROUP_A).status, 'sent');
    const unresolved = sql.prepare('SELECT * FROM QQBotNotification WHERE place_id = ? AND group_id = ?').get(c.id, GROUP_B);
    assert.equal(unresolved.status, 'unknown');
    assert.match(unresolved.last_error, /已核对/);
    const sentBefore = sent.length;
    await worker.runOnce();
    assert.equal(sent.length, sentBefore, 'unknown tasks are not resent automatically');
    assert.equal(retryNotification(unresolved.id), true);
    await worker.runOnce();
    assert.equal(sent.length, sentBefore + 1, 'an admin retry sends it');
    // Deleted places are skipped; crash leftovers become unknown.
    const d = await placeService.createPlace({ name: '已删除的店', latitude: 30.3, longitude: 120.3 }, null, { source: 'web' });
    sql.prepare('DELETE FROM Place WHERE id = ?').run(d.id);
    await worker.runOnce();
    assert.equal(count('QQBotNotification', "place_id = ? AND status = 'skipped'", d.id), 2);
    sql.prepare("UPDATE QQBotNotification SET status = 'sending' WHERE place_id = ?").run(a.id);
    worker.start();
    worker.stop();
    assert.equal(count('QQBotNotification', "place_id = ? AND status = 'unknown'", a.id), 2);
    client.connected = false;
    const e = await placeService.createPlace({ name: '离线时新增', latitude: 30.4, longitude: 120.4 }, null, { source: 'web' });
    await worker.runOnce();
    assert.equal(count('QQBotNotification', "place_id = ? AND status = 'pending' AND attempts = 0", e.id), 2, 'queued while offline');
    client.connected = true;
    await worker.runOnce();
    assert.equal(count('QQBotNotification', "place_id = ? AND status = 'sent'", e.id), 2, 'delivered after reconnecting');
    assert.ok(b.id);
}
// Minimal stand-in for NapCat's WebSocket server.
function fakeNapCat({ selfId = BOT } = {}) {
    const napcat = { sockets: [], requests: [], selfId, nextMessageId: 1000, handshakeHeaders: null };
    class FakeWebSocket {
        constructor(url, options) {
            this.readyState = 0;
            this.listeners = {};
            napcat.handshakeHeaders = options && options.headers;
            napcat.sockets.push(this);
            setImmediate(() => { this.readyState = 1; this.emit('open', {}); });
        }
        addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); }
        emit(type, event) { (this.listeners[type] || []).forEach((listener) => listener(event)); }
        send(raw) {
            const request = JSON.parse(raw);
            napcat.requests.push(request);
            let data = {};
            if (request.action === 'get_login_info')
                data = { user_id: Number(napcat.selfId) };
            else if (request.action.startsWith('send_'))
                data = { message_id: napcat.nextMessageId++ };
            else if (request.action === 'get_group_member_list')
                data = [{ user_id: 600001 }];
            setImmediate(() => this.emit('message', { data: JSON.stringify({ status: 'ok', retcode: 0, data, echo: request.echo }) }));
        }
        close() {
            if (this.readyState === 3)
                return;
            this.readyState = 3;
            setImmediate(() => this.emit('close', { code: 1000 }));
        }
        push(event) { this.emit('message', { data: JSON.stringify({ self_id: Number(napcat.selfId), time: 0, ...event }) }); }
    }
    napcat.WebSocket = FakeWebSocket;
    return napcat;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
async function testOneBotClientAndBot() {
    // Wrong account: refused, no events processed.
    const wrong = fakeNapCat({ selfId: '900002' });
    const wrongClient = new OneBotClient({ url: 'ws://fake', accessToken: 'secret-token', expectedSelfId: BOT, logger: silentLogger, WebSocketImpl: wrong.WebSocket });
    wrongClient.start();
    await flush();
    assert.equal(wrongClient.connected, false);
    assert.match(wrongClient.status().lastError, /does not match/);
    wrongClient.stop();
    // In-flight requests whose connection drops report an unknown outcome.
    const napcat = fakeNapCat();
    const client = new OneBotClient({ url: 'ws://fake', accessToken: 'secret-token', expectedSelfId: BOT, logger: silentLogger, WebSocketImpl: napcat.WebSocket });
    client.start();
    await flush();
    assert.equal(client.connected, true);
    assert.equal(napcat.handshakeHeaders.Authorization, 'Bearer secret-token');
    const socket = napcat.sockets[0];
    socket.send = function send(raw) { napcat.requests.push(JSON.parse(raw)); };
    const pending = client.call('send_group_msg', { group_id: 1 });
    socket.close();
    await assert.rejects(pending, (error) => error.outcomeUnknown === true);
    client.stop();
    await assert.rejects(client.call('get_login_info'), (error) => error.code === 'not_connected' && !error.outcomeUnknown);
    // Whole bot: replayed messages are handled once; group replies quote and @ the sender.
    user('海蒂', '100009');
    const bot = fakeNapCat();
    const previousWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = bot.WebSocket;
    configure({ whitelist: { mode: 'off', groupIds: [], intervalMs: 3600000 }, notify: { enabled: false, groupIds: [] } });
    const { startQQBot, getQQBotStatus } = require('../../modules/qqbot/runtime/index');
    const instance = startQQBot();
    try {
        await flush();
        assert.equal(getQQBotStatus().connection.connected, true);
        const event = { post_type: 'message', message_type: 'group', sub_type: 'normal', group_id: Number(GROUP_A), user_id: 100009, message_id: 4242,
            message: [{ type: 'text', data: { text: '!添加地点' } }] };
        bot.sockets[0].push(event);
        bot.sockets[0].push(event);
        bot.sockets[0].push({ ...event, message_id: 4243, message: [{ type: 'text', data: { text: '普通聊天' } }] });
        await flush();
        const replies = bot.requests.filter((r) => r.action === 'send_group_msg');
        assert.equal(replies.length, 1, 're-delivered message ids are processed once; chatter is ignored');
        assert.deepEqual(replies[0].params.message.slice(0, 2), [{ type: 'reply', data: { id: '4242' } }, { type: 'at', data: { qq: '100009' } }]);
        const promptId = String(bot.nextMessageId - 1);
        bot.sockets[0].push({ ...event, message_id: 4244, message: [{ type: 'json', data: { data: REAL_CARD } }] });
        await flush();
        const nameQuestion = String(bot.nextMessageId - 1);
        assert.notEqual(nameQuestion, promptId);
        bot.sockets[0].push({ ...event, message_id: 4245, message: [{ type: 'reply', data: { id: nameQuestion } }, { type: 'text', data: { text: '海蒂的店' } }] });
        await flush();
        const draft = sql.prepare("SELECT fields FROM QQBotDraft WHERE sender_qq = '100009' AND status = 'active'").get();
        assert.equal(JSON.parse(draft.fields).name, '海蒂的店', 'quoting the bot question answers it');
        assert.equal(count('QQBotInboundMessage'), 3);
        // Private message from an outsider group is ignored entirely.
        bot.sockets[0].push({ ...event, group_id: 39999, message_id: 4246 });
        await flush();
        assert.equal(bot.requests.filter((r) => r.action === 'send_group_msg').length, 3);
        // A search answers in text, then sends the first result's card on its own; an unusable
        // send_packet answer falls back to the share link.
        commands._resetRateLimitsForTesting();
        bot.sockets[0].push({ ...event, message_id: 4247, message: [{ type: 'text', data: { text: '!查询 拉面王' } }] });
        await flush();
        const sends = bot.requests.filter((r) => r.action === 'send_group_msg');
        assert.equal(sends.length, 5);
        assert.match(sends[3].params.message[2].data.text, /找到 5 个地点/);
        assert.ok(bot.requests.some((r) => r.action === 'send_packet' && r.params.cmd === 'OidbSvcTrpcTcp.0xdc2_34'), 'tries the 图文 card first');
        assert.deepEqual(sends[4].params.message, [{ type: 'text', data: { text: `https://dinnerparty.cc/p/${(await fastSearch('拉面王', 1))[0].id}` } }]);
        // The group role comes from the OneBot event: a group admin may set !随机中心, a member may not.
        bot.sockets[0].push({ ...event, message_id: 4248, sender: { user_id: 100009, role: 'member' }, message: [{ type: 'text', data: { text: '!随机中心 拉面王' } }] });
        bot.sockets[0].push({ ...event, message_id: 4249, sender: { user_id: 100009, role: 'admin' }, message: [{ type: 'text', data: { text: '!随机中心 拉面王' } }] });
        await flush();
        const centerReplies = bot.requests.filter((r) => r.action === 'send_group_msg').slice(-2).map((r) => r.params.message[2].data.text);
        assert.match(centerReplies[0], /只有群主/);
        assert.match(centerReplies[1], /已将本群随机中心设为「/);
        assert.equal(require('../../modules/qqbot/runtime/randomCenter').getGroupCenter(GROUP_A).setBy, '100009');
    }
    finally {
        instance.stop();
        globalThis.WebSocket = previousWebSocket;
    }
}
async function testWebRoute() {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const ivan = user('伊万', '100010');
    const app = express();
    app.use(express.json());
    app.use('/places', require('../../modules/places/routes/places'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const token = jwt.sign({ id: ivan }, process.env.JWT_SECRET || 'yuyuko_secret_key');
        const post = async (body) => {
            const response = await fetch(`http://127.0.0.1:${server.address().port}/places`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body)
            });
            return { status: response.status, body: await response.json() };
        };
        const created = await post({ name: '网页接口店', latitude: 31, longitude: 121, category: '快餐，小吃', per_person_cost: 25, address: '接口路 3 号' });
        assert.equal(created.status, 200, JSON.stringify(created.body));
        assert.deepEqual([created.body.creator_name, created.body.category, created.body.address], ['伊万', '快餐, 小吃', '接口路 3 号']);
        assert.equal(count('QQBotNotification', 'place_id = ?', created.body.id), 2, 'web/App creations notify');
        assert.equal((await post({ name: '无坐标', latitude: null, longitude: 121 })).status, 400);
        assert.equal((await post({ name: '', latitude: 31, longitude: 121 })).status, 400);
        assert.equal((await post({ name: '小数', latitude: 31, longitude: 121, per_person_cost: 9.9 })).status, 400);
    }
    finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
async function testRandomAndLocation() {
    const { pickRandomPlace, _resetForTesting } = require('../../modules/qqbot/runtime/randomPick');
    const { getUserLocation } = require('../../modules/accounts/services/userLocation');
    const { haversineDistanceKm } = require('../../modules/discovery/services/semanticSearch');
    commands._resetRateLimitsForTesting();
    _resetForTesting();
    conversation._resetForTesting();
    const add = (name, lat, lng) => sql.prepare('INSERT INTO Place (name, description, latitude, longitude) VALUES (?, ?, ?, ?)')
        .run(name, `${name}的描述`, lat, lng).lastInsertRowid;
    // Around the default centre (B记鱼粥) and around a user's own position in Shanghai.
    const defaultCenter = botConfig.DEFAULT_RANDOM_CENTER;
    for (let i = 0; i < 5; i += 1)
        add(`默认中心店${i}`, defaultCenter.lat + 0.004 * i, defaultCenter.lng);
    const shanghai = [0, 1, 2, 3, 4].map((i) => add(`人民广场店${i}`, 31.2304 + 0.003 * i, 121.4737));
    const within = (placeId, center) => {
        const place = sql.prepare('SELECT latitude, longitude FROM Place WHERE id = ?').get(placeId);
        return haversineDistanceKm(center, { lat: place.latitude, lng: place.longitude }) <= 5;
    };
    // Unregistered: the default centre.
    const guest = await say({ qq: '177001', text: '!随机' });
    assert.match(textOf(guest), /🎲 随机推荐：[\s\S]*距B记鱼粥 [\d.]+ (km|米)[\s\S]*注册网站账号/);
    assert.equal(cardsOf(guest).length, 1, 'the pick is also sent as a card');
    assert.ok(within(cardsOf(guest)[0], defaultCenter));
    assert.match(textOf(await say({ qq: '177001', text: '!随机' })), /太频繁/, 'shares the query rate limit');
    // Registered without a recorded position: default centre plus a hint.
    const gina = user('吉娜', '177002');
    assert.match(textOf(await say({ qq: '177002', text: '！吃什么' })), /距B记鱼粥[\s\S]*点“定位”/);
    // A location card in private chat without a draft is recorded as the sender's position.
    const recorded = await say({ qq: '177002', location: { name: '人民广场', address: '上海市黄浦区', lat: 31.2304, lng: 121.4737 } });
    assert.match(textOf(recorded), /已记录你的位置「人民广场」/);
    assert.deepEqual([getUserLocation(gina).lat, getUserLocation(gina).source, getUserLocation(gina).label], [31.2304, 'qq', '人民广场']);
    tick(5000);
    const near = await say({ qq: '177002', text: '!随机' });
    assert.match(textOf(near), /距你上次定位的位置（人民广场）/);
    assert.ok(shanghai.includes(cardsOf(near)[0]), 'the pick is around the recorded position');
    // The last two picks are skipped, like the website.
    const ctx = ctxFor({ qq: '177002', text: '!随机' });
    _resetForTesting();
    const picks = [];
    for (const i of [0, 1, 2, 3])
        picks.push((await pickRandomPlace(ctx, { random: () => 0 })).place.id);
    assert.deepEqual(picks, [shanghai[0], shanghai[1], shanghai[2], shanghai[0]]);
    // Groups: a location card only counts right after !定位.
    const hank = user('汉克', '177003');
    assert.deepEqual(await say({ chatType: 'group', chatId: GROUP_A, qq: '177003', location: { name: '外滩', lat: 31.24, lng: 121.49 } }), []);
    assert.equal(getUserLocation(hank), null);
    assert.match(textOf(await say({ chatType: 'group', chatId: GROUP_A, qq: '177003', text: '!定位' })), /发送你现在的位置/);
    assert.match(textOf(await say({ chatType: 'group', chatId: GROUP_A, qq: '177003', location: { name: '外滩', lat: 31.24, lng: 121.49 } })), /已记录你的位置「外滩」/);
    assert.equal(getUserLocation(hank).lng, 121.49);
    assert.match(textOf(await say({ qq: '177009', text: '!定位' })), /注册/, 'positions are only kept for accounts');
    assert.match(textOf(await say({ qq: '177009', location: { name: '某处', lat: 31.2, lng: 121.4 } })), /收到定位。如需添加地点/);
    // Too few places around the centre.
    await say({ qq: '177003', location: { name: '远方', lat: 45, lng: 90 } });
    tick(5000);
    const empty = await say({ qq: '177003', text: '!随机' });
    assert.match(textOf(empty), /以你上次定位的位置（远方）为中心，附近好像没有结果/);
    assert.deepEqual(cardsOf(empty), []);
    // A location card inside a draft is the shop's location, not the sender's.
    const before = getUserLocation(gina).updatedAt;
    tick(1000);
    await say({ qq: '177002', text: '!添加地点' });
    await say({ qq: '177002', location: { name: '店铺定位', lat: 31.3, lng: 121.5 } });
    assert.equal(getUserLocation(gina).updatedAt, before);
    await say({ qq: '177002', text: '!取消' });
}
async function testGroupRandomCenter() {
    const randomCenter = require('../../modules/qqbot/runtime/randomCenter');
    const { haversineDistanceKm } = require('../../modules/discovery/services/semanticSearch');
    commands._resetRateLimitsForTesting();
    const group = async (qq, text, role = 'member', chatId = GROUP_A) => await say({ chatType: 'group', chatId, qq, text, role });
    const near = (replies, center) => {
        const place = sql.prepare('SELECT latitude, longitude FROM Place WHERE id = ?').get(cardsOf(replies)[0]);
        return haversineDistanceKm(center, { lat: place.latitude, lng: place.longitude }) <= 5;
    };
    assert.deepEqual(['!随机中心 B记', '！设置随机中心', '!随机地点', '!随机'].map((t) => parseCommand(t).name), ['random_center', 'random_center', 'random', 'random']);
    assert.equal(parseCommand('!随机中心人民广场').args, '人民广场', 'Chinese argument may be glued');
    // Per group only; anyone can look, only owners/admins (or site admins) can change it.
    assert.match(textOf(await say({ qq: '178001', text: '!随机中心' })), /按群设置/);
    assert.match(textOf(await group('178001', '!随机中心')), /本群还没有设置随机中心[\s\S]*B记鱼粥[\s\S]*!随机中心 清除/);
    assert.match(textOf(await group('178001', '!随机中心 人民广场店2')), /只有群主、群管理员或网站管理员/);
    assert.equal(randomCenter.getGroupCenter(GROUP_A), null);
    assert.match(textOf(await group('178002', '!随机中心 人民广场店2', 'admin')), /已将本群随机中心设为「人民广场店2」/);
    const shanghai = randomCenter.getGroupCenter(GROUP_A);
    assert.deepEqual([shanghai.source, shanghai.setBy, Number(shanghai.lat.toFixed(4))], ['place', '178002', 31.2364]);
    assert.match(textOf(await group('178001', '!随机中心')), /本群随机中心：「人民广场店2」（31\.23640, 121\.47370）/);
    // The group's centre wins over the default and over a member's own last position (hank: 45,90).
    tick(5000);
    const guest = await group('178001', '!随机');
    assert.match(textOf(guest), /距本群中心「人民广场店2」 [\d.]+ (km|米)/);
    assert.doesNotMatch(textOf(guest), /注册网站账号/, 'no position hint under a group centre');
    assert.ok(near(guest, shanghai));
    tick(5000);
    assert.match(textOf(await group('177003', '!随机')), /距本群中心「人民广场店2」/);
    // Another group and private chat keep the old order: own position, then the default.
    tick(5000);
    assert.match(textOf(await group('177003', '!随机', 'member', GROUP_B)), /以你上次定位的位置（远方）为中心/);
    tick(5000);
    assert.match(textOf(await say({ qq: '177003', text: '!随机' })), /以你上次定位的位置（远方）为中心/);
    // Coordinates, the current exhibition, unknown keywords and bad input.
    assert.match(textOf(await group('178003', '!随机中心 95,113 某处', 'owner', GROUP_B)), /坐标无效/);
    assert.match(textOf(await group('178003', '!随机中心 23.016488，113.394404  鱼粥 本店', 'owner', GROUP_B)), /已将本群随机中心设为「鱼粥 本店」/);
    assert.equal(randomCenter.getGroupCenter(GROUP_B).source, 'coordinates');
    assert.match(textOf(await group('178003', '!随机中心 不存在的店名xyz', 'owner', GROUP_B)), /没有找到与「不存在的店名xyz」相关的已收录地点/);
    assert.equal(randomCenter.getGroupCenter(GROUP_B).label, '鱼粥 本店', 'a failed change keeps the old centre');
    assert.match(textOf(await group('178003', '!随机中心 展会', 'owner', GROUP_B)), /当前没有进行中的展会/);
    sql.prepare("INSERT INTO SiteExhibition (name, description, information, is_active) VALUES ('无地点展会', 'd', 'i', 1)").run();
    assert.match(textOf(await group('178003', '!随机中心 展会', 'owner', GROUP_B)), /「无地点展会」没有设置地点/);
    sql.prepare("UPDATE SiteExhibition SET location_name = '保利世贸博览馆', latitude = 23.0961, longitude = 113.3653 WHERE is_active = 1").run();
    assert.match(textOf(await group('178003', '!随机中心 展会', 'owner', GROUP_B)), /已将本群随机中心设为「保利世贸博览馆」（23\.09610, 113\.36530）/);
    assert.equal(randomCenter.getGroupCenter(GROUP_B).source, 'exhibition');
    sql.prepare('UPDATE SiteExhibition SET is_active = 0').run();
    // A site admin linked by QQ may change it without a group role; clearing restores the old order.
    const admin = user('站管', '178004');
    sql.prepare("UPDATE User SET admin_level = 'YOUMU' WHERE id = ?").run(admin);
    assert.match(textOf(await group('178004', '!随机中心 清除', 'member', GROUP_B)), /已清除本群随机中心/);
    assert.equal(randomCenter.getGroupCenter(GROUP_B), null);
    assert.match(textOf(await group('178004', '!随机中心 清除', 'member', GROUP_B)), /本群没有设置随机中心/);
    const komachi = user('小町', '178005');
    sql.prepare("UPDATE User SET admin_level = 'KOMACHI' WHERE id = ?").run(komachi);
    assert.match(textOf(await group('178005', '!随机中心 清除')), /只有群主/, 'comment moderators cannot');
    assert.match(textOf(await group('178002', '!随机中心 reset', 'admin')), /已清除/);
    assert.match(commands.HELP_TEXT, /!随机中心/);
}
async function testCommandInterpreter() {
    const { sanitizeInterpretation } = require('../../modules/qqbot/runtime/commandInterpreter');
    commands._resetRateLimitsForTesting();
    assert.equal(sanitizeInterpretation({ command: 'rm -rf', confidence: 0.9 }).command, 'none', 'only known commands');
    assert.equal(sanitizeInterpretation({ command: 'search', args: '烧烤', confidence: 0.3 }).command, 'none', 'low confidence is ignored');
    assert.equal(sanitizeInterpretation('nope'), null);
    const cleaned = sanitizeInterpretation({ command: 'add', confidence: 0.9, place: { name: ' 某店 ', per_person_cost: '59.6', tags: ['川菜', 1, '', '火锅', '小吃', '甜品'] } });
    assert.deepEqual(cleaned.place, { name: '某店', description: '', per_person_cost: 60, tags: ['川菜', '火锅', '小吃'] });
    assert.equal(sanitizeInterpretation({ command: 'search', args: 'x', confidence: 1, place: { name: 'y' } }).place, null);
    const calls = [];
    const fake = (answer) => async (input) => { calls.push(input); return typeof answer === 'function' ? answer(input) : answer; };
    user('伊莉莎', '166001');
    // A long add-place message: details are recognised, then the location is asked for.
    const long = '!创建测试餐厅地点，菜品很正宗，人均60左右，酸菜鱼做的很好';
    const started = await sayAsync({ qq: '166001', text: long }, fake({
        command: 'add', confidence: 0.92,
        place: { name: '测试餐厅', description: '菜品很正宗，酸菜鱼做的很好', per_person_cost: 60, tags: ['川菜'] }
    }));
    assert.equal(calls.at(-1).text, '创建测试餐厅地点，菜品很正宗，人均60左右，酸菜鱼做的很好', 'the whole message after "!" is interpreted');
    assert.match(textOf(started), /已识别：\n店名：测试餐厅\n人均：60 元\n标签：川菜\n描述：菜品很正宗，酸菜鱼做的很好[\s\S]*发送想添加的店铺定位/);
    const review = await say({ qq: '166001', location: { name: '测试餐厅门口', lat: 23.11, lng: 113.31 } });
    assert.match(textOf(review), /已收到定位。\n请核对：\n店名：测试餐厅[\s\S]*人均：60 元/, 'name and description known: straight to the review');
    await say({ qq: '166001', text: '!取消' });
    // Without a description the description is still asked for after the location.
    tick(3000);
    await sayAsync({ qq: '166001', text: '!添加地点 小面馆，人均15' }, fake({ command: 'add', confidence: 0.9, place: { name: '小面馆', per_person_cost: 15 } }));
    assert.match(textOf(await say({ qq: '166001', location: { name: '面馆', lat: 23.12, lng: 113.32 } })), /已收到定位。请发送描述/);
    await say({ qq: '166001', text: '!取消' });
    // No DeepSeek answer: a short argument becomes the name, a long one is asked step by step.
    tick(3000);
    assert.match(textOf(await sayAsync({ qq: '166001', text: '!添加 海底捞' })), /已识别：\n店名：海底捞/);
    await say({ qq: '166001', text: '!取消' });
    tick(3000);
    assert.match(textOf(await sayAsync({ qq: '166001', text: '!添加 海底捞，服务很好' })), /没能自动识别附加信息/);
    await say({ qq: '166001', text: '!取消' });
    // Unregistered senders are answered without calling DeepSeek.
    const before = calls.length;
    assert.match(textOf(await sayAsync({ qq: '166999', text: long }, fake({ command: 'add', confidence: 1 }))), /注册/);
    assert.equal(calls.length, before);
    // A typo is understood as a command, and the reply says how.
    tick(3000);
    const typo = await sayAsync({ qq: '166002', text: '!查训 拉面王' }, fake({ command: 'search', args: '拉面王', confidence: 0.9 }));
    assert.match(textOf(typo), /^（已理解为 !查询 拉面王）\n「拉面王」找到/);
    assert.equal(cardsOf(typo).length, 1);
    assert.equal(calls.at(-1).hasDraft, false);
    assert.ok(Array.isArray(calls.at(-1).knownTags));
    // Group chatter for other bots stays unanswered; draft commands need a draft.
    tick(3000);
    assert.deepEqual(await sayAsync({ chatType: 'group', chatId: GROUP_A, qq: '166003', text: '!签到' }, fake({ command: 'none', confidence: 0.9 })), []);
    tick(3000);
    assert.deepEqual(await sayAsync({ chatType: 'group', chatId: GROUP_A, qq: '166003', text: '!不要了' }, fake({ command: 'cancel', confidence: 0.9 })), []);
    tick(3000);
    assert.match(textOf(await sayAsync({ qq: '166003', text: '!今天吃点啥好呢' }, fake({ command: 'random', confidence: 0.9 }))), /^（已理解为 !随机）\n🎲 随机推荐/);
    // Failures and the switch fall back to the plain "unknown command" answer.
    tick(3000);
    assert.match(textOf(await sayAsync({ qq: '166004', text: '!查训 拉面' }, async () => { throw new Error('timeout'); })), /未知指令「查训」/);
    tick(3000);
    const sent = calls.length;
    assert.match(textOf(await sayAsync({ qq: '166004', text: '!查训 拉面' }, fake({ command: 'search', args: '拉面', confidence: 1 }))), /已理解为/);
    assert.match(textOf(await sayAsync({ qq: '166004', text: '!查训 拉面' }, fake({ command: 'search', args: '拉面', confidence: 1 }))), /未知指令/, 'per-sender DeepSeek interval');
    assert.equal(calls.length, sent + 1);
    configure({ ai: { enabled: false } });
    tick(3000);
    assert.match(textOf(await sayAsync({ qq: '166005', text: '!查训 拉面' }, fake({ command: 'search', args: '拉面', confidence: 1 }))), /未知指令/);
    configure();
}
async function testPlaceCards() {
    const { sendPlaceCard, cardContent } = require('../../modules/qqbot/runtime/placeCard');
    const { decodeMessage, SSO_COMMAND } = require('../../modules/qqbot/runtime/tuwenArk');
    const placeId = sql.prepare("INSERT INTO Place (name, category, description, latitude, longitude, per_person_cost, address, exterior_images) VALUES ('卡片店', '快餐', '好吃不贵', 23, 113, 18, '卡片路 1 号', ?)")
        .run(JSON.stringify(['/uploads/a.jpg'])).lastInsertRowid;
    const shareUrl = `https://dinnerparty.cc/p/${placeId}`;
    const mapUrl = `https://dinnerparty.cc/?place=${placeId}`;
    const content = cardContent(sql.prepare('SELECT * FROM Place WHERE id = ?').get(placeId));
    const thumbnailUrl = `https://dinnerparty.cc/p/${placeId}/${require('../../modules/places/services/placeCard').cardImageFile({ exterior_images: JSON.stringify(['/uploads/a.jpg']) })}`;
    assert.match(thumbnailUrl, /\/card-[0-9a-f]{8}\.jpg$/);
    assert.deepEqual([content.title, content.details, content.thumbnailUrl, content.shareUrl, content.mapUrl], ['卡片店 · 快餐', '人均 18 元｜好吃不贵｜地址：卡片路 1 号', thumbnailUrl, shareUrl, mapUrl]);
    const plain = cardContent({ id: 5, name: '无图店', exterior_images: '[]' });
    assert.equal(plain.thumbnailUrl, 'https://dinnerparty.cc/favicon.png', 'no photo: the site icon');
    // Packet answers as NapCat's send_packet returns them (hex of the OIDB response).
    const uv = (n) => {
        const o = [];
        let x = n;
        do {
            let b = x % 128;
            x = Math.floor(x / 128);
            if (x > 0)
                b |= 0x80;
            o.push(b);
        } while (x > 0);
        return o;
    };
    const v = (f, n) => [...uv(f * 8), ...uv(n)];
    const s = (f, t) => { const b = [...Buffer.from(t)]; return [...uv(f * 8 + 2), ...uv(b.length), ...b]; };
    const m = (f, x) => [...uv(f * 8 + 2), ...uv(x.length), ...x];
    const delivered = Buffer.from([...v(1, 0xdc2), ...v(2, 34), ...m(4, [])]).toString('hex');
    const rejected = Buffer.from([...v(1, 0xdc2), ...v(2, 34), ...m(4, m(1, [...v(1, 1), ...v(4, 901501), ...s(5, 'rule type not match appid')]))]).toString('hex');
    const cardClient = (answer) => {
        const client = new FakeBotClient();
        client.on('send_packet', answer);
        client.on('send_group_msg', () => ({ message_id: 1 }));
        client.on('send_private_msg', () => ({ message_id: 2 }));
        client.on('get_mini_app_ark', () => ({ data: { app: 'com.tencent.miniapp_01', meta: { detail_1: {} } } }));
        return client;
    };
    const send = (client, extra = {}) => sendPlaceCard({ client, isGroup: true, targetId: GROUP_A, placeId, config: botConfig.get(), ...extra });
    // 图文 card delivered: nothing else is sent.
    const ok = cardClient(() => delivered);
    assert.equal(await send(ok), 'tuwen');
    assert.deepEqual(ok.calls.map((c) => c.action), ['send_packet']);
    assert.equal(ok.calls[0].params.cmd, SSO_COMMAND);
    const request = decodeMessage(Buffer.from(ok.calls[0].params.data, 'hex'));
    assert.deepEqual([request[1][0], request[2][0]], [0xdc2, 34]);
    const body = decodeMessage(request[4][0]);
    const appInfo = decodeMessage(body[1][0]);
    const meta = decodeMessage(body[2][0]);
    const card = decodeMessage(appInfo[12][0]);
    assert.deepEqual([appInfo[1][0], appInfo[11][0], meta[1][0], meta[2][0]], [100446242, Number(GROUP_A), 1, Number(GROUP_A)]);
    assert.deepEqual([10, 11, 12, 13, 14].map((f) => card[f][0].toString()), ['卡片店 · 快餐', '人均 18 元｜好吃不贵｜地址：卡片路 1 号', '[分享] 卡片店 · 快餐', mapUrl, thumbnailUrl]);
    const privateCard = cardClient(() => delivered);
    await send(privateCard, { isGroup: false, targetId: '100001' });
    assert.deepEqual(decodeMessage(decodeMessage(decodeMessage(Buffer.from(privateCard.calls[0].params.data, 'hex'))[4][0])[2][0])[1], [0], 'private chats use peerType 0');
    // Rejected (e.g. 901501 on PC QQ) or failed: the share link instead.
    for (const answer of [() => rejected, () => { throw Object.assign(new Error('packet backend unavailable'), { code: 'failed' }); }, () => ({})]) {
        const client = cardClient(answer);
        assert.equal(await send(client), 'link');
        assert.deepEqual(client.calls.at(-1), { action: 'send_group_msg', params: { group_id: Number(GROUP_A), message: [{ type: 'text', data: { text: shareUrl } }] } });
    }
    // Sent but unanswered: never risk a second card.
    const unknown = cardClient(() => { throw Object.assign(new Error('timeout'), { code: 'timeout', outcomeUnknown: true }); });
    assert.equal(await send(unknown), 'unknown');
    assert.equal(unknown.calls.length, 1);
    // Other modes.
    const withMode = (mode) => ({ config: { ...botConfig.get(), card: { mode, miniappTemplate: 'bili' } } });
    const mini = cardClient(() => delivered);
    assert.equal(await send(mini, withMode('miniapp')), 'miniapp');
    assert.deepEqual(mini.calls.map((c) => c.action), ['get_mini_app_ark', 'send_group_msg']);
    assert.equal(mini.calls[1].params.message[0].type, 'json');
    const linkOnly = cardClient(() => delivered);
    assert.equal(await send(linkOnly, withMode('link')), 'link');
    assert.deepEqual(linkOnly.calls.map((c) => c.action), ['send_group_msg']);
    assert.equal(await send(linkOnly, withMode('off')), 'none');
    assert.equal(await send(linkOnly, { placeId: 99999999 }), 'none', 'a deleted place has no card');
}
async function testLocationRoute() {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const { getUserLocation } = require('../../modules/accounts/services/userLocation');
    const julia = user('茱莉亚', '100011');
    const app = express();
    app.use(express.json());
    app.use('/users', require('../../modules/accounts/routes/users'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const token = jwt.sign({ id: julia }, process.env.JWT_SECRET || 'yuyuko_secret_key');
        const put = async (body, auth = true) => (await fetch(`http://127.0.0.1:${server.address().port}/users/me/location`, {
            method: 'PUT', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body)
        })).status;
        assert.equal(await put({ lat: 23.1, lng: 113.3 }), 200);
        assert.deepEqual([getUserLocation(julia).lat, getUserLocation(julia).source], [23.1, 'web']);
        assert.equal(await put({ lat: 0, lng: 0 }), 400);
        assert.equal(await put({ lat: 'x', lng: 113 }), 400);
        assert.equal(await put({ lat: 95, lng: 113 }), 400);
        assert.equal(await put({ lat: 23, lng: 113 }, false), 401);
        sql.prepare('DELETE FROM User WHERE id = ?').run(julia);
        assert.equal(getUserLocation(julia), null, 'deleting the account deletes the position');
    }
    finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
async function main() {
    init();
    init();
    configure();
    testParser();
    await testPrivateFlowAndIdempotency();
    await testGroupIsolationAndVersions();
    await testPauseExpiryAndCancel();
    await testIdentityChecks();
    await testDuplicatesAndRollback();
    await testSearch();
    await testRandomAndLocation();
    await testGroupRandomCenter();
    await testCommandInterpreter();
    await testPlaceCards();
    await testMemberSync();
    await testNotificationWorker();
    await testOneBotClientAndBot();
    configure();
    await testWebRoute();
    await testLocationRoute();
    await testRandomCenterRoute();
    console.log('QQ bot tests passed: parser, private/group drafts, isolation, versions, pause/expiry, identity, duplicates, rollback, search, random picks, recorded positions, group random centres, DeepSeek commands, place cards, whitelist sync, notifications, OneBot client and dedupe.');
}
async function testRandomCenterRoute() {
    const express = require('express');
    const jwt = require('jsonwebtoken');
    const randomCenter = require('../../modules/qqbot/runtime/randomCenter');
    const admin = user('群中心管理员', '178010');
    sql.prepare("UPDATE User SET admin_level = 'YOUMU' WHERE id = ?").run(admin);
    const member = user('普通住民', '178011');
    const app = express();
    app.use(express.json());
    app.use('/admin/qq-bot', require('../../modules/accounts/middleware/auth').requireAuth, require('../../modules/admin/routes/adminQQBot'));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
        const tokenOf = (id) => jwt.sign({ id }, process.env.JWT_SECRET || 'yuyuko_secret_key');
        const call = async (method, path, body, id = admin) => {
            const res = await fetch(`http://127.0.0.1:${server.address().port}/admin/qq-bot${path}`, {
                method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenOf(id)}` }, ...(body ? { body: JSON.stringify(body) } : {})
            });
            return { status: res.status, body: await res.json() };
        };
        assert.equal((await call('GET', '/random-centers', null, member)).status, 403);
        assert.equal((await call('PUT', `/random-centers/${GROUP_B}`, { latitude: 23, longitude: 113, label: 'x' }, member)).status, 403);
        assert.equal((await call('PUT', '/random-centers/abc', { latitude: 23, longitude: 113, label: 'x' })).status, 400);
        assert.equal((await call('PUT', `/random-centers/${GROUP_B}`, { latitude: 0, longitude: 0, label: '零点' })).status, 400);
        assert.equal((await call('PUT', `/random-centers/${GROUP_B}`, { latitude: 23, longitude: 113, label: ' ' })).status, 400);
        const saved = await call('PUT', `/random-centers/${GROUP_B}`, { latitude: '23.1', longitude: 113.3, label: ' 大学城 ' });
        assert.equal(saved.status, 200);
        assert.deepEqual([saved.body.center.label, saved.body.center.lat, saved.body.center.source, saved.body.center.setBy], ['大学城', 23.1, 'admin', `admin:${admin}`]);
        const listed = await call('GET', '/random-centers');
        assert.equal(listed.body.defaultCenter.label, 'B记鱼粥');
        assert.ok(listed.body.centers.some((c) => c.groupId === GROUP_B && c.label === '大学城'));
        assert.equal(count('AdminAudit', "action = 'qq-bot-random-center'"), 1);
        assert.deepEqual((await call('DELETE', `/random-centers/${GROUP_B}`)).body, { cleared: true });
        assert.deepEqual((await call('DELETE', `/random-centers/${GROUP_B}`)).body, { cleared: false });
        assert.equal(randomCenter.getGroupCenter(GROUP_B), null);
        assert.equal(count('AdminAudit', "action = 'qq-bot-random-center-clear'"), 1, 'only a real clear is audited');
    }
    finally {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
}
main().then(() => {
    db.close();
    fs.rmSync(temp, { recursive: true, force: true });
    process.exitCode = 0;
}).catch((error) => {
    console.error(error);
    process.exit(1);
});

})().catch(error=>{console.error(error);process.exitCode=1;});
