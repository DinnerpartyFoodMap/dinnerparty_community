// 底栏小伙伴飞行（src/companion/companionFlight.js）：起飞高度与飞行动画计划。执行（CompanionActor）见 test-companion-behavior.mjs。
import assert from 'node:assert/strict';
import { DRAWER_OVERSHOOT, PERCH_GAP, companionLift, flightPlan } from '../../../src/companion/companionFlight.js';

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
assert.equal(flightPlan(0, 0).fly.options.duration, 0, '不用动时也给一段停在原地的零时长动画，替换掉终点在别处的旧动画');
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
assert.equal(instant.fly.options.duration, 0, '直接到位');
assert.equal(instant.settle, 0);
assert.ok(Number(flightPlan(0, 300).shadow.keyframes[1].opacity) < 1, '飞起来影子变淡');

console.log('companion flight ok');
