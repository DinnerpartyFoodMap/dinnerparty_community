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
        return {
            feed: () => !reducedMotion && model.motion('Feed', 0, 3).catch(() => {}),
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
