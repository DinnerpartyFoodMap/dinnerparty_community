// 底栏小伙伴的状态规则（不碰 DOM，便于测试）：什么时候发呆、游走、爬按钮、睡觉，饿和饱怎么算，往哪走、爬哪里。
// 坐标：x 是小伙伴左边缘相对地图左边缘的像素；y（lift）是脚底离地面（工具栏上沿）的高度。
import { MOTION } from './sharedMotions.js';

/** 底栏小伙伴的显示与行走占位尺寸。 */
export const BOX = Object.freeze({ width: 54, height: 65 });
/** 离屏幕左边、按钮的最小距离 */
export const MARGIN = 8;

/** 饿：距上次投喂超过 48 小时（从没喂过时从领养算起）；饱：投喂后 3 小时内。刚投喂的庆祝只在 3 小时内补放 */
export const NEEDS = Object.freeze({ hungryAfterMs: 48 * 3600e3, fullForMs: 3 * 3600e3 });

/** 多久没有操作就睡：白天 150 秒，饿着 90 秒，夜里（23:00–7:00，本机时间）30 秒 */
export const SLEEP = Object.freeze({ dayMs: 150e3, hungryMs: 90e3, nightMs: 30e3, nightFrom: 23, nightTo: 7 });

/** 发呆时长（毫秒）、走路速度（像素/秒） */
export const STANDBY_MS = Object.freeze({ normal: [2500, 6000], hungry: [4000, 9000], full: [2000, 5000] });
export const SPEED = Object.freeze({ normal: 26, hungry: 14, full: 32 });

/**
 * 爬按钮：发呆后有一定概率去爬（吃饱时更爱爬，饿着不爬），两次至少隔 90 秒；在上面待 12–28 秒后跳下。
 * 一次往上拉 step 像素、用时 stepMs；爬到离顶 reach 像素时翻上去。
 */
export const CLIMB = Object.freeze({ chance: 0.35, fullChance: 0.6, cooldownMs: 90e3, perchMs: [12e3, 28e3], reach: 14, step: 13, stepMs: 350 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const between = ([min, max], random) => Math.round(min + (max - min) * random());
const time = (value) => {
    const parsed = typeof value === 'number' ? value : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
};

/** 饿 / 饱。fedAt 上次投喂、adoptedAt 领养时间（ISO 或毫秒，可为空） */
export function companionNeeds({ fedAt = null, adoptedAt = null, now }) {
    const fed = time(fedAt);
    const since = fed ?? time(adoptedAt);
    return {
        fedAt: fed,
        full: fed != null && now - fed >= 0 && now - fed < NEEDS.fullForMs,
        hungry: since != null && now - since > NEEDS.hungryAfterMs
    };
}

export function isNight(date) {
    const hour = date.getHours();
    return hour >= SLEEP.nightFrom || hour < SLEEP.nightTo;
}

/** 多久没操作就睡 */
export function sleepDelay({ hungry = false, night = false } = {}) {
    if (night) return SLEEP.nightMs;
    return hungry ? SLEEP.hungryMs : SLEEP.dayMs;
}

/** 新的一次投喂还没庆祝过、且在 3 小时内 */
export function celebrationDue({ needs, celebrated, now }) {
    return needs.fedAt != null && needs.fedAt > (celebrated || 0) && now - needs.fedAt < NEEDS.fullForMs;
}

export function walkSpeed(needs) {
    if (needs.hungry) return SPEED.hungry;
    return needs.full ? SPEED.full : SPEED.normal;
}

/** 发呆时播的动作：饿了耷拉着，饱了一半时间晃着笑 */
export function standbyMotion(needs, random) {
    if (needs.hungry) return MOTION.hungry;
    if (needs.full && random() < 0.5) return MOTION.full;
    return MOTION.standby;
}

export function standbyMs(needs, random) {
    if (needs.hungry) return between(STANDBY_MS.hungry, random);
    return between(needs.full ? STANDBY_MS.full : STANDBY_MS.normal, random);
}

/**
 * 地面上可以走的范围（小伙伴左边缘的 x）。geometry：left 地图左边缘、width 地图宽度（视口像素），
 * column 右侧按钮组的外框（视口坐标，没有时为 null）。不走到按钮底下。
 */
export function walkBand({ left = 0, width, column = null }) {
    const edge = width - BOX.width - MARGIN;
    const max = column ? Math.min(edge, column.left - left - BOX.width - MARGIN) : edge;
    return { min: MARGIN, max: Math.max(MARGIN, Math.round(max)) };
}

/**
 * 爬按钮的路线：在按钮组左侧贴着往上爬（footX），翻到顶上站在中间（perchX），顶上离地 topY。
 * 按钮组要从地面附近开始（底边离地 -12..40 像素）、高 40–420 像素，否则不爬。ground 为地面的视口 y。
 */
export function climbRoute({ left = 0, ground, column = null }) {
    if (!column || !Number.isFinite(ground)) return null;
    const footX = Math.round(column.left - left - BOX.width + 10);
    const perchX = Math.round((column.left + column.right) / 2 - left - BOX.width / 2);
    const topY = Math.round(ground - column.top);
    const baseGap = ground - column.bottom;
    if (topY < 40 || topY > 420 || baseGap < -12 || baseGap > 40 || footX < MARGIN) return null;
    return { footX, perchX, topY };
}

/** 从按钮上跳下的落点：往左跳出 40–90 像素 */
export function jumpLanding(route, band, random) {
    return Math.round(clamp(route.footX - 40 - random() * 50, band.min, band.max));
}

/** 下一段游走的目标：同向或反向走 40–180 像素，碰边就掉头 */
export function wanderTarget(x, band, random) {
    const distance = 40 + random() * 140;
    let direction = random() < 0.5 ? -1 : 1;
    const ahead = x + direction * distance;
    if (ahead > band.max || ahead < band.min) direction = -direction;
    let to = clamp(x + direction * distance, band.min, band.max);
    if (Math.abs(to - x) < 30) to = band.min + (band.max - band.min) * random();
    return Math.round(to);
}

/**
 * 地面上的下一步：走完或刚落地先发呆；发呆后去爬按钮（概率、冷却、不饿、有路线）或者游走；地方太窄就继续发呆。
 * last：上一步的类型（'standby' | 'wander' | 'climb' | 其他）。
 */
export function decideNext({ last, x, band, route, needs, now, lastClimbAt = -Infinity, random }) {
    const standby = () => ({ type: 'standby', ms: standbyMs(needs, random), motion: standbyMotion(needs, random) });
    if (last !== 'standby') return standby();
    const chance = needs.full ? CLIMB.fullChance : CLIMB.chance;
    if (route && !needs.hungry && now - lastClimbAt >= CLIMB.cooldownMs && random() < chance) return { type: 'climb' };
    if (band.max - band.min >= 40) return { type: 'wander', to: wanderTarget(clamp(x, band.min, band.max), band, random) };
    return standby();
}
