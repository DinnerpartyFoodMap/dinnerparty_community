// 底栏小伙伴的状态：规则（companionBehavior.js）、状态机（companionDirector.js，假时钟 + 假演员）、
// 位移层（companionActor.js，假元素，只许调用 animate）和给别的角色补动作（sharedMotions.js）。
import assert from 'node:assert/strict';
import {
    BOX, CLIMB, NEEDS, SLEEP, SPEED, celebrationDue, climbRoute, companionNeeds, decideNext, isNight, jumpLanding,
    sleepDelay, standbyMotion, walkBand, walkSpeed, wanderTarget
} from '../../../src/companion/companionBehavior.js';
import { CompanionDirector, resetCompanionMemory } from '../../../src/companion/companionDirector.js';
import { CompanionActor, shadowFrame } from '../../../src/companion/companionActor.js';
import { MOTION, withSharedMotions } from '../../../src/companion/sharedMotions.js';

const HOUR = 3600e3;
const noon = new Date(2026, 10, 20, 12, 0, 0).getTime();
const sequence = (...values) => () => (values.length ? values.shift() : 0.5);

// ---------- 规则 ----------
assert.deepEqual(companionNeeds({ fedAt: null, adoptedAt: null, now: noon }), { fedAt: null, full: false, hungry: false }, '不知道领养时间时不算饿');
assert.equal(companionNeeds({ fedAt: new Date(noon - HOUR).toISOString(), now: noon }).full, true, '投喂后 3 小时内饱');
assert.equal(companionNeeds({ fedAt: new Date(noon - NEEDS.fullForMs).toISOString(), now: noon }).full, false);
assert.equal(companionNeeds({ fedAt: noon - 49 * HOUR, now: noon }).hungry, true, '48 小时没喂就饿');
assert.equal(companionNeeds({ fedAt: noon - 47 * HOUR, now: noon }).hungry, false);
assert.equal(companionNeeds({ adoptedAt: new Date(noon - 72 * HOUR).toISOString(), now: noon }).hungry, true, '从没喂过：从领养算');
assert.equal(companionNeeds({ adoptedAt: new Date(noon - HOUR).toISOString(), now: noon }).hungry, false, '刚领养不饿');
assert.equal(companionNeeds({ fedAt: noon - HOUR, adoptedAt: noon - 99 * HOUR, now: noon }).hungry, false, '喂过就按投喂算');
assert.equal(isNight(new Date(2026, 10, 20, 23, 30)), true);
assert.equal(isNight(new Date(2026, 10, 20, 6, 59)), true);
assert.equal(isNight(new Date(2026, 10, 20, 7, 0)), false);
assert.equal(sleepDelay({}), SLEEP.dayMs);
assert.equal(sleepDelay({ hungry: true }), SLEEP.hungryMs);
assert.equal(sleepDelay({ hungry: true, night: true }), SLEEP.nightMs, '夜里最快睡着');
assert.equal(celebrationDue({ needs: { fedAt: noon - 1000 }, celebrated: 0, now: noon }), true);
assert.equal(celebrationDue({ needs: { fedAt: noon - 1000 }, celebrated: noon - 1000, now: noon }), false, '同一次投喂只庆祝一次');
assert.equal(celebrationDue({ needs: { fedAt: noon - 4 * HOUR }, celebrated: 0, now: noon }), false, '太久以前的投喂不补');
assert.equal(walkSpeed({ hungry: true, full: false }), SPEED.hungry);
assert.equal(walkSpeed({ hungry: false, full: true }), SPEED.full);
assert.equal(standbyMotion({ hungry: true }, () => 0), MOTION.hungry);
assert.equal(standbyMotion({ full: true }, () => 0.2), MOTION.full);
assert.equal(standbyMotion({ full: true }, () => 0.8), MOTION.standby);

// 几何：手机宽 390，地面在视口 y=700，右侧按钮组 50 宽、底边离地 10、高 150（与 iOS 原生控件相同）
const column = { left: 328, right: 378, top: 540, bottom: 690 };
const phone = { left: 0, ground: 700, width: 390, column };
assert.deepEqual(walkBand(phone), { min: 8, max: 328 - BOX.width - 8 }, '不走到按钮底下');
assert.deepEqual(walkBand({ ...phone, column: null }), { min: 8, max: 390 - BOX.width - 8 });
const route = climbRoute(phone);
assert.deepEqual(route, { footX: 328 - BOX.width + 10, perchX: 353 - BOX.width / 2, topY: 160 }, '贴着按钮左侧爬，站到顶上中间');
assert.equal(climbRoute({ ...phone, column: null }), null);
assert.equal(climbRoute({ ...phone, column: { ...column, bottom: 600 } }), null, '按钮组离地太高不爬');
assert.equal(climbRoute({ ...phone, column: { ...column, top: 680 } }), null, '太矮不爬');
const band = walkBand(phone);
assert.equal(jumpLanding(route, band, () => 0), route.footX - 40, '往左跳出去');
assert.equal(jumpLanding({ ...route, footX: 20 }, band, () => 1), band.min, '落点不出地面范围');
for (const value of [0, 0.3, 0.7, 0.99]) {
    const to = wanderTarget(100, band, sequence(value, value, value));
    assert.ok(to >= band.min && to <= band.max && Math.abs(to - 100) >= 30, '目标在范围内、至少走 30 像素');
}
assert.equal(wanderTarget(band.max, band, sequence(0.5, 0.9)) < band.max, true, '在右边缘就往回走');
const normal = { hungry: false, full: false, fedAt: null };
assert.equal(decideNext({ last: 'wander', x: 100, band, route, needs: normal, now: noon, random: () => 0.1 }).type, 'standby', '走完先发呆');
assert.equal(decideNext({ last: 'standby', x: 100, band, route, needs: normal, now: noon, random: () => 0.1 }).type, 'climb', '发呆后按概率去爬');
assert.equal(decideNext({ last: 'standby', x: 100, band, route, needs: normal, now: noon, random: () => 0.5 }).type, 'wander');
assert.equal(decideNext({ last: 'standby', x: 100, band, route, needs: { ...normal, full: true }, now: noon, random: () => 0.5 }).type, 'climb', '吃饱更爱爬');
assert.equal(decideNext({ last: 'standby', x: 100, band, route, needs: { ...normal, hungry: true }, now: noon, random: () => 0.01 }).type, 'wander', '饿着不爬');
assert.equal(decideNext({ last: 'standby', x: 100, band, route, needs: normal, now: noon, lastClimbAt: noon - CLIMB.cooldownMs + 1, random: () => 0.01 }).type, 'wander', '刚爬过要隔一会儿');
assert.equal(decideNext({ last: 'standby', x: 10, band: { min: 8, max: 30 }, route: null, needs: normal, now: noon, random: () => 0.5 }).type, 'standby', '地方太窄不走');

// ---------- 状态机 ----------
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function fakeTime(start) {
    let now = start;
    let seq = 0;
    const pending = new Map();
    return {
        clock: () => now,
        timers: { set(fn, ms) { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; }, clear(id) { pending.delete(id); } },
        async advance(ms) {
            const end = now + ms;
            for (;;) {
                await flush();
                const next = [...pending.entries()].sort((a, b) => a[1].at - b[1].at)[0];
                if (!next || next[1].at > end) break;
                now = next[1].at;
                pending.delete(next[0]);
                next[1].fn();
            }
            now = end;
            await flush();
        }
    };
}

function fakeActor() {
    const calls = [];
    const pos = { x: 0, y: 0 };
    const done = () => Promise.resolve(true);
    return {
        calls,
        position: () => ({ ...pos }),
        place(x, y) { calls.push(['place', x, y]); Object.assign(pos, { x, y }); },
        stop() { calls.push(['stop']); },
        walk(to, speed) { calls.push(['walk', to, speed]); pos.x = to; return done(); },
        fly(x, y) { calls.push(['fly', x, y]); Object.assign(pos, { x, y }); return { touchdown: done(), settled: done() }; },
        arc(x, y, options) { calls.push(['arc', x, y, options.surface]); Object.assign(pos, { x, y }); return done(); },
        climb(y) { calls.push(['climb', y]); pos.y = y; return done(); },
        crouch() { calls.push(['crouch']); return done(); },
        squash() { calls.push(['squash']); return done(); },
        hop(height) { calls.push(['hop', height]); return done(); },
        hover(on) { calls.push(['hover', on]); },
        zzz(on) { calls.push(['zzz', on]); },
        heart() { calls.push(['heart']); },
        destroy() {}
    };
}

function fakeScene() {
    const calls = [];
    return { calls, loop: (group) => calls.push(['loop', group]), play: (group) => calls.push(['play', group]),
        face: (direction) => calls.push(['face', direction]), setMood: (name) => calls.push(['mood', name]) };
}

function storage() {
    const map = new Map();
    return { getItem: (key) => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)) };
}

function setup({ start = noon, random = () => 0.5, geometry = phone, inputs = {}, store = storage() } = {}) {
    resetCompanionMemory();
    const time = fakeTime(start);
    const actor = fakeActor();
    const scene = fakeScene();
    const box = { geometry };
    const director = new CompanionDirector({ actor, measure: () => box.geometry, clock: time.clock, random, storage: store, timers: time.timers });
    director.setScene(scene);
    director.update({ lift: 0, reduced: false, fedAt: new Date(start - 10 * HOUR).toISOString(), adoptedAt: new Date(start - 99 * HOUR).toISOString(), ...inputs });
    director.start();
    return { director, actor, scene, time, box, store };
}
const last = (calls, name) => calls.filter((call) => call[0] === name).at(-1);
const since = (calls, from) => calls.slice(from);

{
    // 首次出现：从上面掉到 30% 处，播 Drop、着地 Land；之后发呆、游走
    const { director, actor, scene, time } = setup();
    await flush();
    const home = Math.round(band.min + (band.max - band.min) * 0.3);
    assert.deepEqual(actor.calls.slice(0, 3), [['stop'], ['place', home, 90], ['fly', home, 0]]);
    assert.deepEqual(scene.calls.filter((call) => call[0] === 'play').map((call) => call[1]), [MOTION.drop, MOTION.land]);
    await time.advance(300);
    assert.equal(director.phase, 'standby');
    assert.deepEqual(last(scene.calls, 'loop'), ['loop', MOTION.standby]);
    await time.advance(4300);
    const walk = last(actor.calls, 'walk');
    assert.ok(walk && walk[2] === SPEED.normal && walk[1] !== home, '发呆后游走');
    assert.deepEqual(last(scene.calls, 'face'), ['face', Math.sign(walk[1] - home)], '朝走的方向');
    assert.ok(scene.calls.some((call) => call[1] === MOTION.wander));

    // 上拉更多功能：停下飞上去，抬头；收起后掉回来
    const before = actor.calls.length;
    director.update({ lift: 300, reduced: false, fedAt: director.inputs.fedAt, adoptedAt: director.inputs.adoptedAt });
    await flush();
    assert.deepEqual(since(actor.calls, before).slice(0, 2), [['stop'], ['fly', walk[1], 300]]);
    assert.deepEqual(last(scene.calls, 'mood'), ['mood', 'aloft']);
    assert.equal(director.phase, 'aloft');
    director.update({ lift: 0, reduced: false, fedAt: director.inputs.fedAt, adoptedAt: director.inputs.adoptedAt });
    await flush();
    assert.deepEqual(last(actor.calls, 'fly'), ['fly', walk[1], 0], '落回原位');
    assert.deepEqual(last(scene.calls, 'mood'), ['mood', null]);
    assert.ok(since(scene.calls, 0).some((call) => call[0] === 'play' && call[1] === MOTION.land));

    // 很久没操作就睡，有操作就醒
    await time.advance(SLEEP.dayMs + 1000);
    assert.equal(director.phase, 'sleep');
    assert.deepEqual(last(scene.calls, 'loop'), ['loop', MOTION.sleep]);
    assert.deepEqual(last(actor.calls, 'zzz'), ['zzz', true]);
    director.noteActivity();
    await flush();
    assert.deepEqual(last(actor.calls, 'zzz'), ['zzz', false]);
    assert.deepEqual(last(scene.calls, 'play'), ['play', MOTION.wake]);
    await time.advance(1000);
    assert.notEqual(director.phase, 'sleep');
    director.destroy();
}

{
    // 爬按钮：走到按钮左侧、往上爬、翻上顶，待一会儿再跳下来
    const { director, actor, scene, time, box } = setup({ random: () => 0.1 });
    await time.advance(300 + 2500 + 3500 * 0.1);
    assert.deepEqual(last(actor.calls, 'walk'), ['walk', route.footX, SPEED.normal]);
    assert.deepEqual(last(actor.calls, 'climb'), ['climb', route.topY - CLIMB.reach]);
    assert.deepEqual(last(actor.calls, 'arc'), ['arc', route.perchX, route.topY, route.topY]);
    assert.ok(scene.calls.some((call) => call[1] === MOTION.climb));
    assert.equal(director.state.surface, 'column');
    assert.equal(director.phase, 'perch');
    const perchMs = CLIMB.perchMs[0] + (CLIMB.perchMs[1] - CLIMB.perchMs[0]) * 0.1;
    await time.advance(perchMs + 10);
    assert.deepEqual(last(scene.calls, 'face'), ['face', -1]);
    assert.ok(scene.calls.some((call) => call[0] === 'play' && call[1] === MOTION.jumpOff));
    assert.deepEqual(last(actor.calls, 'arc'), ['arc', jumpLanding(route, band, () => 0.1), 0, 0], '跳回地面');
    assert.equal(director.state.surface, 'ground');

    // 再爬上去后按钮没了（搜索、隐藏）：掉下来
    director.state.lastClimbAt = -Infinity;
    // 着地的 Land（0.55 秒）+ 发呆（2.85 秒）后再去爬，在顶上待 13.6 秒
    await time.advance(4000);
    assert.equal(director.state.surface, 'column');
    box.geometry = { ...phone, column: null };
    director.geometryChanged();
    await flush();
    assert.deepEqual(last(actor.calls, 'fly'), ['fly', route.perchX, 0]);
    assert.equal(director.state.surface, 'ground');
    director.destroy();
}

{
    // 饿了：耷拉着发呆、走得慢、不爬
    const { director, actor, scene, time } = setup({ random: () => 0.1, inputs: { fedAt: new Date(noon - 72 * HOUR).toISOString() } });
    await time.advance(300);
    assert.deepEqual(last(scene.calls, 'loop'), ['loop', MOTION.hungry]);
    await time.advance(9000);
    assert.equal(last(actor.calls, 'walk')[2], SPEED.hungry);
    assert.equal(actor.calls.some((call) => call[0] === 'climb'), false);
    director.destroy();
}

{
    // 刚投喂：点头、爱心、蹦两下、晃着笑；同一次投喂只庆祝一次
    const store = storage();
    const { director, actor, scene, time } = setup({ store });
    await time.advance(300);
    director.update({ lift: 0, reduced: false, fedAt: new Date(noon + 200).toISOString(), adoptedAt: director.inputs.adoptedAt });
    await time.advance(2000);
    assert.ok(scene.calls.some((call) => call[0] === 'play' && call[1] === MOTION.feed));
    assert.ok(actor.calls.some((call) => call[0] === 'heart'));
    assert.deepEqual(actor.calls.filter((call) => call[0] === 'hop').map((call) => call[1]), [14, 10]);
    assert.deepEqual(last(scene.calls, 'loop'), ['loop', MOTION.full]);
    director.destroy();
    const again = setup({ store, inputs: { fedAt: new Date(noon + 200).toISOString() } });
    await again.time.advance(6000);
    assert.equal(again.actor.calls.some((call) => call[0] === 'heart'), false);
    again.director.destroy();
}

{
    // 夜里 30 秒没操作就睡
    const night = new Date(2026, 10, 20, 23, 30).getTime();
    const { director, time } = setup({ start: night });
    await time.advance(SLEEP.nightMs + 1000);
    assert.equal(director.phase, 'sleep');
    director.destroy();
}

{
    // 减弱动态效果：只停在原位，不走不睡
    const { director, actor, time } = setup({ inputs: { reduced: true } });
    await time.advance(SLEEP.dayMs * 2);
    assert.equal(director.phase, 'still');
    assert.equal(actor.calls.some((call) => ['walk', 'climb', 'zzz'].includes(call[0])), false);
    director.destroy();
}

// ---------- 位移层：只用 animate，不写 style ----------
{
    const log = [];
    const computed = new Map();
    globalThis.getComputedStyle = (element) => ({ transform: computed.get(element) || 'none' });
    const element = (name) => ({
        name,
        animate(keyframes, options) {
            let reject;
            const finished = new Promise((resolve, fail) => { reject = fail; queueMicrotask(resolve); });
            // 与浏览器一致：取消时 finished 被拒绝，但标记为已处理（不算未处理的拒绝）
            finished.catch(() => {});
            const animation = { keyframes, options, finished, cancel: () => reject(new Error('cancelled')) };
            log.push([name, animation]);
            return animation;
        },
        get style() { throw new Error(`${name}: 不应写 style`); },
        set className(value) { throw new Error(`${name}: 不应改 class`); }
    });
    const layers = Object.fromEntries(['x', 'fly', 'body', 'bob', 'shadow', 'heart'].map((name) => [name, element(name)]));
    layers.zzz = [element('z0'), element('z1'), element('z2')];
    const actor = new CompanionActor(layers);
    const of = (name) => log.filter((entry) => entry[0] === name).map((entry) => entry[1]);

    computed.set(layers.x, 'matrix(1, 0, 0, 1, 30, 0)');
    assert.equal(await actor.walk(82, 26), true);
    const walk = of('x').at(-1);
    assert.deepEqual(walk.keyframes, [{ transform: 'translateX(30px)' }, { transform: 'translateX(82px)' }]);
    assert.equal(walk.options.duration, 2000, '按速度算时长');
    assert.equal(walk.options.easing, 'linear');
    assert.equal(of('bob').at(-1).options.iterations, Infinity, '走路一颠一颠');

    computed.set(layers.fly, 'matrix(1, 0, 0, 1, 0, -20)');
    actor.climb(80, { step: 13, stepMs: 350 });
    const climb = of('fly').at(-1);
    const offsets = climb.keyframes.map((frame) => frame.offset).filter((offset) => offset !== undefined);
    assert.ok(offsets.every((offset, index) => index === 0 || offset > offsets[index - 1]), '关键帧时间递增');
    assert.equal(climb.keyframes.at(-1).transform, 'translateY(-80px)');
    assert.equal(climb.options.duration, Math.ceil(60 / 13) * 350);

    actor.arc(10, 0, { peak: 22, upMs: 230, downMs: 500, surface: 0 });
    const jump = of('fly').at(-1);
    assert.deepEqual(jump.keyframes.map((frame) => frame.transform), ['translateY(-20px)', 'translateY(-42px)', 'translateY(0px)'], '先跳高再落下');
    assert.equal(jump.keyframes[1].offset, 230 / 730);

    const { touchdown, settled } = actor.fly(10, 200);
    assert.ok(touchdown instanceof Promise && settled instanceof Promise);
    assert.equal(of('bob').at(-1).options.iterations, Infinity, '空中悬停浮动');
    actor.zzz(true);
    assert.equal(log.filter((entry) => entry[0].startsWith('z')).length, 3);
    actor.heart();
    actor.stop();
    assert.deepEqual(shadowFrame(160, 0).transform, 'translateY(-160px) scale(1.000)', '站在按钮上时影子在按钮顶上');
    actor.destroy();
}

// ---------- 给别的角色补动作 ----------
const shared = Object.fromEntries(Object.values(MOTION).map((group) => [group, [{ File: `stick-figure.${group.toLowerCase()}.motion3.json` }]]));
{
    const manifest = { Version: 3, FileReferences: { Moc: 'a.moc3', Motions: { Idle: [{ File: 'own/idle.motion3.json' }], Sleep: [{ File: 'own/sleep.motion3.json' }] } } };
    const { manifest: patched, added } = withSharedMotions(manifest, shared, (file) => `companion-shared/${file}`);
    assert.deepEqual(patched.FileReferences.Motions.Standby, manifest.FileReferences.Motions.Idle, '角色有 Idle 时 Standby 用它');
    assert.deepEqual(patched.FileReferences.Motions.Sleep, manifest.FileReferences.Motions.Sleep, '角色自己有的组不替换');
    assert.deepEqual(patched.FileReferences.Motions.Wander, [{ File: 'companion-shared/stick-figure.wander.motion3.json' }]);
    assert.equal(added.some((item) => item.group === MOTION.standby || item.group === MOTION.sleep), false);
    assert.equal(added.length, Object.keys(MOTION).length - 2);
    assert.equal(manifest.FileReferences.Motions.Wander, undefined, '原清单不变');
    assert.equal(patched.FileReferences.Moc, 'a.moc3');
}
{
    // 角色动作都在一个无名组里（常见的导出方式）：全部补上
    const { added } = withSharedMotions({ FileReferences: { Motions: { '': [{ File: 'm/1.motion3.json' }] } } }, shared, (file) => file);
    assert.equal(added.length, Object.keys(MOTION).length);
}

console.log('companion behaviour ok');
