process.env.FOODMAP_TOUCH='1';
process.argv[2]='/tests/integration/map-touch-gesture-harness.js';
process.argv[3]='runTouchGestureTests';
await import('./run-map-browser.mjs');
