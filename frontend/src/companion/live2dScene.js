import { Application, Ticker } from 'pixi.js';

const bundled = import.meta.glob('./runtime/live2dcubismcore.min.js', { eager: true, query: '?url', import: 'default' });
const coreUrl = Object.values(bundled)[0];
let coreReady;

function loadCore() {
    if (window.Live2DCubismCore) return Promise.resolve();
    if (!coreUrl) return Promise.reject(new Error('Live2D Core is unavailable'));
    if (!coreReady) coreReady = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = coreUrl;
        script.onload = () => window.Live2DCubismCore ? resolve() : reject(new Error('Live2D Core did not initialize'));
        script.onerror = () => { script.remove(); reject(new Error('Live2D Core failed to load')); };
        document.head.appendChild(script);
    }).catch((error) => { coreReady = undefined; throw error; });
    return coreReady;
}

function hasColoredPixels(renderer) {
    const { gl, width, height } = renderer;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 0; i < pixels.length; i += 4) {
        // 内置角色有蓝色与粉色。纹理首帧未就绪或渲染成黑色时，继续显示随包预览图。
        const high = Math.max(pixels[i], pixels[i + 1], pixels[i + 2]);
        const low = Math.min(pixels[i], pixels[i + 1], pixels[i + 2]);
        if (pixels[i + 3] > 192 && high - low > 12) return true;
    }
    return false;
}

// 叠加姿态：参数 id 与偏移量（标准参数的角度单位，各模型通用），叠加在正在播放的动作之上，动作照常。
// aloft：飞在空中，抬头、身体略向后仰。facing：朝走路方向转头、转身、往那边弯（乘以方向 ±1）。
const MOODS = {
    aloft: [['ParamAngleY', 16], ['ParamBodyLean', -4]]
};
const FACING = [['ParamAngleX', 18], ['ParamBodyAngleX', 4], ['ParamBodyLean', 2]];
const POSE_EASE_MS = 160;
const FORCE = 3;

/**
 * 叠加层在物理之后、模型更新之前（beforeModelUpdate）加到参数上；参数在帧末由 loadParameters 还原，不会累积。
 * 每层切换时按时间常数平滑过渡，模型没有的参数跳过。返回 set(层名, [[参数, 偏移]] | null)。
 */
function attachPoses(model) {
    const core = model.internalModel.coreModel;
    const count = core.getParameterCount();
    const layers = new Map();
    let last = 0;
    model.internalModel.on('beforeModelUpdate', () => {
        const now = performance.now();
        const dt = last ? Math.min(100, now - last) : 16;
        last = now;
        for (const layer of layers.values()) {
            layer.blend += (layer.goal - layer.blend) * (1 - Math.exp(-dt / POSE_EASE_MS));
            if (layer.blend < 0.001) continue;
            for (const { index, value } of layer.targets) core.addParameterValueByIndex(index, value * layer.blend);
        }
    });
    return (name, entries) => {
        const layer = layers.get(name) || { targets: [], blend: 0, goal: 0 };
        layers.set(name, layer);
        if (!entries) {
            // 淡出时沿用原来的目标
            layer.goal = 0;
            return;
        }
        layer.targets = entries.flatMap(([id, value]) => {
            const index = core.getParameterIndex(id);
            return index >= 0 && index < count ? [{ index, value }] : [];
        });
        layer.goal = 1;
    };
}

/**
 * 动作控制：loop 把一个组设为待机组并立刻切过去（播完自动重播，用来表示持续的状态），
 * play 播一次（播完回到当前循环组）。模型没有的组：loop 退回 Idle，play 不播。
 */
function attachMotions(model) {
    const manager = model.internalModel.motionManager;
    const groups = model.internalModel.settings.motions || {};
    const has = (group) => Array.isArray(groups[group]) && groups[group].length > 0;
    let current = manager.groups.idle;
    return {
        has,
        loop(group) {
            const target = has(group) ? group : has('Idle') ? 'Idle' : null;
            if (!target || target === current) return;
            current = target;
            manager.groups.idle = target;
            model.motion(target, 0, FORCE).catch(() => {});
        },
        play(group) {
            if (!has(group)) return false;
            model.motion(group, 0, FORCE).catch(() => {});
            return true;
        }
    };
}

export async function mountLive2D(container, source, {
    signal, reducedMotion = false, verifyColors = false, onContextLost, onContextRestored
} = {}) {
    await loadCore();
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    if (signal?.aborted) return null;
    Live2DModel.registerTicker(Ticker);
    const { clientWidth: width, clientHeight: height } = container;
    if (!width || !height) return null;
    const app = new Application({ width, height, resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoStart: false, autoDensity: true, backgroundAlpha: 0, antialias: true });
    try {
        const model = await Live2DModel.from(source, { autoInteract: false, autoUpdate: !reducedMotion });
        if (signal?.aborted) {
            model.destroy({ children: true, texture: true, baseTexture: true });
            app.destroy(true);
            return null;
        }
        const fit = Math.min(width / model.width, height / model.height) * 0.94;
        model.anchor.set(0.5);
        model.position.set(width / 2, height / 2);
        model.scale.set(fit);
        app.stage.addChild(model);
        container.appendChild(app.view);
        app.render();
        if (verifyColors && !hasColoredPixels(app.renderer)) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (signal?.aborted) throw new Error('Live2D initialization cancelled');
            app.render();
            if (!hasColoredPixels(app.renderer)) throw new Error('The companion texture did not render');
        }
        app.view.addEventListener('webglcontextlost', onContextLost);
        app.view.addEventListener('webglcontextrestored', onContextRestored);
        if (!reducedMotion) app.start();
        const setPose = reducedMotion ? () => {} : attachPoses(model);
        const motions = reducedMotion ? { has: () => false, loop: () => {}, play: () => false } : attachMotions(model);
        return {
            feed: () => motions.play('Feed'),
            setMood: (name) => setPose('mood', MOODS[name] || null),
            // 朝向：1 画面右侧，-1 左侧，0 正面
            face: (direction) => setPose('facing', direction ? FACING.map(([id, value]) => [id, value * Math.sign(direction)]) : null),
            loop: motions.loop,
            play: motions.play,
            hasMotion: motions.has,
            destroy: () => {
                app.view.removeEventListener('webglcontextlost', onContextLost);
                app.view.removeEventListener('webglcontextrestored', onContextRestored);
                app.destroy(true, { children: true, texture: true, baseTexture: true });
            }
        };
    } catch (error) {
        app.destroy(true, { children: true, texture: true, baseTexture: true });
        throw error;
    }
}
