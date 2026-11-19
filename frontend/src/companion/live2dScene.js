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

function hasStickFigureColors(renderer) {
    const { gl, width, height } = renderer;
    const pixels = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    for (let i = 0; i < pixels.length; i += 4) {
        // 内置火柴人的脸和围巾有暖色。首帧只有不透明黑色时，继续显示随包线稿。
        if (pixels[i + 3] > 192 && pixels[i] > 140 && pixels[i] - pixels[i + 2] > 12) return true;
    }
    return false;
}

// 姿态：参数 id 与偏移比例（正数按最大值、负数按最小值算，模型不同范围也不同），叠加在待机动作之上，待机的晃动照常。
// aloft：飞在空中，抬头、身体略向后仰。内置火柴人只给头身角度、前倾、比例与呼吸做了形变，
// 手臂、嘴、眉毛、眼珠参数不会改变画面，所以不用。
const MOODS = {
    aloft: [['ParamAngleY', 0.55], ['ParamBodyLean', -0.4]]
};
const MOOD_EASE_MS = 140;

/**
 * 姿态叠加在物理之后、模型更新之前（beforeModelUpdate）；参数在帧末由 loadParameters 还原，不会累积。
 * 切换时按时间常数平滑过渡。模型没有的参数跳过。
 */
function attachMoods(model) {
    const core = model.internalModel.coreModel;
    const count = core.getParameterCount();
    const resolve = (name) => (MOODS[name] || []).flatMap(([id, fraction]) => {
        const index = core.getParameterIndex(id);
        if (index < 0 || index >= count) return [];
        const value = fraction >= 0 ? core.getParameterMaximumValue(index) * fraction : core.getParameterMinimumValue(index) * -fraction;
        return [{ index, value }];
    });
    const state = { targets: [], blend: 0, goal: 0, last: 0 };
    const apply = () => {
        const now = performance.now();
        const dt = state.last ? Math.min(100, now - state.last) : 16;
        state.last = now;
        state.blend += (state.goal - state.blend) * (1 - Math.exp(-dt / MOOD_EASE_MS));
        if (state.blend < 0.001) return;
        for (const { index, value } of state.targets) {
            core.addParameterValueByIndex(index, value * state.blend);
        }
    };
    model.internalModel.on('beforeModelUpdate', apply);
    return (name) => {
        if (name && MOODS[name]) {
            state.targets = resolve(name);
            state.goal = 1;
        } else {
            // 淡出时沿用上一组目标
            state.goal = 0;
        }
    };
}

export async function mountLive2D(container, source, { signal, reducedMotion = false, verifyColors = false, onContextLost, onContextRestored } = {}) {
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
        if (verifyColors && !hasStickFigureColors(app.renderer)) {
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (signal?.aborted) throw new Error('Live2D initialization cancelled');
            app.render();
            if (!hasStickFigureColors(app.renderer)) throw new Error('Stick figure did not render its colors');
        }
        app.view.addEventListener('webglcontextlost', onContextLost);
        app.view.addEventListener('webglcontextrestored', onContextRestored);
        if (!reducedMotion) app.start();
        const setMood = reducedMotion ? () => {} : attachMoods(model);
        return {
            feed: () => !reducedMotion && model.motion('Feed', 0, 3).catch(() => {}),
            setMood,
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
