// 动效预设：桌面/指针与移动/触屏两套参数。数值是首轮实现的设计起点，依据真机调节，并非 Apple 内部参数。
// 减少动态效果时统一退化为短渐变（不位移、不缩放）。

export const EASE = Object.freeze({
    standard: [0.2, 0, 0, 1],
    decelerate: [0.05, 0.7, 0.1, 1],
    accelerate: [0.3, 0, 0.8, 0.15],
    // iOS 风格的页面推入曲线
    push: [0.32, 0.72, 0, 1]
});

export const SPRING = Object.freeze({
    // 底部面板：阻尼弹簧，约 320–420ms 收敛，无明显过冲
    sheet: { type: 'spring', stiffness: 420, damping: 42, mass: 1 },
    // 拖动释放后回弹
    settle: { type: 'spring', stiffness: 520, damping: 44, mass: 1 }
});

const REDUCED = Object.freeze({
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.12, ease: 'linear' } },
    exit: { opacity: 0, transition: { duration: 0.1, ease: 'linear' } }
});

export const BACKDROP = Object.freeze({
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.22, ease: EASE.standard } },
    exit: { opacity: 0, transition: { duration: 0.2, ease: EASE.standard } }
});

function sidePanel(side, touch) {
    const sign = side === 'left' ? -1 : 1;
    return {
        initial: { opacity: 0, x: sign * (touch ? 40 : 24) },
        animate: { opacity: 1, x: 0, transition: { duration: touch ? 0.32 : 0.28, ease: EASE.decelerate } },
        exit: { opacity: 0, x: sign * 16, transition: { duration: 0.2, ease: EASE.accelerate } }
    };
}

/** 菜单从触发位置展开：opensUp 时从下方升起，transform-origin 由调用方按方位设置。 */
function menu(opensUp, touch) {
    const dy = opensUp ? 6 : -6;
    return {
        initial: { opacity: 0, scale: 0.96, y: dy },
        animate: { opacity: 1, scale: 1, y: 0, transition: { duration: touch ? 0.22 : 0.18, ease: EASE.decelerate } },
        exit: { opacity: 0, scale: 0.97, y: dy * 0.6, transition: { duration: 0.13, ease: EASE.accelerate } }
    };
}

const PRESETS = {
    modal: (touch) => ({
        initial: { opacity: 0, scale: touch ? 0.95 : 0.97, y: touch ? 0 : 10 },
        animate: { opacity: 1, scale: 1, y: 0, transition: { duration: touch ? 0.24 : 0.24, ease: EASE.decelerate } },
        exit: { opacity: 0, scale: 0.98, y: touch ? 0 : 6, transition: { duration: 0.17, ease: EASE.accelerate } }
    }),
    sheet: () => ({
        initial: { y: '100%' },
        animate: { y: 0, transition: SPRING.sheet },
        exit: { y: '100%', transition: { duration: 0.26, ease: EASE.accelerate } }
    }),
    'side-left': (touch) => sidePanel('left', touch),
    'side-right': (touch) => sidePanel('right', touch),
    'menu-down': (touch) => menu(false, touch),
    'menu-up': (touch) => menu(true, touch),
    // 地点卡片从地图锚点展开
    card: (touch) => ({
        initial: { opacity: 0, scale: 0.9, y: 10 },
        animate: { opacity: 1, scale: 1, y: 0, transition: { duration: touch ? 0.24 : 0.2, ease: EASE.decelerate } },
        exit: { opacity: 0, scale: 0.94, y: 6, transition: { duration: 0.14, ease: EASE.accelerate } }
    }),
    // 下拉结果、提示条
    dropdown: (touch, opensUp) => ({
        initial: { opacity: 0, y: opensUp ? 8 : -8 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.2, ease: EASE.decelerate } },
        exit: { opacity: 0, y: opensUp ? 6 : -6, transition: { duration: 0.14, ease: EASE.accelerate } }
    }),
    toast: () => ({
        initial: { opacity: 0, y: 8, scale: 0.98 },
        animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.2, ease: EASE.decelerate } },
        exit: { opacity: 0, y: 6, transition: { duration: 0.16, ease: EASE.accelerate } }
    }),
    tooltip: () => ({
        initial: { opacity: 0, y: 4 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.14, ease: EASE.decelerate } },
        exit: { opacity: 0, transition: { duration: 0.1 } }
    }),
    fade: () => ({
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.2, ease: EASE.standard } },
        exit: { opacity: 0, transition: { duration: 0.16, ease: EASE.standard } }
    }),
    // 图片预览：来源可见时由调用方提供 from 矩形，否则渐变放大
    preview: () => ({
        initial: { opacity: 0, scale: 0.92 },
        animate: { opacity: 1, scale: 1, transition: { duration: 0.24, ease: EASE.decelerate } },
        exit: { opacity: 0, scale: 0.96, transition: { duration: 0.18, ease: EASE.accelerate } }
    })
};

/**
 * @param {string} name 预设名
 * @param {{ touch?: boolean, reduced?: boolean, opensUp?: boolean }} options
 */
export function getPreset(name, { touch = false, reduced = false, opensUp = false } = {}) {
    if (reduced) return REDUCED;
    const factory = PRESETS[name] || PRESETS.fade;
    return factory(touch, opensUp);
}

/** 页面层级转场：触屏为方向相反的 push/pop；桌面为小位移渐变。 */
export function getPageVariants({ touch, reduced }) {
    if (reduced) {
        return {
            initial: { opacity: 0 },
            animate: { opacity: 1, x: 0, transition: { duration: 0.12 } },
            exit: { opacity: 0, transition: { duration: 0.1 } }
        };
    }
    if (touch) {
        return {
            initial: (dir) => (dir === 'pop' ? { x: '-28%', opacity: 1 } : { x: '100%', opacity: 1 }),
            animate: { x: 0, opacity: 1, transition: { duration: 0.34, ease: EASE.push } },
            exit: (dir) => (dir === 'pop'
                ? { x: '100%', transition: { duration: 0.3, ease: EASE.push } }
                : { x: '-28%', opacity: 1, transition: { duration: 0.34, ease: EASE.push } })
        };
    }
    return {
        initial: (dir) => ({ opacity: 0, x: dir === 'pop' ? -12 : 12 }),
        animate: { opacity: 1, x: 0, transition: { duration: 0.22, ease: EASE.decelerate } },
        exit: (dir) => ({ opacity: 0, x: dir === 'pop' ? 12 : -12, transition: { duration: 0.16, ease: EASE.accelerate } })
    };
}

export function transformOriginFor(placement = 'bottom-end') {
    const [side, align = 'center'] = placement.split('-');
    const vertical = side === 'top' ? 'bottom' : 'top';
    const horizontal = align === 'start' ? 'left' : align === 'end' ? 'right' : 'center';
    return `${horizontal} ${vertical}`;
}
