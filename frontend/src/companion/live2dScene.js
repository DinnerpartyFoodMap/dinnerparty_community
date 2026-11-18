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

export async function mountLive2D(container, source, { signal, reducedMotion = false } = {}) {
    await loadCore();
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    if (signal?.aborted) return null;
    Live2DModel.registerTicker(Ticker);
    const app = new Application({ width: 112, height: 132, resolution: Math.min(window.devicePixelRatio || 1, 2),
        autoDensity: true, backgroundAlpha: 0, antialias: true });
    try {
        const model = await Live2DModel.from(source, { autoInteract: false, autoUpdate: !reducedMotion });
        if (signal?.aborted) {
            model.destroy({ children: true, texture: true, baseTexture: true });
            app.destroy(true);
            return null;
        }
        const fit = Math.min(105 / model.width, 125 / model.height);
        model.anchor.set(0.5);
        model.position.set(56, 66);
        model.scale.set(fit);
        app.stage.addChild(model);
        if (reducedMotion) { app.stop(); app.render(); }
        container.appendChild(app.view);
        return {
            feed: () => !reducedMotion && model.motion('Feed', 0, 3).catch(() => {}),
            destroy: () => app.destroy(true, { children: true, texture: true, baseTexture: true })
        };
    } catch (error) {
        app.destroy(true, { children: true, texture: true, baseTexture: true });
        throw error;
    }
}
