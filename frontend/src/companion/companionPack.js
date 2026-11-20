import { fetchPackGrant } from '../skins/skinApi.js';
import { t } from '../i18n/index.js';
import { loadSharedMotionTable, sharedMotionUrl, withSharedMotions } from './sharedMotions.js';

// 补进来的内置动作在角色目录里的位置（资源包不会有这个目录）
const SHARED_DIR = 'companion-shared';

const ready = new Map();
const MAX_CACHED_MODELS = 4;

async function readFile(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(t('companion:packError'));
    return response.blob();
}

function modelFile(blob, relative) {
    const file = new File([blob], relative.split('/').at(-1), { type: blob.type });
    Object.defineProperty(file, 'webkitRelativePath', { value: relative });
    return file;
}

function modelReferences(refs) {
    return new Set([refs.Moc, ...(refs.Textures || []), refs.Physics, refs.Pose, refs.UserData,
        ...(refs.Expressions || []).map((item) => item.File),
        ...Object.values(refs.Motions || {}).flatMap((motions) => motions.flatMap((item) => [item.File, item.Sound]))]
        .filter((item) => typeof item === 'string' && item));
}

/** 清单所在目录下的相对路径（与运行时按清单解析引用的方式一致） */
function besideEntry(entry, relative) {
    return decodeURIComponent(new URL(relative, `file:///${entry}`).pathname.slice(1));
}

/**
 * 角色缺少的小伙伴动作组（底栏游走、攀爬、睡觉等）用内置动作补上：改写清单，并把动作文件作为同目录下的文件加入。
 * 内置动作读不到时照常加载角色，只是这些状态不播动作。
 */
async function addSharedMotions(json, entry, signal) {
    const table = await loadSharedMotionTable().catch(() => null);
    if (!table) return { manifest: json, files: [] };
    const { manifest, added } = withSharedMotions(json, table, (file) => `${SHARED_DIR}/${file}`);
    const files = await Promise.all(added.map(async (item) => modelFile(await readFile(sharedMotionUrl(item.source), signal), besideEntry(entry, item.path))));
    return { manifest, files };
}

export async function loadCompanionPack(backendUrl, token, id, { signal } = {}) {
    const grant = await fetchPackGrant(backendUrl, token, 'companion', id, { signal });
    const key = `${token}:${id}:${grant.version}`;
    if (ready.has(key)) return ready.get(key);
    const base = new URL(grant.base, grant.entryUrl).href;
    const json = JSON.parse(await (await readFile(grant.entryUrl, signal)).text());
    const { FileReferences } = json;
    if (!FileReferences?.Moc || !FileReferences.Textures?.length) throw new Error(t('companion:packError'));
    const files = await Promise.all([...modelReferences(FileReferences)].map(async (item) => {
        const url = new URL(item, grant.entryUrl).href;
        if (!url.startsWith(base)) throw new Error(t('companion:packError'));
        return modelFile(await readFile(url, signal), decodeURIComponent(url.slice(base.length)));
    }));
    const shared = await addSharedMotions(json, grant.entry, signal);
    const manifest = new Blob([JSON.stringify(shared.manifest)], { type: 'application/json' });
    const pack = [modelFile(manifest, grant.entry), ...files, ...shared.files];
    if (!signal?.aborted) {
        ready.set(key, pack);
        if (ready.size > MAX_CACHED_MODELS) ready.delete(ready.keys().next().value);
    }
    return pack;
}
