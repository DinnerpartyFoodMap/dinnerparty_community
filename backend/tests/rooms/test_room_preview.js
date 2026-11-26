// 观察屋命令行预览（RM-24）：只读打开快照，样本 / 剧情 / 城市 / 标签报告都能跑通。
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const SNAPSHOT = path.join(BACKEND, 'snapshot.sqlite');
if (!fs.existsSync(SNAPSHOT)) {
    console.log('room preview: backend/snapshot.sqlite 不存在，跳过预览测试');
    process.exit(0);
}

const failures = [];
function test(name, fn) {
    try {
        fn();
        console.log(`ok ${name}`);
    } catch (error) {
        failures.push(name);
        console.error(`not ok ${name}\n${error.stack || error}`);
    }
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-preview-test-'));
let runCounter = 0;

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 子进程的 stdout/stderr 写到文件描述符，避免在受限环境里用管道捕获输出。
function runNode(script, args) {
    runCounter += 1;
    const stdoutPath = path.join(workdir, `${runCounter}.stdout`);
    const stderrPath = path.join(workdir, `${runCounter}.stderr`);
    const stdoutFd = fs.openSync(stdoutPath, 'w');
    const stderrFd = fs.openSync(stderrPath, 'w');
    let result;
    try {
        result = spawnSync(process.execPath, [path.join(BACKEND, script), ...args], {
            cwd: BACKEND,
            stdio: ['ignore', stdoutFd, stderrFd],
            timeout: 120_000
        });
    } finally {
        fs.closeSync(stdoutFd);
        fs.closeSync(stderrFd);
    }
    return {
        status: result.status,
        signal: result.signal,
        error: result.error,
        stdout: fs.readFileSync(stdoutPath, 'utf8'),
        stderr: fs.readFileSync(stderrPath, 'utf8'),
        args
    };
}

const beforeHash = sha256(SNAPSHOT);
const sampleOut = path.join(workdir, 'sample.md');
const runs = {
    sample: runNode('scripts/rooms/preview_room.js', ['--sample', '3', '--days', '2', '--out', sampleOut]),
    pairs: runNode('scripts/rooms/preview_room.js', ['--pairs', '1']),
    city: runNode('scripts/rooms/preview_room.js', ['--city-report']),
    tags: runNode('scripts/rooms/tags_report.js', []),
    invalid: runNode('scripts/rooms/preview_room.js', ['--city-report', '--days', '2'])
};
const afterHash = sha256(SNAPSHOT);

function assertSuccess(run) {
    assert.equal(run.error, undefined, run.error?.message);
    assert.equal(run.status, 0, `${run.args.join(' ')} 退出码 ${run.status}\n${run.stderr || run.stdout}`);
}

test('预览命令 --sample / --pairs / --city-report / room:tags:report 都退出 0', () => {
    assertSuccess(runs.sample);
    assertSuccess(runs.pairs);
    assertSuccess(runs.city);
    assertSuccess(runs.tags);
});

test('--sample 3 --days 2 输出住民时间线，并写到 --out 文件', () => {
    const output = runs.sample.stdout;
    assert.match(output, /^# 观察屋时间线/m);
    assert.match(output, /^## .+ · \d{4}-\d{2}-\d{2}$/m);
    assert.match(output, /起床 \d{2}:\d{2} ｜ 睡觉 /);
    assert.match(output, /^\d{2}:\d{2}（\d+ 分钟） \[[a-z]+\]/m);
    assert.ok(output.length > 1000, '样本时间线太短');
    assert.ok(fs.existsSync(sampleOut), '--out 没有写出文件');
    assert.equal(fs.readFileSync(sampleOut, 'utf8'), output);
});

test('--pairs 1 输出拼桌或隔空剧情', () => {
    const output = runs.pairs.stdout;
    assert.match(output, /^# 观察屋同城剧情/m);
    assert.match(output, /^### (拼桌|隔空|熟悉度升级) · 熟悉度 \d · /m);
    assert.match(output, /^x 由 .+ 演，y 由 .+ 演/m);
    assert.match(output, /^\d{2}:\d{2}（\d+ 分钟）/m);
});

test('--city-report 输出城市统计表', () => {
    const output = runs.city.stdout;
    assert.match(output, /^# 观察屋城市统计/m);
    assert.match(output, /^\| 城市 \| 住民 \| 日均拼桌 \| 日均隔空 \| 日均有剧情 \|/m);
    assert.match(output, /\| [^|]+ \| \d+ \| \d+\.\d{2} \| \d+\.\d{2} \|/);
});

test('room:tags:report 输出标签推断和作息占比', () => {
    const output = runs.tags.stdout;
    assert.match(output, /^# 观察屋标签推断/m);
    assert.match(output, /有评价的住民 \d+ 人 ｜ 作息样本充足 \d+ 人/);
    assert.match(output, /^\| 标签 \| 人数 \|/m);
    assert.match(output, /^\| 占比 \| 夜间人数 \| 早晨人数 \|/m);
});

test('所有预览命令跑完后快照 sha256 不变', () => {
    assert.equal(afterHash, beforeHash, 'snapshot.sqlite 被改动了');
});

test('非法预览参数以非零退出', () => {
    assert.notEqual(runs.invalid.status, 0, '非法参数不应退出 0');
    assert.match(runs.invalid.stderr, /不接受 --days/);
});

fs.rmSync(workdir, { recursive: true, force: true });
if (failures.length) {
    console.error(`\ntest_room_preview: ${failures.length} 个用例失败`);
    process.exitCode = 1;
} else {
    console.log('\ntest_room_preview: all passed');
}
