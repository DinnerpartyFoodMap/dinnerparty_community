process.argv[2] = '/tests/integration/map-compute-harness.js';
process.argv[3] = 'runMapComputeTests';
await import('./run-map-browser.mjs');
