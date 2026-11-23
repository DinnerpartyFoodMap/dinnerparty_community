process.argv[2] = '/tests/integration/map-review-harness.js';
process.argv[3] = 'runReviewRegressionTests';
await import('./run-map-browser.mjs');
