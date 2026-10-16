// Static dependency checks never import the database or start workers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const skip = new Set(['node_modules', 'uploads', 'logs', '.vscode']);
function walk(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        if (skip.has(entry.name)) return [];
        const file = path.join(directory, entry.name);
        return entry.isDirectory() ? walk(file) : [file];
    });
}
const sources = walk(root).filter(file => file.endsWith('.js'));
for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, request] of source.matchAll(/require(?:\.resolve)?\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
        assert.doesNotThrow(() => createRequire(file).resolve(request), `${path.relative(root, file)} -> ${request}`);
    }
}
for (const group of fs.readdirSync(path.join(root, 'modules'))) {
    assert.ok(fs.existsSync(path.join(root, 'modules', group, 'doc', 'README.md')), `${group} needs an entry document`);
}
const { BACKEND_ROOT, backendPath } = require('../../infrastructure/paths');
assert.equal(BACKEND_ROOT, root);
assert.equal(backendPath('data.sqlite'), path.join(root, 'data.sqlite'));
assert.equal(backendPath('seeds', 'categories.json'), path.join(root, 'seeds', 'categories.json'));
assert.equal(backendPath('.env'), path.join(root, '.env'));
for (const file of ['database.js', 'logger.js']) {
    assert.match(fs.readFileSync(path.join(root, 'infrastructure', file), 'utf8'), /backendPath|BACKEND_ROOT/);
}
const media = fs.readFileSync(path.join(root, 'modules/media/services/imageStorage.js'), 'utf8');
assert.match(media, /backendPath\('uploads'\)/);
// Relative documentation links are part of the navigable module contract.
for (const file of walk(root).filter(file => file.endsWith('.md'))) {
    for (const [, link] of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|#|mailto:)/.test(link)) continue;
        const target = link.split('#')[0];
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), target)), `${path.relative(root, file)} links to missing ${link}`);
    }
}
console.log(`Structure checks passed: ${sources.length} JS files, relative imports, module docs, resource roots and doc links.`);
