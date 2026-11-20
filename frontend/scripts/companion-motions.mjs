// 内置火柴人的动作文件（motion3.json）生成器：node scripts/companion-motions.mjs 写入，加 --check 只核对。
// 动作在下方 MOTIONS 里按关键帧写，相邻关键帧之间用 Cubism 编辑器默认的平滑贝塞尔（控制点在三分之一处、切线水平），
// 生成的文件放在 public/companions/stick-figure/，并把动作组写进 model3.json。待机由 PSD2Live 导出的 idle 加上复位曲线得到。
//
// 这个模型只有头的转向/俯仰/歪头、身体的倾斜与前倾、比例、呼吸和眼睛开合有形变（眼睛 0 是闭眼弧线），
// 手臂、嘴、眉毛、眼珠的参数存在但画面不变，所以动作只用前一组参数。
// 动作没有写到的参数会停在上一个动作留下的值上（运行时不会自动复位），所以每个动作都驱动整组姿态参数，没写的按默认值补成常量。
// 眼睛开合写成模型曲线 EyeBlink（Target "Model"），由每个模型自己的 EyeBlink 组决定驱动哪些参数：
// 这些动作也给别的角色用（sharedMotions.js），有的模型眼睛参数不叫 ParamEyeLOpen（例如 ParamEyeLOpen1）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const MODEL_DIR = path.join(root, 'public/companions/stick-figure');
const MODEL_FILE = path.join(MODEL_DIR, 'stick-figure.model3.json');
const IDLE_SOURCE = 'stick-figure.idle.motion3.json';
const FEED_SOURCE = 'stick-figure.feed.motion3.json';
/** 模型曲线：眼睛开合（1 睁开、0 闭上），作用于模型 EyeBlink 组里的参数 */
export const EYE_BLINK = 'EyeBlink';
const EYE_PARAMS = ['ParamEyeLOpen', 'ParamEyeROpen'];

/** 每个动作都要驱动的姿态参数与默认值 */
export const POSE = Object.freeze({
    ParamAngleX: 0, ParamAngleY: 0, ParamAngleZ: 0,
    ParamBodyAngleX: 0, ParamBodyAngleY: 0, ParamBodyAngleZ: 0, ParamBodyLean: 0,
    ParamBreath: 0, [EYE_BLINK]: 1
});

/** 参数范围：头身角度取 Cubism 标准参数的常见范围（其他模型也多是这个范围），生成时检查关键帧不越界 */
export const RANGES = Object.freeze({
    ParamAngleX: [-30, 30], ParamAngleY: [-30, 30], ParamAngleZ: [-30, 30],
    ParamBodyAngleX: [-10, 10], ParamBodyAngleY: [-10, 10], ParamBodyAngleZ: [-10, 10], ParamBodyLean: [-10, 10],
    ParamBreath: [0, 1], [EYE_BLINK]: [0, 1], ParamProportion: [-10, 10]
});

const eyes = (keys) => ({ [EYE_BLINK]: keys });
const curve = (id, segments) => ({ Target: id === EYE_BLINK ? 'Model' : 'Parameter', Id: id, Segments: segments });

/**
 * 动作表。group 是 model3.json 里的动作组名（运行时按组播放），loop 只是说明：
 * 循环由运行时把它设为待机组、播完自动重播（Cubism 运行时不读 Meta.Loop），首尾姿态相同才没有接缝。
 * 时间单位秒；BodyLean 正值向画面右侧弯，AngleX 正值看向画面右侧，AngleY 正值抬头，AngleZ / BodyAngleZ 正值向右歪。
 */
export const MOTIONS = Object.freeze({
    // 游走：0.8 秒两步。身体随脚步左右晃、头反向微歪，落脚时身体往下一沉
    Wander: { file: 'stick-figure.wander.motion3.json', duration: 0.8, fadeIn: 0.25, fadeOut: 0.25, loop: true, curves: {
        ParamBodyAngleZ: [[0, 0], [0.2, 4], [0.4, 0], [0.6, -4], [0.8, 0]],
        ParamAngleZ: [[0, 0], [0.2, -3], [0.4, 0], [0.6, 3], [0.8, 0]],
        ParamBodyAngleY: [[0, -2], [0.2, 1.5], [0.4, -2], [0.6, 1.5], [0.8, -2]],
        ParamAngleY: [[0, 3], [0.2, 5], [0.4, 3], [0.6, 5], [0.8, 3]],
        ParamBreath: [[0, 0.4], [0.4, 0.6], [0.8, 0.4]]
    } },
    // 掉落：仰头、吸一口气，头和身体快速反向晃（扑腾）
    Drop: { file: 'stick-figure.drop.motion3.json', duration: 0.6, fadeIn: 0.1, fadeOut: 0.15, loop: true, curves: {
        ParamAngleY: [[0, 16], [0.3, 19], [0.6, 16]],
        ParamAngleZ: [[0, -5], [0.15, 5], [0.3, -5], [0.45, 5], [0.6, -5]],
        ParamBodyAngleZ: [[0, 4], [0.15, -4], [0.3, 4], [0.45, -4], [0.6, 4]],
        ParamBodyAngleY: [[0, 4], [0.6, 4]],
        ParamBreath: [[0, 1], [0.6, 1]]
    } },
    // 着地（掉落、跳下的收尾）：头一点、身体一沉、挤一下眼，再弹回
    Land: { file: 'stick-figure.land.motion3.json', duration: 0.55, fadeIn: 0.05, fadeOut: 0.25, curves: {
        ParamAngleY: [[0, 16], [0.07, -16], [0.22, 5], [0.38, -2], [0.55, 0]],
        ParamBodyAngleY: [[0, 4], [0.07, -8], [0.22, 3], [0.38, -1], [0.55, 0]],
        ParamAngleZ: [[0, 0], [0.07, 4], [0.22, -2], [0.55, 0]],
        ParamBodyAngleZ: [[0, 0], [0.07, -3], [0.22, 1], [0.55, 0]],
        ParamBreath: [[0, 1], [0.2, 0.3], [0.55, 0.5]],
        ...eyes([[0, 1], [0.05, 0], [0.16, 0], [0.26, 1], [0.55, 1]])
    } },
    // 攀爬：0.7 秒拉两下。抬头看上面、身体贴向右侧的按钮，左右交替够、每拉一下身体一挺
    Climb: { file: 'stick-figure.climb.motion3.json', duration: 0.7, fadeIn: 0.2, fadeOut: 0.2, loop: true, curves: {
        ParamAngleY: [[0, 14], [0.175, 18], [0.35, 14], [0.525, 18], [0.7, 14]],
        ParamAngleX: [[0, 8], [0.7, 8]],
        ParamBodyAngleZ: [[0, -6], [0.35, 6], [0.7, -6]],
        ParamAngleZ: [[0, 4], [0.35, -4], [0.7, 4]],
        ParamBodyLean: [[0, 3], [0.175, 5], [0.35, 3], [0.525, 5], [0.7, 3]],
        ParamBodyAngleY: [[0, -3], [0.12, 3], [0.35, -3], [0.47, 3], [0.7, -3]],
        ParamBreath: [[0, 0.3], [0.35, 0.8], [0.7, 0.3]]
    } },
    // 从按钮上跳下：蹲（低头、闭眼、往跳的方向弯）→ 起跳抬头 → 空中歪头
    JumpOff: { file: 'stick-figure.jumpoff.motion3.json', duration: 0.85, fadeIn: 0.12, fadeOut: 0.15, curves: {
        ParamAngleY: [[0, 0], [0.18, -14], [0.22, -14], [0.32, 16], [0.6, 12], [0.85, 10]],
        ParamBodyAngleY: [[0, 0], [0.18, -7], [0.22, -7], [0.32, 6], [0.85, 4]],
        ParamBodyLean: [[0, 0], [0.18, -4], [0.32, -2], [0.85, 0]],
        ParamAngleZ: [[0, 0], [0.32, -6], [0.6, 6], [0.85, 4]],
        ParamBodyAngleZ: [[0, 0], [0.32, 4], [0.6, -3], [0.85, -2]],
        ParamBreath: [[0, 0], [0.18, 1], [0.32, 0.2], [0.85, 0.6]],
        ...eyes([[0, 1], [0.18, 0], [0.26, 0], [0.32, 1], [0.85, 1]])
    } },
    // 睡觉：4 秒一次深呼吸。闭眼、低头歪向一边，头随呼吸慢慢点
    Sleep: { file: 'stick-figure.sleep.motion3.json', duration: 4, fadeIn: 1, fadeOut: 0.3, loop: true, curves: {
        ParamAngleY: [[0, -14], [2, -18], [4, -14]],
        ParamAngleZ: [[0, 10], [2, 13], [4, 10]],
        ParamBodyAngleZ: [[0, 3], [2, 4], [4, 3]],
        ParamBodyAngleY: [[0, -4], [1.6, -1], [4, -4]],
        ParamBodyLean: [[0, 2], [2, 3], [4, 2]],
        ParamBreath: [[0, 0], [1.6, 1], [4, 0]],
        ...eyes([[0, 0], [4, 0]])
    } },
    // 醒来：眨两下眼、甩甩头，回到正常姿态
    Wake: { file: 'stick-figure.wake.motion3.json', duration: 0.9, fadeIn: 0.1, fadeOut: 0.3, curves: {
        ParamAngleY: [[0, -14], [0.3, 4], [0.9, 0]],
        ParamAngleZ: [[0, 10], [0.4, -8], [0.52, 7], [0.64, -5], [0.76, 3], [0.9, 0]],
        ParamBodyAngleZ: [[0, 3], [0.4, -3], [0.6, 2], [0.9, 0]],
        ParamBodyAngleY: [[0, -4], [0.3, 3], [0.9, 0]],
        ParamBodyLean: [[0, 2], [0.4, 0], [0.9, 0]],
        ParamBreath: [[0, 0], [0.3, 1], [0.9, 0.4]],
        ...eyes([[0, 0], [0.12, 1], [0.24, 0], [0.36, 1], [0.9, 1]])
    } },
    // 饿了：6 秒。耷拉着头、半睁眼、身体歪着，左右张望找吃的，肚子叫时抖一下，末尾眨眼
    Hungry: { file: 'stick-figure.hungry.motion3.json', duration: 6, fadeIn: 0.6, fadeOut: 0.4, loop: true, curves: {
        ParamAngleY: [[0, -10], [1, -12], [2.4, -6], [3.4, -6], [4.4, -12], [6, -10]],
        ParamAngleX: [[0, 0], [1.2, -18], [1.8, -18], [2.8, 18], [3.4, 18], [4.4, 0], [6, 0]],
        ParamAngleZ: [[0, -4], [3, -6], [6, -4]],
        ParamBodyLean: [[0, 3], [3, 4], [6, 3]],
        ParamBodyAngleY: [[0, -5], [3, -3], [6, -5]],
        ParamBodyAngleZ: [[0, 0], [4.6, 0], [4.66, 3], [4.72, -3], [4.78, 3], [4.84, -3], [4.9, 0], [6, 0]],
        ParamBreath: [[0, 0], [3, 0.5], [6, 0]],
        ...eyes([[0, 0.55], [5.1, 0.55], [5.2, 0], [5.35, 0], [5.45, 0.55], [6, 0.55]])
    } },
    // 吃饱：3.2 秒。眯成弧线的笑眼、头和身体左右轻晃、每拍一小颠，中间睁一下眼
    Full: { file: 'stick-figure.full.motion3.json', duration: 3.2, fadeIn: 0.4, fadeOut: 0.4, loop: true, curves: {
        ParamAngleZ: [[0, -8], [0.8, 8], [1.6, -8], [2.4, 8], [3.2, -8]],
        ParamBodyAngleZ: [[0, 3], [0.8, -3], [1.6, 3], [2.4, -3], [3.2, 3]],
        ParamBodyAngleY: [[0, 0], [0.25, 3], [0.5, 0], [0.8, 0], [1.05, 3], [1.3, 0], [1.6, 0], [1.85, 3], [2.1, 0], [2.4, 0],
            [2.65, 3], [2.9, 0], [3.2, 0]],
        ParamAngleY: [[0, 6], [1.6, 8], [3.2, 6]],
        ParamBreath: [[0, 0.2], [1.6, 0.8], [3.2, 0.2]],
        ...eyes([[0, 0], [1.4, 0], [1.5, 1], [1.9, 1], [2, 0], [3.2, 0]])
    } }
});

/**
 * model3.json 里的动作组：原有的 Idle / Blink 不变，加上上面的动作；
 * Standby 由 idle 得到（补复位曲线），Feed 改用由原投喂动作得到的 nod（眼睛改成 EyeBlink 曲线），两者也给别的角色用。
 */
export const STANDBY = { group: 'Standby', file: 'stick-figure.standby.motion3.json' };
export const FEED = { group: 'Feed', file: 'stick-figure.nod.motion3.json' };

const round = (value) => Math.round(value * 1e4) / 1e4;

/** 关键帧 → Cubism 线段数组：第一个点之后，每段是“1（贝塞尔）、两个控制点、终点”。 */
export function bezierSegments(keys) {
    const segments = [round(keys[0][0]), round(keys[0][1])];
    for (let i = 1; i < keys.length; i++) {
        const [t0, v0] = keys[i - 1];
        const [t1, v1] = keys[i];
        const third = (t1 - t0) / 3;
        segments.push(1, round(t0 + third), round(v0), round(t1 - third), round(v1), round(t1), round(v1));
    }
    return segments;
}

/** 线段数组里有多少段、多少个点（贝塞尔段 3 个点，其余 1 个，加上每条曲线的起点），与 Meta 里的计数一致 */
export function countSegments(segments) {
    let count = 0;
    let points = 1;
    for (let i = 2; i < segments.length;) {
        const type = segments[i];
        count += 1;
        points += type === 1 ? 3 : 1;
        i += type === 1 ? 7 : 3;
    }
    return { segments: count, points };
}

function meta({ duration, fadeIn, fadeOut, loop }, curves) {
    const totals = curves.reduce((sum, curve) => {
        const { segments, points } = countSegments(curve.Segments);
        return { segments: sum.segments + segments, points: sum.points + points };
    }, { segments: 0, points: 0 });
    return {
        Duration: duration, Fps: 30, FadeInTime: fadeIn, FadeOutTime: fadeOut, Loop: !!loop, AreBeziersRestricted: true,
        CurveCount: curves.length, TotalSegmentCount: totals.segments, TotalPointCount: totals.points, UserDataCount: 0, TotalUserDataSize: 0
    };
}

/** 检查关键帧：从 0 开始、到时长结束、时间递增、值在范围内；循环动作首尾相同 */
export function validateMotion(name, motion) {
    const problems = [];
    for (const [id, keys] of Object.entries(motion.curves)) {
        if (!RANGES[id]) problems.push(`${name}.${id}: 不是有形变的参数`);
        if (keys[0][0] !== 0) problems.push(`${name}.${id}: 第一帧不在 0 秒`);
        if (Math.abs(keys.at(-1)[0] - motion.duration) > 1e-9) problems.push(`${name}.${id}: 最后一帧不在 ${motion.duration} 秒`);
        keys.forEach(([time, value], index) => {
            if (index && time <= keys[index - 1][0]) problems.push(`${name}.${id}: 第 ${index} 帧时间没有递增`);
            const [min, max] = RANGES[id] || [-Infinity, Infinity];
            if (value < min || value > max) problems.push(`${name}.${id}: ${value} 超出 ${min}..${max}`);
        });
        if (motion.loop && keys[0][1] !== keys.at(-1)[1]) problems.push(`${name}.${id}: 循环动作首尾不同`);
    }
    return problems;
}

/**
 * 曲线顺序：模型曲线在前、参数曲线在后。Cubism 运行时（官方 Framework 与 pixi-live2d-display 相同）
 * 只从第一条开始连续读取 Target 为 Model 的曲线，排在参数曲线后面的 EyeBlink 会被忽略。
 */
function ordered(curves) {
    return [...curves.filter((item) => item.Target === 'Model'), ...curves.filter((item) => item.Target !== 'Model')];
}

/** 生成一个动作的 motion3.json 内容：写到的曲线按关键帧，整组姿态里没写的补成默认值常量 */
export function buildMotion(motion) {
    const ids = [...Object.keys(POSE), ...Object.keys(motion.curves).filter((id) => !(id in POSE))];
    const curves = ordered(ids.map((id) => curve(id, bezierSegments(motion.curves[id] || [[0, POSE[id]], [motion.duration, POSE[id]]]))));
    return { Version: 3, Meta: meta(motion, curves), Curves: curves };
}

/**
 * 改写 PSD2Live 导出的动作，让别的角色也能用：左右眼曲线换成一条 EyeBlink 模型曲线（取左眼那条，两眼本来就几乎一样），
 * 再补上原动作没有驱动的姿态参数为常量（extra），切换到这个动作时这些参数会复位。
 */
export function adaptExport(source, { extra = {}, fadeIn, fadeOut, loop }) {
    const duration = source.Meta.Duration;
    const eye = source.Curves.find((item) => item.Id === EYE_PARAMS[0]);
    const curves = source.Curves.filter((item) => !EYE_PARAMS.includes(item.Id));
    if (eye) curves.push(curve(EYE_BLINK, eye.Segments));
    const driven = new Set(curves.map((item) => item.Id));
    for (const [id, value] of Object.entries(extra)) {
        if (!driven.has(id)) curves.push(curve(id, bezierSegments([[0, value], [duration, value]])));
    }
    const sorted = ordered(curves);
    return { Version: 3, Meta: meta({ duration, fadeIn, fadeOut, loop }, sorted), Curves: sorted };
}

/** 生成全部文件内容：{ 文件名: 文本 }，包括改写动作组后的 model3.json */
export function buildAll() {
    const read = (name) => JSON.parse(fs.readFileSync(path.join(MODEL_DIR, name), 'utf8'));
    const files = {
        [STANDBY.file]: adaptExport(read(IDLE_SOURCE), { extra: { ...POSE, ParamProportion: 0 }, fadeIn: 0.5, fadeOut: 0.5, loop: true }),
        [FEED.file]: adaptExport(read(FEED_SOURCE), { extra: POSE, fadeIn: 0.15, fadeOut: 0.3 })
    };
    for (const [name, motion] of Object.entries(MOTIONS)) {
        const problems = validateMotion(name, motion);
        if (problems.length) throw new Error(problems.join('\n'));
        files[motion.file] = buildMotion(motion);
    }
    const model = JSON.parse(fs.readFileSync(MODEL_FILE, 'utf8'));
    const motions = model.FileReferences.Motions;
    const kept = Object.fromEntries(['Idle', 'Blink'].filter((group) => motions[group]).map((group) => [group, motions[group]]));
    model.FileReferences.Motions = {
        ...kept,
        [FEED.group]: [{ File: FEED.file }],
        [STANDBY.group]: [{ File: STANDBY.file }],
        ...Object.fromEntries(Object.entries(MOTIONS).map(([group, motion]) => [group, [{ File: motion.file }]]))
    };
    files[path.basename(MODEL_FILE)] = model;
    return Object.fromEntries(Object.entries(files).map(([name, json]) => [name, `${JSON.stringify(json, null, 4)}\n`]));
}

/** 与磁盘上的文件比较，返回不一致的文件名 */
export function staleFiles() {
    return Object.entries(buildAll()).filter(([name, text]) => {
        const file = path.join(MODEL_DIR, name);
        return !fs.existsSync(file) || fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text;
    }).map(([name]) => name);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    if (process.argv.includes('--check')) {
        const stale = staleFiles();
        if (stale.length) {
            console.error(`动作文件与 scripts/companion-motions.mjs 不一致，运行 npm run companion:motions：\n${stale.join('\n')}`);
            process.exit(1);
        }
        console.log('companion motions up to date');
    } else {
        for (const [name, text] of Object.entries(buildAll())) fs.writeFileSync(path.join(MODEL_DIR, name), text);
        console.log(`wrote ${Object.keys(MOTIONS).length + 2} motions and the model3.json motion groups`);
    }
}
