import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createNativeFeedbackSession, pickSubmission, MAX_NATIVE_IMAGE_BASE64 } from "../../../src/platform/nativeFeedback.js";
import { FEEDBACK_LIMITS, FEEDBACK_TYPE_VALUES, normalizeFeedbackPrefill } from "../../../src/feedback/feedbackTypes.js";

// 反馈类型取值前后端一致（后端按白名单拒绝未知类型）
const backendService = readFileSync(new URL('../../../../backend/modules/feedback/services/feedbackService.js', import.meta.url), 'utf8');
const backendTypes = JSON.parse(backendService.match(/FEEDBACK_TYPES = Object\.freeze\((\[[^\]]*\])\)/)[1].replace(/'/g, '"'));
assert.deepEqual([...FEEDBACK_TYPE_VALUES], backendTypes);

// 预填（地点举报）：类型须在白名单里，内容截到上限；菜单入口不带参数，点击事件之类的值按普通反馈打开
assert.deepEqual(normalizeFeedbackPrefill({ type: 'report', content: '举报地点：B记鱼粥', extra: 1 }), { type: 'report', content: '举报地点：B记鱼粥' });
assert.equal(normalizeFeedbackPrefill({ type: 'report', content: 'x'.repeat(5000) }).content.length, FEEDBACK_LIMITS.contentLength);
assert.deepEqual(normalizeFeedbackPrefill({ type: 'report' }), { type: 'report', content: '' });
for (const bad of [undefined, null, 'report', { type: 'spam', content: '类型不对' }, { nativeEvent: {}, type: 'click' }]) {
    assert.equal(normalizeFeedbackPrefill(bad), null, JSON.stringify(bad));
}

const types = ['bug', 'suggestion', 'other'];
const limits = { contentLength: 20, images: 2 };

// 白名单：类型须在下发的类型里，内容去空白并截到上限，图片张数与大小有上限
assert.deepEqual(pickSubmission({ type: 'bug', content: '  点不开  ', images: ['aGk='], extra: 1 }, { types, limits }), { type: 'bug', content: '点不开', images: ['aGk='] });
assert.equal(pickSubmission({ type: 'bug', content: 'x'.repeat(50) }, { types, limits }).content.length, 20);
assert.deepEqual(pickSubmission({ type: 'other', content: '无图' }, { types, limits }).images, []);
for (const bad of [null, 'text', { type: 'spam', content: '类型不对' }, { type: 'bug', content: '   ' }, { type: 'bug' },
    { type: 'bug', content: '太多图', images: ['a', 'b', 'c'] }, { type: 'bug', content: '非字符串', images: [42] },
    { type: 'bug', content: '空图', images: [''] }, { type: 'bug', content: '太大', images: ['x'.repeat(MAX_NATIVE_IMAGE_BASE64 + 1)] }]) {
    assert.equal(pickSubmission(bad, { types, limits }), null, JSON.stringify(bad)?.slice(0, 60));
}

function harness(open, onSubmit = async () => ({ ok: true })) {
    const finished = [], errors = [], closed = [], snapshots = [], responses = [], submitted = [];
    let emit = null, removed = 0;
    const plugin = {
        addListener: async (name, handler) => { assert.equal(name, 'feedbackEvent'); emit = handler; return { remove: () => { removed += 1; } }; },
        open: async snapshot => { snapshots.push(snapshot); return open(snapshot); },
        close: async ({ id }) => { closed.push(id); },
        respond: async payload => { responses.push(payload); }
    };
    const session = createNativeFeedbackSession(plugin, { dark: true, labels: { title: '意见反馈' } }, {
        types, limits, retryDelay: 0,
        onSubmit: async values => { submitted.push(values); return onSubmit(values); },
        onFinish: action => finished.push(action),
        onError: error => errors.push(error)
    });
    // 监听回调不返回 Promise：每个事件发出后让异步处理跑完再继续
    const settle = () => new Promise(resolve => setTimeout(resolve, 5));
    return { session, finished, errors, closed, snapshots, responses, submitted, emit: async event => { emit(event); await settle(); }, removed: () => removed };
}

for (const action of ['submitted', 'cancel']) {
    const h = harness(({ id }) => ({ id, action }));
    await h.session.start();
    assert.deepEqual(h.finished, [action]);
    assert.equal(h.snapshots[0].labels.title, '意见反馈');
    assert.equal(h.errors.length, 0);
    assert.equal(h.removed(), 1, '呈现结束后移除监听');
}
// 只接受本次呈现的结束动作；异常结束让调用方改用网页面板
for (const response of [{ id: 'old', action: 'submitted' }, { action: 'eval' }, { action: 'back' }]) {
    const h = harness(({ id }) => ({ id, ...response }));
    await h.session.start();
    assert.equal(h.finished.length, 0);
    assert.equal(h.errors.length, 1);
}
// 抽屉还在退场时重试，持续占用有上限
{
    let calls = 0;
    const h = harness(({ id }) => {
        if (++calls < 3) throw Object.assign(new Error('transition'), { code: 'BUSY' });
        return { id, action: 'cancel' };
    });
    await h.session.start();
    assert.equal(calls, 3);
    assert.equal(new Set(h.snapshots.map(s => s.id)).size, 1);
    const busy = harness(() => { throw Object.assign(new Error('busy'), { code: 'BUSY' }); });
    await busy.session.start();
    assert.equal(busy.snapshots.length, 16);
    assert.equal(busy.errors.length, 1);
}
// 提交事件：只处理本次呈现的 submit，结果按 requestId 回传；不合法的输入不发请求，直接回失败
{
    let finishOpen;
    const h = harness(({ id }) => new Promise(resolve => { finishOpen = () => resolve({ id, action: 'submitted' }); }),
        async values => (values.content === '失败' ? { ok: false, message: '24 小时内最多提交 10 条反馈' } : { ok: true, message: '已提交' }));
    const started = h.session.start();
    while (!finishOpen) await new Promise(resolve => setTimeout(resolve, 1));
    const id = h.snapshots[0].id;
    await h.emit({ id: 'feedback-old', type: 'submit', requestId: 'r0', values: { type: 'bug', content: '旧页面' } });
    await h.emit({ id, type: 'eval', requestId: 'r0', values: { type: 'bug', content: '未知事件' } });
    await h.emit({ id, type: 'submit', values: { type: 'bug', content: '缺 requestId' } });
    assert.equal(h.responses.length, 0);
    await h.emit({ id, type: 'submit', requestId: 'r1', values: { type: 'bug', content: '点不开', images: ['aGk='] } });
    await h.emit({ id, type: 'submit', requestId: 'r2', values: { type: 'spam', content: '类型不对' } });
    await h.emit({ id, type: 'submit', requestId: 'r3', values: { type: 'other', content: '失败' } });
    assert.deepEqual(h.submitted.map(v => v.content), ['点不开', '失败']);
    assert.deepEqual(h.responses.map(({ requestId, ok }) => [requestId, ok]), [['r1', true], ['r2', false], ['r3', false]]);
    assert.equal(h.responses[2].message, '24 小时内最多提交 10 条反馈');
    assert.ok(h.responses.every(r => r.id === id));
    finishOpen();
    await started;
    assert.deepEqual(h.finished, ['submitted']);
}
// 关闭后迟到的结束动作与提交都不再处理
{
    let resolveOpen;
    const h = harness(() => new Promise(resolve => { resolveOpen = resolve; }));
    const pending = h.session.start();
    while (!resolveOpen) await new Promise(resolve => setTimeout(resolve, 1));
    await h.session.stop();
    await h.emit({ id: h.snapshots[0].id, type: 'submit', requestId: 'late', values: { type: 'bug', content: '迟到' } });
    resolveOpen({ id: h.snapshots[0].id, action: 'submitted' });
    await pending;
    assert.deepEqual(h.closed, [h.snapshots[0].id]);
    assert.equal(h.submitted.length, 0);
    assert.equal(h.finished.length, 0);
    assert.equal(h.errors.length, 0);
}
console.log('Native feedback bridge tests passed.');
