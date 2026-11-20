// iOS 原生评价 / 打卡玻璃面板（协议 v19）的快照与行 id：npm run test:rating
// 快照由 ratingChromeSheet / checkInChromeSheet 生成，再经 sanitizeSheet 清洗后下发；这里核对内容、语气与回传行 id 的解析。
import assert from 'node:assert/strict';

const { ratingChromeSheet, ratingSheetAction, ratingTierTone } = await import('../../../src/places/ratingChromeSheet.js');
const { checkInChromeSheet, checkInSheetAction } = await import('../../../src/places/checkInChromeSheet.js');
const { chooseRating, withdrawRating } = await import('../../../src/places/ratingActions.js');
const { sanitizeSheet } = await import('../../../src/platform/nativeMapChrome.js');
const { RATING_TIERS } = await import('../../../src/places/rating.js');

const place = { id: 7, name: '老码头火锅', category: '火锅', rating_count: 0 };
const section = (sheet, id) => sheet.sections.find((item) => item.id === id);

// ---- 评价：有评价、有分布、有预测、自己评过 ----
{
    const rating = {
        loading: false, error: '', saving: false,
        data: {
            summary: { count: 4, average: 3.25, distribution: { 4: 2, 3: 1, 2: 1, 1: 0 } },
            mine: { score: 3 },
            quota: { remaining: 5, limit: 10, place_counted: false },
            prediction: null
        }
    };
    const sheet = sanitizeSheet(ratingChromeSheet({ place, rating, isAuthenticated: true, banned: false, iconFor: (slot) => ({ image: `data:image/png;base64,${slot.length}` }) }));
    assert.equal(sheet.id, 'rating');
    assert.equal(sheet.subtitle, '老码头火锅');
    assert.equal(sheet.message, undefined);
    const summary = section(sheet, 'summary');
    assert.equal(summary.style, 'stat');
    assert.equal(summary.rows[0].subtitle, '3.3', '档位与分数（四舍五入一位）');
    assert.equal(summary.rows[0].tone, 'accent', '均线之上用主题色');
    assert.ok(summary.footer.includes('4'), '人数在脚注');
    const bars = section(sheet, 'distribution');
    assert.equal(bars.style, 'bars');
    assert.deepEqual(bars.rows.map((row) => [row.id, row.badge, row.value]), [['bar:4', '2', 1], ['bar:3', '1', 0.5], ['bar:2', '1', 0.5], ['bar:1', '0', 0]]);
    assert.deepEqual(bars.rows.map((row) => row.tone), ['success', 'accent', 'warning', 'danger']);
    const mine = section(sheet, 'mine');
    assert.equal(mine.style, 'grid');
    assert.deepEqual(mine.rows.map((row) => row.id), ['rate:4', 'rate:3', 'rate:2', 'rate:1']);
    assert.deepEqual(mine.rows.map((row) => !!row.selected), [false, true, false, false], '自己的评价是选中格');
    assert.ok(mine.rows.every((row) => row.keepsOpen && !row.disabled && row.image), '评价表情可带皮肤图标');
    assert.ok(mine.footer.includes('5'), '今日剩余次数');
    assert.equal(section(sheet, 'personal'), undefined, '自己评过就不显示预测');
    assert.deepEqual(sheet.actions.map((row) => row.id), ['withdraw']);
    assert.equal(ratingTierTone(RATING_TIERS[0]), 'success');
}

// ---- 评价：未登录、没人评价、加载失败、配额用完、保存失败的提示 ----
{
    const guest = sanitizeSheet(ratingChromeSheet({ place, rating: { data: null, loading: false, error: '' }, isAuthenticated: false, banned: false }));
    assert.equal(section(guest, 'summary').rows[0].subtitle, undefined, '没人评价时只有一句提示');
    assert.equal(section(guest, 'distribution'), undefined);
    assert.deepEqual(guest.actions.map((row) => row.id), ['login']);
    assert.ok(section(guest, 'mine').rows.every((row) => !row.disabled), '未登录时点格子去登录');

    const loading = sanitizeSheet(ratingChromeSheet({ place, rating: { data: null, loading: true, error: '' }, isAuthenticated: true, banned: false }));
    assert.equal(loading.messageTone, 'loading');
    const failed = sanitizeSheet(ratingChromeSheet({ place, rating: { data: null, loading: false, error: '网络错误' }, isAuthenticated: true, banned: false }));
    assert.equal(failed.messageTone, 'danger');
    assert.ok(failed.message.includes('网络错误'));
    assert.deepEqual(failed.actions.map((row) => row.id), ['retry']);

    const exhausted = sanitizeSheet(ratingChromeSheet({ place, rating: { saving: false, data: {
        summary: { count: 1, average: 4 }, mine: { score: 4 }, quota: { remaining: 0, limit: 10, place_counted: false }
    } }, isAuthenticated: true, banned: false, notice: '评价失败：太快了' }));
    assert.deepEqual(section(exhausted, 'mine').rows.map((row) => row.disabled), [false, true, true, true], '配额用完只能保留自己的选择');
    assert.equal(exhausted.message, '评价失败：太快了');
    assert.equal(exhausted.messageTone, 'danger');

    const banned = sanitizeSheet(ratingChromeSheet({ place, rating: { data: { summary: { count: 0 }, mine: { score: 2 } } }, isAuthenticated: true, banned: true }));
    assert.ok(section(banned, 'mine').rows.every((row) => row.disabled));
    assert.deepEqual(banned.actions, [], '受限时不能撤回');
}

// ---- 评价：预计你会给（数字强调）、低分风险 ----
{
    const sheet = sanitizeSheet(ratingChromeSheet({ place, rating: { data: {
        summary: { count: 3, average: 2.4 },
        prediction: { active: true, status: 'ready', average: 3.6 },
        risk: { active: true, status: 'ready', flagged: true }
    } }, isAuthenticated: true, banned: false }));
    const personal = section(sheet, 'personal');
    assert.equal(personal.style, 'note');
    assert.equal(personal.rows[0].subtitle, '3.6');
    assert.equal(personal.rows[0].subtitleEmphasis, '3.6');
    const risk = section(sheet, 'risk');
    assert.equal(risk.style, 'note');
    assert.equal(risk.rows[0].tone, 'warning');
}

assert.deepEqual(ratingSheetAction('rate:3'), { type: 'rate', score: 3 });
assert.deepEqual(ratingSheetAction('withdraw'), { type: 'withdraw' });
for (const bad of ['rate:5', 'rate:', 'bar:3', 'evil', null]) assert.equal(ratingSheetAction(bad), null, String(bad));

// ---- 评价操作：未登录去登录；成功 / 失败分别通知；429 重新读取 ----
{
    const notes = [];
    let loginAsked = 0;
    let reloaded = 0;
    const rating = { saving: false, submit: async () => ({}), withdraw: async () => ({}), reload: () => { reloaded += 1; } };
    await chooseRating(rating, 4, { isAuthenticated: false, onRequireAuth: () => { loginAsked += 1; }, notify: (...args) => notes.push(args) });
    assert.equal(loginAsked, 1);
    await chooseRating(rating, 4, { isAuthenticated: true, notify: (...args) => notes.push(args) });
    assert.equal(notes.at(-1)[1], 'success');
    rating.submit = async () => { throw Object.assign(new Error('slow down'), { status: 429 }); };
    await chooseRating(rating, 2, { isAuthenticated: true, notify: (...args) => notes.push(args) });
    assert.equal(notes.at(-1)[1], 'danger');
    assert.ok(notes.at(-1)[0].includes('slow down'));
    assert.equal(reloaded, 1);
    await chooseRating({ ...rating, saving: true, submit: () => assert.fail('保存中不重复提交') }, 2, { isAuthenticated: true });
    await chooseRating({ ...rating, submit: () => assert.fail('受限不提交') }, 2, { isAuthenticated: true, banned: true });
    rating.withdraw = async () => { throw Object.assign(new Error('已撤回'), { committed: true }); };
    await withdrawRating(rating, { notify: (...args) => notes.push(args) });
    assert.deepEqual(notes.at(-1), ['已撤回', 'danger'], '已提交的失败原样显示');
}

// ---- 打卡：表单、提交中锁定、成功回执 ----
{
    const base = { description: '锅底不错', score: null, photos: [], pending: '', error: '', receipt: null, retryRating: false };
    const form = sanitizeSheet(checkInChromeSheet({ place, checkIn: base }));
    assert.equal(form.id, 'checkIn');
    assert.equal(form.locked, undefined);
    const input = section(form, 'description');
    assert.equal(input.style, 'input');
    assert.deepEqual(input.field, { id: 'description', value: '锅底不错', placeholder: undefined, maxLength: 1000, disabled: false });
    assert.equal(section(form, 'score').style, 'chips');
    assert.ok(section(form, 'score').rows.every((row) => !row.tone));
    assert.deepEqual(section(form, 'photos').rows.map((row) => row.id), ['photos:add']);
    assert.deepEqual(form.actions.map((row) => [row.id, row.tone, row.disabled]), [['submit', 'accent', false]]);

    const photo = { id: 3, file: { name: 'a.jpg' }, thumbnail: 'data:image/jpeg;base64,/9j/' };
    const busy = sanitizeSheet(checkInChromeSheet({ place, checkIn: { ...base, score: 4, pending: 'submit', photos: [photo, { id: 4, file: { name: 'b.jpg' }, thumbnail: null }, { id: 5, file: { name: 'c.jpg' } }] } }));
    assert.equal(busy.locked, true, '提交中不能关闭');
    assert.equal(section(busy, 'description').field.disabled, true);
    assert.equal(section(busy, 'score').rows[0].tone, 'accent', '选中的评分');
    const photos = section(busy, 'photos').rows;
    assert.deepEqual(photos.map((row) => row.id), ['photo:3', 'photo:4', 'photo:5'], '满 3 张后没有添加按钮');
    assert.equal(photos[0].image, photo.thumbnail);
    assert.equal('image' in photos[1], false, '没有缩略图时用图标');
    assert.ok(photos.every((row) => row.badge === 'remove' && row.disabled));
    assert.equal(JSON.stringify(busy).includes('a.jpg'), false, '原生不拿文件名');
    assert.equal(busy.actions[0].disabled, true);

    const done = sanitizeSheet(checkInChromeSheet({ place, checkIn: { ...base, receipt: { id: 'c1', reviews: { photos: 1 } } } }));
    assert.equal(done.messageTone, 'success');
    assert.deepEqual(done.sections.map((item) => item.id), ['review']);
    assert.deepEqual(done.actions.map((row) => [row.id, !!row.keepsOpen]), [['done', false]]);
    const retry = sanitizeSheet(checkInChromeSheet({ place, checkIn: { ...base, score: 3, receipt: { id: 'c1' }, retryRating: true, error: '评分没有保存' } }));
    assert.equal(retry.actions[0].id, 'submit');
    assert.equal(retry.messageTone, 'danger');
}

assert.deepEqual(checkInSheetAction('score:2'), { type: 'score', score: 2 });
assert.deepEqual(checkInSheetAction('photo:12'), { type: 'removePhoto', id: 12 });
assert.deepEqual(checkInSheetAction('photos:add'), { type: 'addPhotos' });
assert.deepEqual(checkInSheetAction('submit'), { type: 'submit' });
for (const bad of ['score:9', 'photo:x', 'description', null]) assert.equal(checkInSheetAction(bad), null, String(bad));

console.log('native place sheets ok');
