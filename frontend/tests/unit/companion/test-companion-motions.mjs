// 内置火柴人的动作文件（scripts/companion-motions.mjs 生成）：与生成器一致、计数正确、别的角色也能用。
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

console.log('companion motions ok');
