// Wheel zoom by default; `touch` runs the same check with trusted two-finger pinches.
if (process.argv[2] === 'touch') process.env.FOODMAP_TOUCH = '1';
process.argv[2]='/tests/integration/map-zoom-flicker-harness.js';
process.argv[3]='runZoomFlickerTests';
await import('./run-map-browser.mjs');
