// 小伙伴各状态用到的动作组。额外角色（资源包）没有的组用原火柴人动作补上：
// 这些动作只驱动标准参数（头的转向/俯仰/歪头、身体角度、呼吸、眼睛开合，另有火柴人自己的 ParamBodyLean），
// 其他模型没有的参数会被运行时忽略。角色自己有同名组时用角色自己的；Standby 没有时先用角色的 Idle。

/** 状态 → 动作组名（与 public/companions/stick-figure/stick-figure.model3.json、scripts/companion-motions.mjs 一致） */
export const MOTION = Object.freeze({
    standby: 'Standby', wander: 'Wander', drop: 'Drop', land: 'Land', climb: 'Climb', jumpOff: 'JumpOff',
    sleep: 'Sleep', wake: 'Wake', hungry: 'Hungry', full: 'Full', feed: 'Feed'
});

/** 一次性动作的时长（秒），播完才切回循环；与动作文件的 Duration 一致（test:companion 核对） */
export const ONE_SHOT_SECONDS = Object.freeze({ Land: 0.55, JumpOff: 0.85, Wake: 0.9, Feed: 1.58 });

// Tororo 从 Cubism 2.1 转出，保留了旧版参数名。
export const TORORO_PARAMETER_IDS = Object.freeze({
    ParamAngleX: 'PARAM_ANGLE_X', ParamAngleY: 'PARAM_ANGLE_Y', ParamAngleZ: 'PARAM_ANGLE_Z',
    ParamBodyAngleX: 'PARAM_BODY_ANGLE_X', ParamBodyAngleY: 'PARAM_BODY_ANGLE_Y', ParamBreath: 'PARAM_BREATH'
});

const SHARED_GROUPS = Object.values(MOTION);

/**
 * 给模型清单（model3.json 内容）补上缺少的动作组。shared 是内置火柴人的 Motions（组名 → [{ File }]），
 * file(sharedFile) 返回补进来的动作在这个模型里的引用路径（相对清单的路径，或绝对 URL）。
 * 返回新的清单和补进来的文件 [{ group, source, path }]，原清单不变。
 */
export function withSharedMotions(manifest, shared, file) {
    const own = manifest?.FileReferences?.Motions || {};
    const motions = { ...own };
    const added = [];
    for (const group of SHARED_GROUPS) {
        if (Array.isArray(own[group]) && own[group].length) continue;
        if (group === MOTION.standby && Array.isArray(own.Idle) && own.Idle.length) {
            motions[group] = own.Idle;
            continue;
        }
        const source = shared?.[group]?.[0]?.File;
        if (!source) continue;
        const path = file(source);
        motions[group] = [{ File: path }];
        added.push({ group, source, path });
    }
    return { manifest: { ...manifest, FileReferences: { ...manifest.FileReferences, Motions: motions } }, added };
}

const BUILT_IN_DIR = `${import.meta.env?.BASE_URL ?? '/'}companions/stick-figure/`;
let sharedReady;

/** 内置火柴人的动作组（读一次 model3.json）。 */
export function loadSharedMotionTable() {
    if (!sharedReady) {
        sharedReady = fetch(`${BUILT_IN_DIR}stick-figure.model3.json`).then((response) => {
            if (!response.ok) throw new Error('shared motions unavailable');
            return response.json();
        }).then((json) => json.FileReferences.Motions).catch((error) => { sharedReady = undefined; throw error; });
    }
    return sharedReady;
}

/** 内置动作文件的地址 */
export function sharedMotionUrl(file) {
    return new URL(`${BUILT_IN_DIR}${file}`, typeof window !== 'undefined' ? window.location.href : 'http://localhost/').href;
}
