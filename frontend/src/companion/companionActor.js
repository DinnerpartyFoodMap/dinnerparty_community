// 底栏小伙伴的位移层，全部用 Web Animations 改 transform / opacity，不写 style、class，也不增删元素：
// iOS 原生底图按整页属性和节点变化重新采样触摸区域（map/nativeMapView.js），逐帧写属性会让它反复全屏采样。
//
// 层次：x（左右）> fly（上下）> body（拉长 / 压扁，脚底为原点）> bob（悬停浮动、走路颠步）> 角色；
// shadow 在 x 里、留在脚下所站的面上；fx 里是睡觉的 z 和投喂的爱心，跟着角色走、不跟着压扁。
// 每个动作返回 Promise<boolean>：做完为 true，被下一个动作打断为 false。
import { flightPlan } from './companionFlight.js';

const STEP_BOB = Object.freeze({ distance: 2, duration: 210 });
export const HOVER_BOB = Object.freeze({ distance: 4, duration: 1100 });
const RISE = 'cubic-bezier(0.2, 0.7, 0.4, 1)';
const FALL = 'cubic-bezier(0.55, 0.085, 0.68, 0.53)';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const atX = (px) => ({ transform: `translateX(${Math.round(px)}px)` });
const atY = (px) => ({ transform: `translateY(${-Math.round(px)}px)` });

/** 元素当前（含动画中）的平移量 */
export function readTranslate(element) {
    if (!element || typeof getComputedStyle !== 'function') return { x: 0, y: 0 };
    const transform = getComputedStyle(element).transform;
    const match = transform && /^matrix(3d)?\((.+)\)$/.exec(transform);
    if (!match) return { x: 0, y: 0 };
    const values = match[2].split(',').map(Number);
    const [x, y] = match[1] ? [values[12], values[13]] : [values[4], values[5]];
    return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/** 影子：在所站的面（surface，离地高度）上，离面越高越小越淡 */
export function shadowFrame(surface, height) {
    return {
        transform: `translateY(${-Math.round(surface)}px) scale(${clamp(1 - height / 220, 0.4, 1).toFixed(3)})`,
        opacity: clamp(1 - height / 180, 0.25, 1).toFixed(3)
    };
}

export class CompanionActor {
    constructor(layers) {
        this.layers = layers;
        this.anims = {};
        this.fx = [];
        this.surface = 0;
        this.ready = typeof layers?.x?.animate === 'function' && typeof layers?.fly?.animate === 'function';
    }

    /** 当前位置（动画进行中读到的是此刻的值） */
    position() {
        return { x: readTranslate(this.layers.x).x, y: Math.max(0, -readTranslate(this.layers.fly).y) };
    }

    _start(name, element, keyframes, options) {
        if (!element || typeof element.animate !== 'function') return null;
        this.anims[name]?.cancel();
        const animation = element.animate(keyframes, options);
        this.anims[name] = animation;
        return animation;
    }

    _cancel(...names) {
        for (const name of names) {
            this.anims[name]?.cancel();
            delete this.anims[name];
        }
    }

    _done(animation) {
        return animation?.finished ? animation.finished.then(() => true, () => false) : Promise.resolve(true);
    }

    _shadow(fromSurface, fromHeight, toSurface, toHeight, options) {
        const keyframes = fromSurface === toSurface
            ? [shadowFrame(fromSurface, fromHeight), shadowFrame(toSurface, toHeight)]
            // 换了所站的面：先淡掉，在新的面上再出现
            : [shadowFrame(fromSurface, fromHeight), { ...shadowFrame(fromSurface, fromHeight), opacity: 0, offset: 0.3 },
                { ...shadowFrame(toSurface, toHeight), opacity: 0, offset: 0.7 }, shadowFrame(toSurface, toHeight)];
        this._start('shadow', this.layers.shadow, keyframes, { ...options, fill: 'forwards' });
        this.surface = toSurface;
    }

    /** 直接放到 (x, y)，影子在 surface 上 */
    place(x, y, surface = 0) {
        const hold = { duration: 0, fill: 'forwards' };
        this._cancel('body', 'bob');
        this._start('x', this.layers.x, [atX(x), atX(x)], hold);
        this._start('fly', this.layers.fly, [atY(y), atY(y)], hold);
        this._shadow(surface, y - surface, surface, y - surface, hold);
    }

    /** 停在当前位置（打断进行中的移动，不跳位置） */
    stop() {
        const { x, y } = this.position();
        this.place(x, y, Math.min(this.surface, y));
    }

    /** 走到 to：匀速，身体随脚步一颠一颠 */
    walk(to, speed) {
        const { x, y } = this.position();
        const duration = Math.max(1, Math.round(Math.abs(to - x) / Math.max(1, speed) * 1000));
        this._cancel('body');
        const walking = this._start('x', this.layers.x, [atX(x), atX(to)], { duration, easing: 'linear', fill: 'forwards' });
        this._start('bob', this.layers.bob, [{ transform: 'translateY(0)' }, { transform: `translateY(${-STEP_BOB.distance}px)` }],
            { duration: STEP_BOB.duration, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
        return this._done(walking).then((finished) => {
            if (finished) this._cancel('bob');
            return finished;
        });
    }

    /**
     * 飞到 (toX, toY)：上下按飞行计划（起飞先冲过一点、落下越落越快着地压扁），左右同时缓动过去；在空中时悬停浮动。
     * 返回 { touchdown, settled }：到位（落地那一刻）与站稳（压扁弹回之后）。
     */
    fly(toX, toY, { reduced = false } = {}) {
        const from = this.position();
        const plan = flightPlan(from.y, toY, { reduced });
        this._cancel('body', 'bob');
        const duration = Math.max(1, plan.fly.options.duration || 1);
        // 减弱动态效果：淡出期间直接换到新位置
        const across = reduced ? [atX(from.x), { ...atX(from.x), offset: 0.5 }, { ...atX(toX), offset: 0.5 }, atX(toX)] : [atX(from.x), atX(toX)];
        this._start('x', this.layers.x, across, { duration, easing: reduced ? 'linear' : RISE, fill: 'forwards' });
        const flying = this._start('fly', this.layers.fly, plan.fly.keyframes, plan.fly.options);
        if (plan.body && !reduced) this._start('body', this.layers.body, plan.body.keyframes, plan.body.options);
        this._shadow(0, from.y, 0, toY, plan.fly.options);
        if (toY > 0) this.hover(!reduced, plan.settle);
        const touchdown = this._done(flying);
        const settled = plan.body ? this._done(this.anims.body) : touchdown;
        return { touchdown, settled };
    }

    /**
     * 抛物线跳到 (toX, toY)：先上升到比起点高 peak 的位置（减速），再落到终点（加速）；x 匀速。surface 为落点所站的面。
     */
    arc(toX, toY, { peak = 16, upMs = 220, downMs = 380, surface = 0 } = {}) {
        const from = this.position();
        const top = Math.max(from.y, toY) + peak;
        const duration = upMs + downMs;
        this._cancel('bob');
        this._start('x', this.layers.x, [atX(from.x), atX(toX)], { duration, easing: 'linear', fill: 'forwards' });
        const jumping = this._start('fly', this.layers.fly, [
            { ...atY(from.y), easing: RISE },
            { ...atY(top), offset: upMs / duration, easing: FALL },
            atY(toY)
        ], { duration, fill: 'forwards' });
        this._shadow(this.surface, from.y - this.surface, surface, toY - surface, { duration });
        return this._done(jumping);
    }

    /** 贴着按钮一下一下往上爬到 toY：每下先拉（60% 时间）再停一下 */
    climb(toY, { step = 13, stepMs = 350 } = {}) {
        const from = this.position();
        const count = Math.max(1, Math.ceil((toY - from.y) / step));
        const keyframes = [{ ...atY(from.y), easing: RISE }];
        for (let i = 1; i <= count; i++) {
            const y = Math.min(toY, from.y + i * step);
            keyframes.push({ ...atY(y), offset: (i - 0.4) / count, easing: 'linear' });
            if (i < count) keyframes.push({ ...atY(y), offset: i / count, easing: RISE });
        }
        keyframes.push(atY(toY));
        this._cancel('bob', 'body');
        const climbing = this._start('fly', this.layers.fly, keyframes, { duration: count * stepMs, fill: 'forwards' });
        this._shadow(0, from.y, 0, toY, { duration: count * stepMs });
        return this._done(climbing);
    }

    /** 蹲下蓄力（停在蹲着的样子，下一个动作取消） */
    crouch(ms = 220) {
        return this._done(this._start('body', this.layers.body, [{ transform: 'scale(1, 1)' }, { transform: 'scale(1.12, 0.84)' }],
            { duration: ms, easing: 'ease-out', fill: 'forwards' }));
    }

    /** 着地压扁再弹回 */
    squash() {
        return this._done(this._start('body', this.layers.body, [
            { transform: 'scale(1, 1)' }, { transform: 'scale(1.16, 0.8)', offset: 0.3 },
            { transform: 'scale(0.96, 1.05)', offset: 0.65 }, { transform: 'scale(1, 1)' }
        ], { duration: 300, easing: 'ease-out' }));
    }

    /** 原地蹦一下（高 height，用时 ms），落下时压扁 */
    hop(height, ms = 340) {
        const hopping = this._start('bob', this.layers.bob, [
            { transform: 'translateY(0)', easing: RISE },
            { transform: `translateY(${-Math.round(height)}px)`, offset: 0.45, easing: FALL },
            { transform: 'translateY(0)' }
        ], { duration: ms });
        return this._done(hopping).then((finished) => {
            if (finished) this.squash();
            return finished;
        });
    }

    /** 悬停时上下轻轻浮动（delay 毫秒后开始） */
    hover(on, delay = 0) {
        if (!on) {
            this._cancel('bob');
            return;
        }
        this._start('bob', this.layers.bob, [{ transform: 'translateY(0)' }, { transform: `translateY(${-HOVER_BOB.distance}px)` }],
            { duration: HOVER_BOB.duration, delay, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' });
    }

    /** 睡觉时头顶冒出的 z（三个错开飘起） */
    zzz(on) {
        this.fx.forEach((animation) => animation.cancel());
        this.fx = [];
        if (!on) return;
        (this.layers.zzz || []).forEach((element, index) => {
            if (typeof element?.animate !== 'function') return;
            this.fx.push(element.animate([
                { opacity: 0, transform: 'translate(0, 0) scale(0.6)' },
                { opacity: 1, transform: 'translate(3px, -8px) scale(0.8)', offset: 0.3 },
                { opacity: 0, transform: 'translate(10px, -24px) scale(1)' }
            ], { duration: 2400, delay: index * 800, iterations: Infinity, easing: 'ease-out' }));
        });
    }

    /** 投喂时冒出的爱心 */
    heart() {
        const element = this.layers.heart;
        if (typeof element?.animate !== 'function') return;
        element.animate([
            { opacity: 0, transform: 'translateY(6px) scale(0.8)' },
            { opacity: 1, transform: 'translateY(0) scale(1)', offset: 0.2 },
            { opacity: 0, transform: 'translateY(-20px) scale(1)' }
        ], { duration: 1200, easing: 'ease-out' });
    }

    destroy() {
        this._cancel(...Object.keys(this.anims));
        this.zzz(false);
    }
}
