// 小伙伴动作预览：npm run dev 后打开 /tests/integration/companion-motions.html。
// 用官方 Cubism Core 与应用同一套运行时（pixi-live2d-display）逐帧推进每个动作，按时间排成一张表，检查姿态与循环接缝。
// ?probe 改为逐个参数取极值，看这个模型哪些参数真的有形变。
import { Application, Ticker } from 'pixi.js';
import { DEFAULT_COMPANION_MODEL } from '../../src/companion/defaultCompanion';
import { loadSharedMotionTable, sharedMotionUrl, withSharedMotions } from '../../src/companion/sharedMotions';

const MODEL = `${import.meta.env.BASE_URL}${DEFAULT_COMPANION_MODEL}`;
// ?size=2 放大格子
const SIZE = Number(new URLSearchParams(location.search).get('size')) || 1;
const CELL = { width: Math.round(120 * SIZE), height: Math.round(142 * SIZE), label: 16 };
const status = document.getElementById('status');
const sheet = document.getElementById('sheet');

async function loadCore() {
    if (window.Live2DCubismCore) return;
    await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/src/companion/runtime/live2dcubismcore.min.js';
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// ?model=<model3.json 的地址>：换成别的模型，缺少的动作组用 withSharedMotions 补上内置动作（与资源包加载同一个函数）
async function source() {
    const external = new URLSearchParams(location.search).get('model');
    if (!external) return MODEL;
    const manifest = await fetch(external).then((response) => response.json());
    const shared = await loadSharedMotionTable();
    const { manifest: patched, added } = withSharedMotions(manifest, shared, sharedMotionUrl);
    status.textContent = `added ${added.length} shared groups`;
    return { ...patched, url: external };
}

async function setup() {
    await loadCore();
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    Live2DModel.registerTicker(Ticker);
    const app = new Application({ width: CELL.width, height: CELL.height, backgroundAlpha: 0, autoStart: false, preserveDrawingBuffer: true });
    const model = await Live2DModel.from(await source(), { autoInteract: false, autoUpdate: false });
    const fit = Math.min(CELL.width / model.width, CELL.height / model.height) * 0.94;
    model.anchor.set(0.5);
    model.position.set(CELL.width / 2, CELL.height / 2);
    model.scale.set(fit);
    app.stage.addChild(model);
    return { app, model, core: model.internalModel.coreModel };
}

function grid(rows, cols) {
    sheet.width = cols * CELL.width;
    sheet.height = rows * (CELL.height + CELL.label);
    const ctx = sheet.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, sheet.width, sheet.height);
    ctx.font = '11px system-ui, sans-serif';
    return ctx;
}

function draw(ctx, app, row, col, label) {
    const x = col * CELL.width;
    const y = row * (CELL.height + CELL.label);
    ctx.drawImage(app.view, x, y + CELL.label);
    ctx.fillStyle = '#b00';
    ctx.fillText(label, x + 3, y + 12);
    ctx.strokeStyle = '#eee';
    ctx.strokeRect(x + 0.5, y + 0.5, CELL.width - 1, CELL.height + CELL.label - 1);
}

async function probe({ app, model, core }) {
    const params = new URLSearchParams(location.search).get('probe');
    const list = params ? params.split(',') : ['ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
        'ParamBodyLean', 'ParamBreath', 'ParamEyeLOpen', 'ParamProportion'];
    let override = [];
    model.internalModel.on('beforeModelUpdate', () => {
        for (const [id, value] of override) core.setParameterValueById(id, value);
    });
    model.internalModel.motionManager.groups.idle = '__none__';
    const ctx = grid(list.length, 4);
    list.forEach((id, row) => {
        const index = core.getParameterIndex(id);
        const min = core.getParameterMinimumValue(index);
        const max = core.getParameterMaximumValue(index);
        [min, (min + core.getParameterDefaultValue(index)) / 2, core.getParameterDefaultValue(index), max].forEach((value, col) => {
            override = id === 'ParamEyeLOpen' ? [[id, value], ['ParamEyeROpen', value]] : [[id, value]];
            model.update(16);
            app.render();
            draw(ctx, app, row, col, `${id.replace('Param', '')} ${Math.round(value * 100) / 100}`);
        });
    });
    status.textContent = `probe: ${list.join(', ')}`;
}

async function motions({ app, model }) {
    const query = new URLSearchParams(location.search);
    const settings = model.internalModel.settings;
    const groups = (query.get('groups') || Object.keys(settings.motions).join(',')).split(',');
    const frames = Number(query.get('frames')) || 8;
    const manager = model.internalModel.motionManager;
    manager.groups.idle = '__none__';
    const ctx = grid(groups.length, frames + 1);
    for (const [row, group] of groups.entries()) {
        manager.stopAllMotions();
        // 先回到默认姿态，避免上一行的动作淡出影响这一行
        for (let i = 0; i < 90; i++) { model.update(1000 / 30); app.render(); }
        const file = settings.motions[group][0].File;
        const json = await fetch(settings.resolveURL(file)).then(response => response.json());
        const duration = json.Meta.Duration;
        await model.motion(group, 0, 3);
        const step = 1000 / 60;
        let time = 0;
        for (let col = 0; col <= frames; col++) {
            const target = (duration * col / frames) * 1000;
            while (time < target - 0.5) { model.update(step); app.render(); time += step; }
            app.render();
            draw(ctx, app, row, col, col === 0 ? `${group} ${duration}s` : `${(time / 1000).toFixed(2)}s`);
        }
    }
    status.textContent = `motions: ${groups.join(', ')} (${frames} steps each, last column = end)`;
}

// ?check=<模型列表地址>（返回 model3.json 相对地址数组）：逐个加载模型，补上内置动作后每个组都启动一遍，
// 记录能否启动、播放中画面变化的像素数。结果在 window.__checkResults。
async function check(listUrl) {
    await loadCore();
    const { Live2DModel } = await import('pixi-live2d-display/cubism4');
    Live2DModel.registerTicker(Ticker);
    const app = new Application({ width: CELL.width, height: CELL.height, backgroundAlpha: 0, autoStart: false, preserveDrawingBuffer: true });
    const scratch = document.createElement('canvas');
    scratch.width = CELL.width;
    scratch.height = CELL.height;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    const pixels = () => { ctx.clearRect(0, 0, CELL.width, CELL.height); ctx.drawImage(app.view, 0, 0); return ctx.getImageData(0, 0, CELL.width, CELL.height).data; };
    const changed = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 3] - b[i + 3]) > 60) n++; return n; };
    const shared = await loadSharedMotionTable();
    const groups = Object.keys(withSharedMotions({ FileReferences: {} }, shared, (file) => file).manifest.FileReferences.Motions);
    const base = new URL('./', listUrl).href;
    const list = await fetch(listUrl).then((response) => response.json());
    const results = [];
    for (const [index, entry] of list.entries()) {
        const url = new URL(entry, base).href;
        status.textContent = `checking ${index + 1}/${list.length} ${decodeURIComponent(entry.split('/')[0])}`;
        const row = { model: decodeURIComponent(entry.split('/')[0]), groups: {} };
        let model;
        try {
            const manifest = await fetch(url).then((response) => response.json());
            const { manifest: patched } = withSharedMotions(manifest, shared, sharedMotionUrl);
            model = await Live2DModel.from({ ...patched, url }, { autoInteract: false, autoUpdate: false });
            const fit = Math.min(CELL.width / model.width, CELL.height / model.height) * 0.94;
            model.anchor.set(0.5);
            model.position.set(CELL.width / 2, CELL.height / 2);
            model.scale.set(fit);
            app.stage.addChild(model);
            const manager = model.internalModel.motionManager;
            manager.groups.idle = '__none__';
            for (const group of groups) {
                manager.stopAllMotions();
                for (let i = 0; i < 20; i++) { model.update(1000 / 30); app.render(); }
                const before = pixels();
                const started = await model.motion(group, 0, 3);
                let most = 0;
                for (let i = 0; i < 40; i++) {
                    model.update(1000 / 30);
                    app.render();
                    if (i % 4 === 3) most = Math.max(most, changed(before, pixels()));
                }
                row.groups[group] = { started, changed: most };
            }
        } catch (error) {
            row.error = error.message;
        } finally {
            if (model) { app.stage.removeChild(model); model.destroy({ children: true, texture: true, baseTexture: true }); }
        }
        results.push(row);
    }
    window.__checkResults = results;
    const failed = results.filter((row) => row.error || Object.values(row.groups).some((item) => !item.started));
    const still = results.flatMap((row) => Object.entries(row.groups).filter(([, item]) => item.started && item.changed === 0).map(([group]) => `${row.model}:${group}`));
    status.textContent = `checked ${results.length} models × ${groups.length} groups; failed ${failed.length}; no visible change ${still.length}`;
}

const query = new URLSearchParams(location.search);
(query.has('check') ? check(query.get('check')) : setup().then((scene) => (query.has('probe') ? probe(scene) : motions(scene))))
    .catch((error) => { status.textContent = `error: ${error.message}`; console.error(error); });
