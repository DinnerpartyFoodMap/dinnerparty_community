const { readdirSync } = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

for (const file of readdirSync(__dirname).filter((name) => /^test_.*\.js$/.test(name)).sort()) {
    const { status, signal, error } = spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
    if (status !== 0) {
        console.error(`${file} 失败`, error?.message ?? signal ?? `退出码 ${status}`);
        process.exitCode = 1;
    }
}
