const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { BACKEND_ROOT } = require('../../infrastructure/paths');

// A different cwd and a relative DB_FILE caught the most dangerous relocation regression.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'yuyuko-resource-paths-'));
const databaseFile = path.join(temp, 'relative.sqlite');
const env = { ...process.env, DB_FILE: path.relative(BACKEND_ROOT, databaseFile), LOG_TO_FILE: 'false', LOG_TO_CONSOLE: 'false' };
delete env.UPLOADS_DIR;
delete env.LOG_DIR;
const code = `
    const assert = require('node:assert/strict');
    const { db } = require(${JSON.stringify(path.join(BACKEND_ROOT, 'infrastructure/database.js'))});
    const images = require(${JSON.stringify(path.join(BACKEND_ROOT, 'modules/media/services/imageStorage.js'))});
    const logger = require(${JSON.stringify(path.join(BACKEND_ROOT, 'infrastructure/logger.js'))});
    assert.equal(db._raw.name, ${JSON.stringify(databaseFile)});
    assert.equal(images.LOCAL_UPLOAD_DIR, ${JSON.stringify(path.join(BACKEND_ROOT, 'uploads'))});
    assert.equal(logger.config.directory, ${JSON.stringify(path.join(BACKEND_ROOT, 'logs'))});
    db._raw.close();
`;
try {
    const result = spawnSync(process.execPath, ['-e', code], { cwd: temp, env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(fs.existsSync(databaseFile), 'relative DB_FILE did not open the isolated expected database');
    console.log('Resource paths passed from a different cwd: relative DB_FILE, uploads and logs.');
} finally {
    fs.rmSync(temp, { recursive: true, force: true });
}
