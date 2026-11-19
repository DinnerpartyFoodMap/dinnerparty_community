// 底栏小伙伴的上下飞行：上拉「更多功能」或出现搜索结果时飞起，收起时落回原位继续走。
// 位移只用 Web Animations（element.animate）改 transform，不写 style / class：iOS 原生底图监听整页的属性变化
// 来重新采样触摸区域（map/nativeMapView.js），每帧写属性会让它反复全屏采样。CSS 动画和 Web Animations 都不改属性。

/** 拖动中工具栏上沿最多被拉过展开高度这么多（MapChromeView.drawerRevealed 的阻尼上限） */
export const DRAWER_OVERSHOOT = 40;
/** 停在结果列表上方时与列表上沿的间距 */
export const PERCH_GAP = 2;
/** 悬停时上下浮动的幅度与半周期 */
export const HOVER_BOB = Object.freeze({ distance: 4, duration: 1100 });

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const lifted = (px) => `translateY(${-Math.round(px)}px)`;

/**
 * 离地高度（CSS 像素，0 为站在工具栏上）。
 * drawer：readDrawerLayout 的结果。searchPerch 为结果列表上沿离搜索输入框的高度。
 */
export function companionLift({ drawer = null, searchPerch = null } = {}) {
    if (drawer && (drawer.open || drawer.dragging) && drawer.height > 0) {
        // 从收起开始拖：先飞到工具栏最多可能被拉到的高度之上；松手展开后落到展开高度；从展开往下拖时原地等着
        return Math.round(drawer.height + (drawer.open ? 0 : DRAWER_OVERSHOOT));
    }
    if (Number.isFinite(searchPerch) && searchPerch > 0) {
        return Math.round(searchPerch + PERCH_GAP);
    }
    return 0;
}

function shadowFrame(lift) {
    // 地面上的影子：飞得越高越小越淡
    return { transform: `scale(${clamp(1 - lift / 220, 0.4, 1).toFixed(3)})`, opacity: clamp(1 - lift / 180, 0.25, 1).toFixed(3) };
}

/** 直接停在 lift 高度（零时长，停留在终点）。 */
function holdPlan(lift) {
    const options = { duration: 0, fill: 'forwards' };
    return { settle: 0, fly: { keyframes: [{ transform: lifted(lift) }, { transform: lifted(lift) }], options },
        shadow: { keyframes: [shadowFrame(lift), shadowFrame(lift)], options } };
}

/**
 * 从 from 飞到 to（离地高度）的动画计划。kind：
 * takeoff 起飞（先冲过一点再停稳，身体拉长）；land 落地（越落越快，着地压扁再弹回）；shift 空中换高度；none 不用动。
 * reduced：减弱动态效果时淡出、换位置、淡入；instant：直接到位（刚挂载时已经在空中）。
 * 返回各层的关键帧与选项（Web Animations），以及到位所需的毫秒数 settle。
 */
export function flightPlan(from, to, { reduced = false, instant = false } = {}) {
    const start = Math.max(0, Math.round(from));
    const end = Math.max(0, Math.round(to));
    const distance = Math.abs(end - start);
    // 已在目标高度：kind 为 none，附带一段停在目标的零时长动画（上一段动画的终点可能在别处，见 CompanionFlight.go）
    if (distance < 1) return { ...holdPlan(end), kind: 'none' };
    const kind = start === 0 ? 'takeoff' : end === 0 ? 'land' : 'shift';
    const shadow = [shadowFrame(start), shadowFrame(end)];
    if (instant) return { ...holdPlan(end), kind };
    if (reduced) {
        const options = { duration: 260, easing: 'linear', fill: 'forwards' };
        return {
            kind, settle: options.duration,
            fly: { keyframes: [
                { transform: lifted(start), opacity: 1 },
                { transform: lifted(start), opacity: 0, offset: 0.45 },
                { transform: lifted(end), opacity: 0, offset: 0.55 },
                { transform: lifted(end), opacity: 1 }
            ], options },
            shadow: { keyframes: [shadowFrame(start), { ...shadowFrame(start), offset: 0.5 }, { ...shadowFrame(end), offset: 0.5 }, shadowFrame(end)], options }
        };
    }
    if (kind === 'takeoff') {
        // 起步快：赶在工具栏上沿追上脚之前离开，最后略冲过一点再回到目标
        const duration = Math.round(clamp(300 + distance * 0.5, 340, 560));
        const options = { duration, easing: 'cubic-bezier(0.18, 0.89, 0.32, 1.12)', fill: 'forwards' };
        return {
            kind, settle: duration,
            fly: { keyframes: [{ transform: lifted(start) }, { transform: lifted(end) }], options },
            body: { keyframes: [
                { transform: 'scale(1, 1)' },
                { transform: 'scale(0.9, 1.14)', offset: 0.25 },
                { transform: 'scale(1, 1)' }
            ], options: { duration: Math.round(duration * 0.7), easing: 'ease-out' } },
            shadow: { keyframes: shadow, options }
        };
    }
    if (kind === 'land') {
        // 自由落体：越落越快；落得比收起的工具栏慢一点，不会掉进玻璃里
        const duration = Math.round(clamp(220 + Math.sqrt(distance) * 16, 300, 600));
        const options = { duration, easing: 'cubic-bezier(0.55, 0.085, 0.68, 0.53)', fill: 'forwards' };
        return {
            kind, settle: duration + 300,
            fly: { keyframes: [{ transform: lifted(start) }, { transform: lifted(end) }], options },
            body: { keyframes: [
                { transform: 'scale(1, 1)' },
                { transform: 'scale(1.16, 0.8)', offset: 0.3 },
                { transform: 'scale(0.96, 1.05)', offset: 0.65 },
                { transform: 'scale(1, 1)' }
            ], options: { duration: 300, delay: duration, easing: 'ease-out' } },
            shadow: { keyframes: shadow, options }
        };
    }
    const options = { duration: 320, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' };
    return {
        kind, settle: options.duration,
        fly: { keyframes: [{ transform: lifted(start) }, { transform: lifted(end) }], options },
        shadow: { keyframes: shadow, options }
    };
}

/** 从计算样式里读出当前离地高度（动画进行中也是当下的值）。 */
export function readLift(element) {
    if (!element || typeof getComputedStyle !== 'function') return 0;
    const transform = getComputedStyle(element).transform;
    if (!transform || transform === 'none') return 0;
    const match = /^matrix(3d)?\((.+)\)$/.exec(transform);
    if (!match) return 0;
    const values = match[2].split(',').map(Number);
    const y = match[1] ? values[13] : values[5];
    return Number.isFinite(y) ? Math.max(0, -y) : 0;
}

/**
 * 管理四层元素的飞行：roam（定位与左右走的 CSS 动画）> fly（上下位移）> body（拉长 / 压扁，底边为原点）> bob（悬停浮动）；
 * shadow 留在地面。onAloftChange(true) 在起飞时、onAloftChange(false) 在落地站稳后调用。
 */
export class CompanionFlight {
    constructor({ roam, fly, body, bob, shadow, onAloftChange }) {
        this.layers = { roam, fly, body, bob, shadow };
        this.onAloftChange = onAloftChange;
        this.target = 0;
        this.aloft = false;
        this.started = false;
        this.animations = {};
        this.token = 0;
    }

    go(to, { reduced = false } = {}) {
        const { fly, body, bob, shadow } = this.layers;
        if (!fly || typeof fly.animate !== 'function') return 'none';
        const target = Math.max(0, Math.round(to));
        const instant = !this.started;
        this.started = true;
        if (target === this.target && !instant) return 'none';
        // 当前高度从计算样式读（动画进行中也准）。刚开始的动画还没推进一帧（同一帧里先起飞又落下，或页面在后台）时
        // 读到的是它的起点，算出来可能“不用动”；这时上一段动画仍会停在它的终点，所以也换成停在目标的零时长动画
        const from = readLift(fly);
        const plan = flightPlan(from, target, { reduced, instant });
        this.target = target;
        const token = ++this.token;
        if (plan.kind !== 'none' || this.animations.fly) {
            this._cancel(['fly', 'shadow', 'body']);
            this.animations.fly = fly.animate(plan.fly.keyframes, plan.fly.options);
            if (shadow && plan.shadow) this.animations.shadow = shadow.animate(plan.shadow.keyframes, plan.shadow.options);
            if (body && plan.body && !instant) this.animations.body = body.animate(plan.body.keyframes, plan.body.options);
        }
        if (target > 0) {
            this._walk(false);
            this._setAloft(true);
            if (!reduced && bob && !this.animations.bob) {
                this.animations.bob = bob.animate(
                    [{ transform: 'translateY(0)' }, { transform: `translateY(${-HOVER_BOB.distance}px)` }],
                    { duration: HOVER_BOB.duration, delay: plan.settle, iterations: Infinity, direction: 'alternate', easing: 'ease-in-out' }
                );
            }
        } else {
            this._cancel(['bob']);
            setTimeout(() => {
                if (token !== this.token || this.target !== 0) return;
                this._walk(true);
                this._setAloft(false);
            }, plan.settle);
        }
        return plan.kind;
    }

    _setAloft(value) {
        if (this.aloft === value) return;
        this.aloft = value;
        this.onAloftChange && this.onAloftChange(value);
    }

    /** 暂停 / 继续左右走（CSS 动画）：用动画对象控制，不改 class。 */
    _walk(play) {
        const { roam } = this.layers;
        const list = roam && typeof roam.getAnimations === 'function' ? roam.getAnimations() : [];
        for (const animation of list) {
            if (animation.animationName !== 'fm-companion-walk') continue;
            if (play) animation.play();
            else animation.pause();
        }
    }

    _cancel(names) {
        for (const name of names) {
            this.animations[name]?.cancel();
            delete this.animations[name];
        }
    }

    destroy() {
        this.token += 1;
        this._cancel(Object.keys(this.animations));
    }
}
