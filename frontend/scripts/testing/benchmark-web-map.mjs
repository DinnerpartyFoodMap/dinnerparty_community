process.argv[2] = process.argv.includes('--real') ? '/tests/integration/map-amap-harness.js' : '/tests/integration/map-compute-harness.js';
process.argv[3] = process.argv[2].includes('amap') ? 'runAmapBenchmark' : 'runMapComputeTests';
await import('./run-map-browser.mjs');
