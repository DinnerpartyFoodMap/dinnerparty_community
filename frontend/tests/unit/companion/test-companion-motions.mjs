// 小伙伴的动作文件与生成器一致，文件计数、Tororo 参数和动作时长正确。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EYE_BLINK, MODEL_DIR, MOTIONS, POSE, countSegments, staleFiles, validateMotion } from '../../../scripts/companion-motions.mjs';
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

const tororoDir = path.join(MODEL_DIR, '../tororo');
const tororo = JSON.parse(fs.readFileSync(path.join(tororoDir, 'tororo.model3.json'), 'utf8'));
const tororoRefs = tororo.FileReferences;
const tororoParameters = new Set(JSON.parse(fs.readFileSync(path.join(tororoDir, tororoRefs.DisplayInfo), 'utf8')).Parameters.map(({ Id }) => Id));
const tororoMotion = (group) => JSON.parse(fs.readFileSync(path.join(tororoDir, tororoRefs.Motions[group][0].File), 'utf8'));
for (const group of Object.values(MOTION)) assert.ok(tororoRefs.Motions[group]?.length, `Tororo 有 ${group} 组`);
assert.deepEqual(tororoRefs.Motions.Standby, tororoRefs.Motions.Idle, 'Tororo 待机沿用官方动作');
for (const group of Object.values(MOTION).filter((group) => group !== MOTION.standby)) {
    const { Curves } = tororoMotion(group);
    assert.ok(Curves.some(({ Id }) => Id === 'PARAM_ANGLE_X'), `${group} 使用 Tororo 的旧版头部参数`);
    assert.ok(Curves.every(({ Id, Target }) => Target !== 'Parameter' || tororoParameters.has(Id)), `${group} 仅驱动 Tororo 已有的参数`);
}
for (const [group, seconds] of Object.entries(ONE_SHOT_SECONDS)) assert.equal(tororoMotion(group).Meta.Duration, seconds, `Tororo ${group} 时长与状态机一致`);

console.log('companion motions ok');
