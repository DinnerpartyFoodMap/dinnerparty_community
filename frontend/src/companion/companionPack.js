import { fetchPackGrant } from '../skins/skinApi.js';
import { t } from '../i18n/index.js';

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

export async function loadCompanionPack(backendUrl, token, id, { signal } = {}) {
    const grant = await fetchPackGrant(backendUrl, token, 'companion', id, { signal });
    const key = `${token}:${id}:${grant.version}`;
    if (ready.has(key)) return ready.get(key);
    const base = new URL(grant.base, grant.entryUrl).href;
    const manifest = await readFile(grant.entryUrl, signal);
    const { FileReferences } = JSON.parse(await manifest.text());
    if (!FileReferences?.Moc || !FileReferences.Textures?.length) throw new Error(t('companion:packError'));
    const files = await Promise.all([...modelReferences(FileReferences)].map(async (item) => {
        const url = new URL(item, grant.entryUrl).href;
        if (!url.startsWith(base)) throw new Error(t('companion:packError'));
        return modelFile(await readFile(url, signal), decodeURIComponent(url.slice(base.length)));
    }));
    const pack = [modelFile(manifest, grant.entry), ...files];
    if (!signal?.aborted) {
        ready.set(key, pack);
        if (ready.size > MAX_CACHED_MODELS) ready.delete(ready.keys().next().value);
    }
    return pack;
}
