import { fetchPackGrant } from './skinApi.js';
import { registerSkinPacks } from './registry.js';
import { t } from '../i18n/index.js';

const readyVersions = new Map();

async function fetchFile(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(t('companion:skinDownloadError'));
    return response;
}

function imageData(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

export async function loadRemoteSkin(backendUrl, token, id, { signal } = {}) {
    const grant = await fetchPackGrant(backendUrl, token, 'skin', id, { signal });
    const key = `${backendUrl}/${id}`;
    if (readyVersions.get(key) === grant.version) return;
    const [manifest, images] = await Promise.all([
        fetchFile(grant.entryUrl, signal).then((response) => response.json()),
        Promise.all(grant.images.map(async (file) => {
            const response = await fetchFile(grant.url(file), signal);
            return [file, await imageData(await response.blob())];
        }))
    ]);
    if (signal?.aborted) return;
    registerSkinPacks([{ id, manifest, assets: Object.fromEntries(images) }]);
    readyVersions.set(key, grant.version);
}
