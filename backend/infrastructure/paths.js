const path = require('node:path');

// Runtime data belongs to backend/, independently of source-file nesting or cwd.
const BACKEND_ROOT = path.resolve(__dirname, '..');
const backendPath = (...segments) => path.resolve(BACKEND_ROOT, ...segments);

module.exports = { BACKEND_ROOT, backendPath };
