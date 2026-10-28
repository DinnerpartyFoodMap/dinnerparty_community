// Windows source contracts only: these checks do not compile Swift or verify UIKit rendering.
// --baseline checks the committed sources to confirm that the regression guards catch the old code.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const baseline = process.argv.includes('--baseline');
const read = (name) => {
    const path = `frontend/ios/App/App/${name}.swift`;
    return baseline ? execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })
        : readFileSync(new URL(path, new URL('../../../../', import.meta.url)), 'utf8');
};
const between = (source, start, end) => {
    const from = source.indexOf(start);
    assert.ok(from >= 0, `Missing native source boundary: ${start}`);
    const to = source.indexOf(end, from + start.length);
    assert.ok(to > from, `Missing native source boundary: ${end}`);
    return source.slice(from, to);
};

const bridge = read('FoodMapBridgeViewController');
const gesture = between(bridge, '@objc private func handleEdgeBack(', 'private func flushEdgeBackProgress()');
const began = between(gesture, 'case .began:', 'case .changed:');
const ended = between(gesture, 'case .ended:', 'case .cancelled, .failed:');
const cancel = between(bridge, 'private func cancelEdgeBackProgress()', 'private func emitEdgeBackProgress(');
const flush = between(bridge, 'private func flushEdgeBackProgress()', 'private func stopEdgeBackFrames()');

// A canceled/disabled gesture must not fall through to the legacy committed-back event.
assert.match(began, /edgeBackTrackingProtocol\s*=\s*edgeBackInteractive\s*\?\s*\.progress\s*:\s*\.legacy/);
assert.match(ended, /guard let mode = edgeBackTrackingProtocol else\s*\{\s*return\s*\}/);
assert.doesNotMatch(ended, /edgeBackInteractive/);
assert.match(cancel, /edgeBackTrackingProtocol\s*=\s*nil/);
assert.match(ended, /if mode == \.progress[\s\S]*emitEdgeBackProgress\("end"[\s\S]*else if committed/);

// Progress is opt-in, frame-coalesced, bounded to one in-flight evaluation, and final samples bypass that queue.
assert.match(bridge, /body\["interactive"\]\s+as\?\s+Bool/);
assert.match(gesture, /CADisplayLink\(/);
assert.match(began, /emitEdgeBackProgress\("begin"/);
assert.match(cancel, /emitEdgeBackProgress\("cancel"/);
assert.match(ended, /emitEdgeBackProgress\("end", sample: sample, committed: committed\)/);
assert.match(flush, /edgeBackChangeInFlightGeneration == nil/);
assert.match(flush, /self\.edgeBackChangeInFlightGeneration == generation else\s*\{\s*return\s*\}/);

const settings = read('NativeSettingsPlugin');
const settingsGesture = between(settings, '@objc private func edgeBack(', '/// 自定义导航式呈现');
const cancelledDismissal = between(settings, 'self.screenTransition.onDismissalEnd =', 'let root = NativeSettingsView');
const completedDismissal = between(settings, 'let complete = { [weak self] in', '// 从父控制器关闭整个设置页');

// A canceled interactive dismissal must preserve the current form/session and invalidate its stale completion.
assert.match(settingsGesture, /case \.began:[\s\S]*UIPercentDrivenInteractiveTransition\(/);
assert.match(settingsGesture, /case \.changed:[\s\S]*\.update\(progress\)/);
assert.match(settingsGesture, /interaction\.finish\(\)[\s\S]*interaction\.cancel\(\)/);
assert.match(settings, /func interactionControllerForDismissal\(/);
assert.match(settings, /override var shouldRemovePresentersView: Bool\s*\{\s*false\s*\}/);
assert.match(cancelledDismissal, /guard !completed else\s*\{\s*return\s*\}/);
assert.match(cancelledDismissal, /finishGeneration\s*\+=\s*1/);
assert.doesNotMatch(cancelledDismissal, /(?:host|store|pending)\s*=\s*nil|call\?\.resolve/);
assert.match(completedDismissal, /self\.finishGeneration == generation/);
assert.match(completedDismissal, /host\.presentingViewController == nil else\s*\{\s*return\s*\}/);

// Existing feedback/place form sheets keep UIKit's native downward interactive dismissal.
for (const name of ['NativeFeedbackPlugin', 'NativePlaceFormPlugin']) {
    const source = read(name);
    assert.match(source, /modalPresentationStyle = \.pageSheet/);
    assert.doesNotMatch(source, /UIScreenEdgePanGestureRecognizer/);
}

console.log('Native edge-back source contracts passed (static only; Swift not compiled).');
