import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const repo = path.resolve(root, '..');
function walk(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        if (['node_modules', 'dist', '.git', 'android', 'ios'].includes(entry.name)) return [];
        const file = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(file) : [file];
    });
}
function resolve(file, request) {
    const target = path.resolve(path.dirname(file), request.split('?')[0]);
    return [target, ...['.js', '.jsx', '.mjs', '/index.js', '/index.jsx'].map(ext => target + ext)]
        .find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}
const files = walk(root);
const sources = files.filter(file => /\.(jsx?|mjs)$/.test(file));
let imports = 0;
for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    const ast = parse(source, { sourceType: 'unambiguous', plugins: ['jsx'] });
    function check(node) {
        if (node?.type !== 'StringLiteral' || !node.value.startsWith('.')) return;
        imports++;
        assert.ok(resolve(file, node.value), `${path.relative(root, file)} -> ${node.value}`);
    }
    (function visit(node) {
        if (!node || typeof node.type !== 'string') return;
        if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)) check(node.source);
        if (node.type === 'ImportExpression') check(node.source);
        if (node.type === 'CallExpression' && node.callee.type === 'Import') check(node.arguments[0]);
        for (const value of Object.values(node)) {
            if (Array.isArray(value)) value.forEach(visit);
            else if (value && typeof value === 'object') visit(value);
        }
    })(ast);
}
for (const entry of fs.readdirSync(path.join(root, 'src'), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'img') continue;
    assert.ok(fs.existsSync(path.join(root, 'src', entry.name, 'doc', 'README.md')), `${entry.name} needs a module entry document`);
}
for (const file of files.filter(file => file.endsWith('.md'))) {
    for (const [, link] of fs.readFileSync(file, 'utf8').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        if (/^(?:https?:|#|mailto:)/.test(link)) continue;
        assert.ok(fs.existsSync(path.resolve(path.dirname(file), link.split('#')[0])), `${path.relative(root, file)} -> ${link}`);
    }
}
for (const [backend, harness] of [['journeys/test_journey_ui.js', 'journey-harness.jsx'], ['places/test_place_location_ui.js', 'place-location-harness.jsx']]) {
    const source = fs.readFileSync(path.join(repo, 'backend/tests', backend), 'utf8');
    const url = `/tests/integration/${harness}`;
    assert.ok(source.includes(url), `backend ${backend} must serve ${url}`);
    assert.ok(fs.existsSync(path.join(root, url)));
}
assert.ok(fs.readFileSync(path.join(root, 'index.html'), 'utf8').includes('/src/main.jsx'));
assert.ok(fs.existsSync(path.join(root, 'scripts/support/json-hooks.mjs')), 'backend tests use the stable JSON loader entry');
console.log(`Frontend structure passed: ${sources.length} parsed sources, ${imports} relative imports, module docs, links and integration entries.`);
