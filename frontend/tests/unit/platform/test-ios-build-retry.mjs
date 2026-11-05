import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const tempRoot = os.tmpdir();
const work = mkdtempSync(path.join(tempRoot, 'foodmap-ios-retry-'));
const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const command = `
xcodebuild() {
    count=0
    if [ -f "$TEST_STATE_DIR/count" ]; then count=$(cat "$TEST_STATE_DIR/count"); fi
    count=$((count + 1))
    printf '%s' "$count" > "$TEST_STATE_DIR/count"
    if [ "$#" -ne 3 ] || [ "$2" != 'App With Spaces.xcodeproj' ]; then return 99; fi
    case "$TEST_FAILURE_MODE" in
        transient) if [ "$count" -gt 1 ]; then echo '** BUILD SUCCEEDED **'; return 0; fi ;;
        compile) echo 'NativePlaceFormPlugin.swift: error: cannot find value in scope'; return 65 ;;
        checksum) echo 'error: Could not resolve package dependencies: checksum mismatch'; return 74 ;;
    esac
    echo "error: failed downloading Cordova.xcframework.zip: badResponseStatusCode(504)"
    return 74
}
sleep() { :; }
export -f xcodebuild sleep
bash scripts/ci/ios-xcodebuild.sh -project 'App With Spaces.xcodeproj' build
`;

try {
    for (const [mode, expectedStatus, expectedAttempts] of [
        ['transient', 0, 2], ['persistent', 74, 3], ['compile', 65, 1], ['checksum', 74, 1]
    ]) {
        rmSync(path.join(work, 'count'), { force: true });
        const log = path.join(work, `${mode}.log`);
        const result = spawnSync(bash, ['-c', command], {
            cwd: root,
            env: { ...process.env, TEST_STATE_DIR: work, TEST_FAILURE_MODE: mode, XCODEBUILD_LOG: log },
            encoding: 'utf8', timeout: 10000
        });
        assert.ifError(result.error);
        assert.equal(result.status, expectedStatus, `${mode}: ${result.stdout}\n${result.stderr}`);
        assert.equal(Number(readFileSync(path.join(work, 'count'), 'utf8')), expectedAttempts, mode);
        const output = readFileSync(log, 'utf8');
        assert.ok(output.includes(mode === 'compile' ? 'cannot find value' : mode === 'checksum' ? 'checksum mismatch' : 'badResponseStatusCode(504)'), `${mode} preserves diagnostics`);
        if (mode === 'transient') assert.ok(output.includes('BUILD SUCCEEDED'), 'preserves both failed and successful attempt logs');
    }
} finally {
    assert.equal(path.dirname(path.resolve(work)), path.resolve(tempRoot));
    rmSync(work, { recursive: true, force: true });
}

console.log('iOS build retry passed: transient recovery, bounded retries, compiler and checksum failures, quoted arguments and logs.');
