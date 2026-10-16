const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BACKEND_ROOT, backendPath } = require('../../infrastructure/paths');

const ui = process.argv.includes('--ui');
const directories = fs.readdirSync(backendPath('tests'), { withFileTypes: true }).filter(entry => entry.isDirectory());
const tests = directories.flatMap(entry => fs.readdirSync(backendPath('tests', entry.name))
    .filter(name => /^test_.*\.js$/.test(name) && name.endsWith('_ui.js') === ui)
    .map(name => path.join('tests', entry.name, name))).sort();
if (!tests.length) throw new Error('No test files found');
const failures = [];
for (const file of tests) {
    console.log(`\n>>> ${file}`);
    const result = spawnSync(process.execPath, [file], { cwd: BACKEND_ROOT, stdio: 'inherit', timeout: 180000 });
    if (result.status !== 0) {
        failures.push(file);
        console.error(result.error || `Test process exited ${result.status}, signal ${result.signal || 'none'}`);
    }
}
console.log(`\n${tests.length - failures.length}/${tests.length} ${ui ? 'browser' : 'backend'} test files passed.`);
if (failures.length) console.error(`Failed: ${failures.join(', ')}`);
process.exitCode = failures.length ? 1 : 0;
