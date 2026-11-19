// 底栏小伙伴飞行（src/companion/companionFlight.js）：起飞高度、动画计划与四层元素的控制。
import assert from 'node:assert/strict';
import { CompanionFlight, DRAWER_OVERSHOOT, PERCH_GAP, companionLift, flightPlan } from '../../../src/companion/companionFlight.js';

// 起飞高度：更多功能优先于搜索
assert.equal(companionLift({}), 0, '平常站在工具栏上');
assert.equal(companionLift({ drawer: { open: false, dragging: false, height: 300 } }), 0);
assert.equal(companionLift({ drawer: { open: false, dragging: true, height: 300 } }), 300 + DRAWER_OVERSHOOT, '从收起开始拖：飞到最多可能被拉到的高度之上');
assert.equal(companionLift({ drawer: { open: true, dragging: false, height: 300 } }), 300, '展开后停在工具栏上沿');
assert.equal(companionLift({ drawer: { open: true, dragging: true, height: 300 } }), 300, '从展开往下拖：原地等着');
assert.equal(companionLift({ drawer: { open: true, dragging: false, height: 0 } }), 0, '还没量到高度');
assert.equal(companionLift({ searchPerch: 0 }), 0, '还没量到结果框时站在搜索输入框上');
assert.equal(companionLift({ searchPerch: 12 }), 12 + PERCH_GAP, '结果框离输入框很近时也跟随实际高度');
assert.equal(companionLift({ searchPerch: 180.4 }), 180 + PERCH_GAP, '停在结果列表上方');
assert.equal(companionLift({ searchPerch: null }), 0, '不在搜索');
assert.equal(companionLift({ drawer: { open: true, height: 250 }, searchPerch: 120 }), 250);

// 动画计划
assert.equal(flightPlan(0, 0).kind, 'none');
assert.equal(flightPlan(120, 120.3).kind, 'none');
const takeoff = flightPlan(0, 300);
assert.equal(takeoff.kind, 'takeoff');
assert.deepEqual(takeoff.fly.keyframes, [{ transform: 'translateY(0px)' }, { transform: 'translateY(-300px)' }]);
assert.equal(takeoff.fly.options.fill, 'forwards', '停在空中');
assert.ok(takeoff.body, '起飞时身体拉长');
assert.ok(takeoff.settle >= 340 && takeoff.settle <= 560);
const land = flightPlan(300, 0);
assert.equal(land.kind, 'land');
assert.equal(land.body.options.delay, land.fly.options.duration, '着地时才压扁');
assert.equal(land.settle, land.fly.options.duration + land.body.options.duration, '压扁弹回后才算站稳');
assert.ok(flightPlan(10, 0).fly.options.duration >= 300 && flightPlan(2000, 0).fly.options.duration <= 600, '落地时长有上下限');
assert.equal(flightPlan(300, 340).kind, 'shift');
assert.equal(flightPlan(300, 340).body, undefined, '空中换高度不压扁');
const reduced = flightPlan(0, 300, { reduced: true });
assert.equal(reduced.fly.keyframes[1].opacity, 0, '减弱动态效果：先淡出');
assert.equal(reduced.body, undefined);
const instant = flightPlan(0, 300, { instant: true });
assert.equal(instant.fly.options.duration, 0, '刚挂载时已在空中：直接到位');
assert.equal(instant.settle, 0);
assert.ok(Number(flightPlan(0, 300).shadow.keyframes[1].opacity) < 1, '飞起来影子变淡');

// 控制器：用假的元素记录 animate / 暂停行走
function fakeAnimation(log, layer) {
    return { layer, cancelled: false, cancel() { this.cancelled = true; log.push(`${layer}:cancel`); } };
}
function fakeLayer(log, name, { lift = () => 0 } = {}) {
    return {
        animations: [],
        animate(keyframes, options) {
            log.push(`${name}:animate`);
            const animation = { ...fakeAnimation(log, name), keyframes, options };
            this.animations.push(animation);
            return animation;
        },
        lift
    };
}
let current = 0;
globalThis.getComputedStyle = (element) => ({ transform: element.name === 'fly' && current ? `matrix(1, 0, 0, 1, 0, ${-current})` : 'none' });
const log = [];
const walk = { animationName: 'fm-companion-walk', state: 'running', pause() { this.state = 'paused'; }, play() { this.state = 'running'; } };
const roam = { getAnimations: () => [walk, { animationName: 'other', pause() { throw new Error('只控制行走'); }, play() {} }] };
const layers = { roam, fly: { ...fakeLayer(log, 'fly'), name: 'fly' }, body: fakeLayer(log, 'body'), bob: fakeLayer(log, 'bob'), shadow: fakeLayer(log, 'shadow') };
const aloft = [];
const flight = new CompanionFlight({ ...layers, onAloftChange: (value) => aloft.push(value) });

assert.equal(flight.go(0), 'none', '挂载时在地面：不动');
assert.equal(log.length, 0);
assert.equal(flight.go(300), 'takeoff');
assert.deepEqual(log, ['fly:animate', 'shadow:animate', 'body:animate', 'bob:animate']);
assert.equal(walk.state, 'paused', '起飞时停下不走');
assert.deepEqual(aloft, [true]);
assert.equal(layers.bob.animations[0].options.iterations, Infinity, '到位后悬停浮动');
assert.equal(layers.bob.animations[0].options.delay, flightPlan(0, 300).settle);

log.length = 0;
current = 340;
assert.equal(flight.go(300), 'none', '同一高度不重复起飞');
assert.equal(flight.go(260), 'shift', '从读出的当前高度继续');
assert.deepEqual(log, ['fly:cancel', 'shadow:cancel', 'body:cancel', 'fly:animate', 'shadow:animate']);
assert.deepEqual(layers.fly.animations.at(-1).keyframes[0], { transform: 'translateY(-340px)' });

log.length = 0;
current = 260;
assert.equal(flight.go(0), 'land');
assert.ok(log.includes('bob:cancel'), '落下时停止浮动');
assert.equal(walk.state, 'paused', '站稳前不走');
await new Promise((resolve) => setTimeout(resolve, flightPlan(260, 0).settle + 30));
assert.equal(walk.state, 'running', '站稳后继续走');
assert.deepEqual(aloft, [true, false]);

// 落地途中又起飞：落地回调作废
current = 120;
flight.go(200);
const before = aloft.length;
current = 200;
flight.go(0);
current = 150;
flight.go(250);
await new Promise((resolve) => setTimeout(resolve, flightPlan(200, 0).settle + 30));
assert.equal(aloft.slice(before).includes(false), false, '被打断的落地不会回调站稳');
assert.equal(walk.state, 'paused');
flight.destroy();

// 同一帧里先起飞又落下（拖一下马上松手）：起飞动画还没推进，读到的高度仍是 0。
// 不能因为“已在目标高度”就什么都不做，否则起飞动画停在空中、行走一直暂停
{
    current = 0;
    const log3 = [];
    const quick = new CompanionFlight({ roam, fly: { ...fakeLayer(log3, 'fly'), name: 'fly' }, body: fakeLayer(log3, 'body'), bob: fakeLayer(log3, 'bob'), shadow: fakeLayer(log3, 'shadow') });
    quick.go(0);
    walk.play();
    quick.go(340);
    assert.equal(walk.state, 'paused');
    log3.length = 0;
    assert.equal(quick.go(0), 'none');
    assert.deepEqual(log3, ['fly:cancel', 'shadow:cancel', 'body:cancel', 'fly:animate', 'shadow:animate', 'bob:cancel'], '换成停在地面的动画');
    assert.deepEqual(quick.layers.fly.animations.at(-1).keyframes.at(-1), { transform: 'translateY(0px)' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(walk.state, 'running', '继续走');
    quick.destroy();
}

// 挂载时已在空中（例如回到地图页时搜索仍展开）：直接到位
current = 0;
const log2 = [];
const second = new CompanionFlight({ roam, fly: { ...fakeLayer(log2, 'fly'), name: 'fly' }, body: fakeLayer(log2, 'body'), bob: fakeLayer(log2, 'bob'), shadow: fakeLayer(log2, 'shadow') });
second.go(120);
assert.deepEqual(log2, ['fly:animate', 'shadow:animate', 'bob:animate'], '直接到位不拉长身体');
assert.equal(second.layers.fly.animations[0].options.duration, 0);

console.log('companion flight ok');
