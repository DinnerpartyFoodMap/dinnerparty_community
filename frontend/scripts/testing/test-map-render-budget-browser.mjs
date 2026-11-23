process.argv[2] = '/tests/integration/map-render-budget-harness.js';
process.argv[3] = 'runMapRenderTests';
await import('./run-map-browser.mjs');
