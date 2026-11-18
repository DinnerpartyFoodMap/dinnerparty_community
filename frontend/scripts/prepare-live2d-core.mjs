import { access, mkdir, rename, writeFile } from 'node:fs/promises';

const directory = new URL('../src/companion/runtime/', import.meta.url);
const destination = new URL('live2dcubismcore.min.js', directory);
const sdkUrl = 'https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js';

try {
    await access(destination);
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(sdkUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Cubism Core download failed (${response.status})`);
    const javascript = await response.text();
    if (!javascript.includes('Live2DCubismCore')) throw new Error('Cubism Core download was not the expected JavaScript');
    await mkdir(directory, { recursive: true });
    const temporary = new URL(`live2d-core-${process.pid}.tmp`, directory);
    await writeFile(temporary, javascript);
    await rename(temporary, destination);
}
