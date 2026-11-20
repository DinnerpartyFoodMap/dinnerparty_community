// 小伙伴的动作文件与生成器一致，文件计数、内置模型参数和动作时长正确。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EYE_BLINK, MODEL_DIR, MOTIONS, POSE, countSegments, staleFiles, validateMotion } from '../../../scripts/companion-motions.mjs';
import { DEFAULT_COMPANION_MODEL } from '../../../src/companion/defaultCompanion.js';
import { MOTION, ONE_SHOT_SECONDS } from '../../../src/companion/sharedMotions.js';

assert.deepEqual(staleFiles(), [], '动作文件与生成器一致（改动作后运行 npm run companion:motions）');

const model = JSON.parse(fs.readFileSync(path.join(MODEL_DIR, 'stick-figure.model3.json'), 'utf8'));
const groups = model.FileReferences.Motions;
const read = (group) => JSON.parse(fs.readFileSync(path.join(MODEL_DIR, groups[group][0].File), 'utf8'));

for (const group of Object.values(MOTION)) assert.ok(groups[group]?.length, `model3.json 有 ${group} 组`);
assert.deepEqual(model.Groups.find((item) => item.Name === 'EyeBlink')?.Ids, ['ParamEyeLOpen', 'ParamEyeROpen'], 'EyeBlink 模型曲线经这个组驱动两只眼睛');

for (const [name, motion] of Object.entries(MOTIONS)) assert.deepEqual(validateMotion(name, motion), [], `${name} 关键帧有效`);

for (const group of Object.values(MOTION)) {
    const json = read(group);
    const totals = json.Curves.reduce((sum, curve) => {
        const counted = countSegments(curve.Segments);
        return { segments: sum.segments + counted.segments, points: sum.points + counted.points };
    }, { segments: 0, points: 0 });
    assert.equal(json.Meta.CurveCount, json.Curves.length, `${group} CurveCount`);
    assert.equal(json.Meta.TotalSegmentCount, totals.segments, `${group} TotalSegmentCount`);
    assert.equal(json.Meta.TotalPointCount, totals.points, `${group} TotalPointCount`);
    // 运行时只从开头连续读取模型曲线
    const firstParameter = json.Curves.findIndex((curve) => curve.Target === 'Parameter');
    assert.ok(json.Curves.slice(firstParameter).every((curve) => curve.Target !== 'Model'), `${group} 模型曲线在前`);
    const ids = new Set(json.Curves.map((curve) => curve.Id));
    for (const id of Object.keys(POSE)) assert.ok(ids.has(id), `${group} 驱动 ${id}（切换动作时复位）`);
    assert.equal(ids.has('ParamEyeLOpen') || ids.has('ParamEyeROpen'), false, `${group} 眼睛用 ${EYE_BLINK}，不直接写眼睛参数`);
}

for (const [group, seconds] of Object.entries(ONE_SHOT_SECONDS)) assert.equal(read(group).Meta.Duration, seconds, `${group} 时长与状态机一致`);

const builtInManifest = path.join(MODEL_DIR, '../..', DEFAULT_COMPANION_MODEL);
const builtInDir = path.dirname(builtInManifest);
const builtIn = JSON.parse(fs.readFileSync(builtInManifest, 'utf8'));
const builtInRefs = builtIn.FileReferences;
const builtInParameters = new Set(JSON.parse(fs.readFileSync(path.join(builtInDir, builtInRefs.DisplayInfo), 'utf8')).Parameters.map(({ Id }) => Id));
const builtInMotion = (group) => JSON.parse(fs.readFileSync(path.join(builtInDir, builtInRefs.Motions[group][0].File), 'utf8'));
const spiritAxes = ['ParamPartAnimalTail11', 'ParamPartAnimalTail1Y', 'ParamPartAnimalTail21', 'ParamPartAnimalTail2Y'];
function keyValues(segments) {
    const values = [segments[1]];
    for (let index = 2; index < segments.length;) {
        index += segments[index] === 1 ? 7 : 3;
        values.push(segments[index - 1]);
    }
    return values;
}

assert.deepEqual(builtInRefs.Motions.Standby, builtInRefs.Motions.Idle, '饭桶在地图和观察屋使用同一套待机动作');
for (const group of Object.values(MOTION)) {
    assert.ok(builtInRefs.Motions[group]?.length, `饭桶有 ${group} 组`);
    assert.ok(builtInRefs.Motions[group].every(({ File }) => !path.isAbsolute(File) && !File.split('/').includes('..')), `${group} 随饭桶发布`);
    const { Curves, Meta } = builtInMotion(group);
    assert.ok(Curves.some(({ Id }) => Id === 'ParamAngleX'), `${group} 使用标准头部参数`);
    assert.ok(Curves.every(({ Id, Target }) => Target !== 'Parameter' || builtInParameters.has(Id)), `${group} 仅驱动模型已有的参数`);
    if (group === MOTION.standby) continue;
    for (const id of spiritAxes) {
        const segments = Curves.find(({ Id }) => Id === id)?.Segments;
        assert.ok(segments && keyValues(segments).every((value) => value === 0), `${group} 将 ${id} 保持在默认值`);
        assert.deepEqual(segments?.slice(-2), [Meta.Duration, 0], `${group} 恢复默认 ${id}`);
    }
}
const standby = builtInMotion(MOTION.standby);
assert.equal(standby.Meta.Duration, 6.4);
const standbyAxes = spiritAxes.map((id) => {
    const segments = standby.Curves.find(({ Id }) => Id === id)?.Segments;
    assert.ok(segments && new Set(keyValues(segments)).size > 1, `饭桶待机动画驱动 ${id}`);
    return segments;
});
assert.notDeepEqual(standbyAxes[0], standbyAxes[2], '左右小幽灵的摆动各自编排');
assert.notDeepEqual(standbyAxes[1], standbyAxes[3], '左右小幽灵的浮动各自编排');
for (const [group, seconds] of Object.entries(ONE_SHOT_SECONDS)) assert.equal(builtInMotion(group).Meta.Duration, seconds, `${group} 时长与状态机一致`);

console.log('companion motions ok');
