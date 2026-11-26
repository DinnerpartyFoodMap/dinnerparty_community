// 住民评论的前端纯逻辑：npm run test:comments / npm run test:rating（链尾）
// 与后端 POST /comments 的规整、长度（按码位）、读取过滤、显示拼接和入口判断保持一致。
import assert from 'node:assert/strict';
import { localeText } from '../../support/locale-text.mjs';
import {
    COMMENT_MAX_LENGTH,
    COMMENT_MIN_LENGTH,
    normalizeComment,
    commentLength,
    commentProblem,
    readPlaceComments,
    myComment,
    commentStatusNote,
    appendCommentsToDetail,
    canCommentOn
} from '../../../src/places/placeComments.js';

const results = [];
function check(name, fn) {
    try {
        fn();
        results.push({ name, ok: true });
    } catch (error) {
        results.push({ name, ok: false, error });
    }
}

check('normalizeComment folds all whitespace and trims', () => {
    assert.equal(normalizeComment('  a \n\t b   c  '), 'a b c');
    assert.equal(normalizeComment('\u3000a\u3000b\u3000'), 'a b');
    assert.equal(normalizeComment('\n\n'), '');
    assert.equal(normalizeComment(null), '');
    assert.equal(normalizeComment(undefined), '');
    assert.equal(normalizeComment(42), '42');
    assert.equal(commentLength('😀😀'), 2, 'emoji count as one code point');
    assert.equal(commentLength('好 好'), 3);
});

check('commentProblem enforces 2 non-space characters and 200 code points', () => {
    assert.equal(COMMENT_MIN_LENGTH, 2);
    assert.equal(COMMENT_MAX_LENGTH, 200);
    assert.equal(commentProblem(' a '), 'short');
    assert.equal(commentProblem('  '), 'short');
    assert.equal(commentProblem(null), 'short');
    assert.equal(commentProblem('a b'), null, 'whitespace does not count toward the minimum');
    assert.equal(commentProblem('a\tb'), null);
    assert.equal(commentProblem('a'.repeat(200)), null);
    assert.equal(commentProblem('a'.repeat(201)), 'long');
    assert.equal(commentProblem(`  ${'a'.repeat(200)}  `), null, 'trimming happens first');
    assert.equal(commentProblem('😀'.repeat(200)), null);
    assert.equal(commentProblem('😀'.repeat(201)), 'long');
    assert.equal(commentProblem('a' + ' '.repeat(300) + 'b'), null, 'a whitespace run folds to one space');
});

check('readPlaceComments validates the array, filters empty content and normalizes fields', () => {
    assert.equal(readPlaceComments(null), null);
    assert.equal(readPlaceComments(undefined), null);
    assert.equal(readPlaceComments('not an array'), null);
    assert.equal(readPlaceComments({}), null);
    assert.equal(readPlaceComments(0), null);

    const anonymous = localeText('map:placeComments.anonymous');
    const rows = readPlaceComments([
        { id: 1, user_id: 'u1', username: ' alice ', content: '  好吃\n 很香 ', status: 'pending', mine: true },
        { id: 2, user_id: 'u2', username: '   ', content: '好', status: 'weird', mine: 1 },
        { id: 3, user_id: 'u3', username: 'bob', content: '   ', status: 'visible', mine: true },
        { id: 4, user_id: 'u4', username: 'carol', content: 42, status: 'visible' },
        null,
        { id: 6, user_id: 'u6', username: 'dave', content: 'ok', status: 'rejected', mine: 'true' }
    ]);
    assert.deepEqual(rows, [
        { id: 1, userId: 'u1', username: 'alice', content: '好吃 很香', status: 'pending', mine: true },
        { id: 2, userId: 'u2', username: anonymous, content: '好', status: 'visible', mine: false },
        { id: 6, userId: 'u6', username: 'dave', content: 'ok', status: 'rejected', mine: false }
    ]);
    assert.equal(readPlaceComments([]).length, 0);
});

check('myComment returns the mine entry, or null', () => {
    const list = [
        { id: 1, mine: false },
        { id: 2, mine: true },
        { id: 3, mine: true }
    ];
    assert.equal(myComment(list), list[1]);
    assert.equal(myComment([{ id: 1, mine: false }]), null);
    assert.equal(myComment([]), null);
    assert.equal(myComment(null), null);
    assert.equal(myComment(undefined), null);
    assert.equal(myComment('not an array'), null);
});

check('commentStatusNote only annotates the viewer\'s own unpublished comment', () => {
    const reviewing = localeText('map:placeComments.status.reviewing');
    const rejected = localeText('map:placeComments.status.rejected');
    assert.equal(commentStatusNote({ mine: true, status: 'checking' }), reviewing);
    assert.equal(commentStatusNote({ mine: true, status: 'pending' }), reviewing);
    assert.equal(commentStatusNote({ mine: true, status: 'rejected' }), rejected);
    assert.equal(commentStatusNote({ mine: true, status: 'visible' }), '');
    assert.equal(commentStatusNote({ mine: false, status: 'checking' }), '');
    assert.equal(commentStatusNote({ mine: false, status: 'rejected' }), '');
    assert.equal(commentStatusNote(null), '');
    assert.equal(commentStatusNote({ mine: true, status: 'unknown' }), '');
});

check('appendCommentsToDetail returns the original text when there are no comments', () => {
    assert.deepEqual(
        appendCommentsToDetail({ plain: '描述', markdown: '**描述**', comments: [] }),
        { plain: '描述', markdown: '**描述**' }
    );
    assert.deepEqual(
        appendCommentsToDetail({ plain: '描述', markdown: '**描述**', comments: null }),
        { plain: '描述', markdown: '**描述**' }
    );
    assert.deepEqual(
        appendCommentsToDetail({ plain: '', markdown: '', comments: undefined }),
        { plain: '', markdown: '' }
    );
});

check('appendCommentsToDetail appends one comment per line with the name/content format', () => {
    const comments = [
        { id: 1, username: 'alice', content: '很香', status: 'visible', mine: false },
        { id: 2, username: 'bob', content: '一般', status: 'visible', mine: true }
    ];
    const aliceLine = localeText('map:placeComments.line', { username: 'alice', content: '很香' });
    const bobLine = localeText('map:placeComments.line', { username: 'bob', content: '一般' });
    const result = appendCommentsToDetail({ plain: '描述', markdown: '**描述**', comments });
    assert.equal(result.plain, `描述\n\n${aliceLine}\n${bobLine}`);
    assert.ok(result.markdown.startsWith('**描述**\n\n'), 'a provided markdown description is preserved');
    assert.ok(result.markdown.includes(aliceLine.replace('[', '\\[').replace(']', '\\]')));
    assert.ok(result.markdown.includes(bobLine.replace('[', '\\[').replace(']', '\\]')));
});

check('appendCommentsToDetail uses 暂无描述 and notes checking/rejected own comments', () => {
    const noDescription = localeText('map:placeDetail.noDescription');
    const own = { username: 'alice', content: '审核中的评论', status: 'checking', mine: true };
    const line = localeText('map:placeComments.line', { username: 'alice', content: '审核中的评论' });
    const reviewing = localeText('map:placeComments.status.reviewing');
    const wrap = localeText('map:placeComments.status.wrap', { note: reviewing });
    const result = appendCommentsToDetail({ plain: '', markdown: '', comments: [own] });
    assert.ok(result.plain.startsWith(`${noDescription}\n\n`));
    assert.ok(result.plain.endsWith(`${line} ${wrap}`));
    assert.ok(result.markdown.startsWith(`${noDescription}\n\n`), 'the fallback description is escaped as inline markdown');
    assert.ok(!result.markdown.includes(localeText('map:placeComments.status.rejected')));
});

check('appendCommentsToDetail escapes Markdown characters in comments only', () => {
    const content = 'x*y_z[w]`v<u\\v';
    const result = appendCommentsToDetail({
        plain: '描述', markdown: '描述',
        comments: [{ username: 'user', content, status: 'visible', mine: false }]
    });
    const escaped = 'x\\*y\\_z\\[w\\]\\`v\\<u\\\\v';
    assert.ok(result.markdown.includes(escaped), result.markdown);
    assert.ok(result.plain.includes(content), 'the plain text keeps the original characters');
    assert.ok(!result.plain.includes('\\*'));
});

check('appendCommentsToDetail falls back to the escaped plain description for markdown', () => {
    const result = appendCommentsToDetail({
        plain: 'a*b',
        comments: [{ username: 'user', content: '评论', status: 'visible', mine: false }]
    });
    assert.ok(result.markdown.startsWith('a\\*b\n\n'));
});

check('appendCommentsToDetail stays within the limits and reports how many comments were omitted', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
        id: index,
        username: `u${index}`,
        content: '评论内容'.repeat(5),
        status: 'visible',
        mine: false
    }));
    const result = appendCommentsToDetail({
        plain: '描述', markdown: '描述', comments: many, plainLimit: 160, markdownLimit: 220
    });
    assert.ok(result.plain.length <= 160, `plain length ${result.plain.length}`);
    assert.ok(result.markdown.length <= 220, `markdown length ${result.markdown.length}`);
    const lines = result.plain.split('\n');
    const moreLine = lines.at(-1);
    const moreTemplate = localeText('map:placeComments.more', { count: 7 });
    const moreRegex = new RegExp(`^${moreTemplate.replace('7', '(\\d+)')}$`);
    const match = moreRegex.exec(moreLine || '');
    assert.ok(match, `last line is the omitted count: ${moreLine}`);
    const remaining = Number(match[1]);
    const shown = lines.filter((line) => /^u\d+：/.test(line)).length;
    assert.ok(shown > 0, 'at least one comment fits');
    assert.ok(remaining > 0, 'some comments are omitted');
    assert.equal(shown + remaining, many.length);
    assert.ok(result.markdown.trimEnd().endsWith(moreLine.replace(/[\\`*_[\]<]/g, '\\$&')));
});

check('canCommentOn accepts only visible, marked, non-exhibition places', () => {
    assert.equal(canCommentOn(null), false);
    assert.equal(canCommentOn(undefined), false);
    assert.equal(canCommentOn({}), true, 'legacy rows without moderation_status stay commentable');
    assert.equal(canCommentOn({ moderation_status: 'visible' }), true);
    for (const status of ['checking', 'pending', 'rejected']) {
        assert.equal(canCommentOn({ moderation_status: status }), false, status);
    }
    assert.equal(canCommentOn({ isMarked: false }), false);
    assert.equal(canCommentOn({ isMarked: true }), true);
    assert.equal(canCommentOn({ exhibitionVenue: { name: '同人展' } }), false);
    assert.equal(canCommentOn({ exhibitionVenue: null }), true);
    assert.equal(canCommentOn({ moderation_status: 'checking', isMarked: false }), false);
    assert.equal(canCommentOn({ moderation_status: 'visible', exhibitionVenue: {} }), false);
    assert.equal(canCommentOn({ moderation_status: 'visible', isMarked: false, exhibitionVenue: {} }), false);
});

const failed = results.filter((result) => !result.ok);
console.log(`place comment frontend tests: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
    console.error(`${failed.length} failed:`);
    for (const result of failed) {
        console.error(`FAIL ${result.name}`);
        console.error(result.error && result.error.stack ? result.error.stack : String(result.error));
    }
    process.exitCode = 1;
} else {
    console.log('place comment frontend tests passed: normalization, limits, reading, status notes, detail appending, escaping and entry rules.');
}
