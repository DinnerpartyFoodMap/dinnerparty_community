// 住民评论：每人每店一条，与地点描述分开保存（后端 Comment 表 source='resident'），
// 显示时按「住民名：评论」接在描述末尾。新评论先经 AI 初筛，明显违规的交管理员复核（backend placeModeration.md）。
// 内容按纯文本处理：换行和连续空白折成一个空格，与后端 POST /comments 的规整一致。
import { t } from '../i18n/index.js';
import { escapeNativeInline } from '../components/markdown/markdownText.js';

export const COMMENT_MAX_LENGTH = 200;
export const COMMENT_MIN_LENGTH = 2;
const STATUSES = new Set(['visible', 'checking', 'pending', 'rejected']);

export function normalizeComment(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** 规整后的字数（按码位，emoji 算一个，与后端相同） */
export function commentLength(value) {
    return Array.from(normalizeComment(value)).length;
}

/** 不能提交的原因：'short' | 'long' | null */
export function commentProblem(value) {
    const text = normalizeComment(value);
    if (Array.from(text.replace(/\s/g, '')).length < COMMENT_MIN_LENGTH) return 'short';
    if (Array.from(text).length > COMMENT_MAX_LENGTH) return 'long';
    return null;
}

export function commentProblemText(problem) {
    if (problem === 'short') return t('map:placeComments.form.tooShort', { min: COMMENT_MIN_LENGTH });
    if (problem === 'long') return t('map:placeComments.form.tooLong', { max: COMMENT_MAX_LENGTH });
    return '';
}

/** GET /places/:id 的 comments → 显示用的列表；不是数组时返回 null（这份地点数据不带评论） */
export function readPlaceComments(value) {
    if (!Array.isArray(value)) return null;
    return value
        .filter((item) => item && typeof item.content === 'string' && normalizeComment(item.content))
        .map((item) => ({
            id: item.id,
            userId: item.user_id,
            username: String(item.username || '').trim() || t('map:placeComments.anonymous'),
            content: normalizeComment(item.content),
            status: STATUSES.has(item.status) ? item.status : 'visible',
            mine: item.mine === true
        }));
}

export const myComment = (comments) => (Array.isArray(comments) ? comments.find((item) => item.mine) || null : null);

/** 自己那条还没公开时的小字：审核中 / 未通过审核 */
export function commentStatusNote(comment) {
    if (!comment?.mine) return '';
    if (comment.status === 'checking' || comment.status === 'pending') return t('map:placeComments.status.reviewing');
    if (comment.status === 'rejected') return t('map:placeComments.status.rejected');
    return '';
}

/** 一条评论的显示文字：「住民名：评论」 */
export function commentLine(comment) {
    return t('map:placeComments.line', { username: comment.username, content: comment.content });
}

function commentLineWithNote(comment) {
    const note = commentStatusNote(comment);
    return note ? `${commentLine(comment)} ${t('map:placeComments.status.wrap', { note })}` : commentLine(comment);
}

/**
 * iOS 原生卡片的简介：描述后接评论，纯文本（detail）与行内 Markdown（detailMarkdown）各一份。
 * 原生端分别截到 2000 / 4000 字，评论只放得下的部分，放不下时最后一行说明还有几条。
 */
export function appendCommentsToDetail({ plain, markdown, comments, plainLimit = 2000, markdownLimit = 4000 }) {
    const list = Array.isArray(comments) ? comments : [];
    if (!list.length) return { plain: plain || '', markdown: markdown || '' };
    const basePlain = plain || t('map:placeDetail.noDescription');
    const baseMarkdown = markdown || escapeNativeInline(basePlain);
    let plainText = basePlain;
    let markdownText = baseMarkdown;
    let shown = 0;
    for (const comment of list) {
        const line = commentLineWithNote(comment);
        const nextPlain = `${plainText}${shown ? '\n' : '\n\n'}${line}`;
        const nextMarkdown = `${markdownText}${shown ? '\n' : '\n\n'}${escapeNativeInline(line)}`;
        // 给“还有 N 条”留出位置
        if (nextPlain.length > plainLimit - 40 || nextMarkdown.length > markdownLimit - 40) break;
        plainText = nextPlain;
        markdownText = nextMarkdown;
        shown += 1;
    }
    if (shown < list.length) {
        const more = t('map:placeComments.more', { count: list.length - shown });
        plainText = `${plainText}${shown ? '\n' : '\n\n'}${more}`;
        markdownText = `${markdownText}${shown ? '\n' : '\n\n'}${escapeNativeInline(more)}`;
    }
    return { plain: plainText, markdown: markdownText };
}

/** 评论入口的文字：没写过是“写评论”，写过是“修改我的评论” */
export function commentEntryLabel(comments) {
    return myComment(comments) ? t('map:placeComments.editMine') : t('map:placeComments.write');
}

/** 能不能在这家店写评论：收录了的公开地点（新增审核中、未通过的地点后端不接受评论） */
export function canCommentOn(place) {
    return !!place && place.isMarked !== false && !place.exhibitionVenue
        && (!place.moderation_status || place.moderation_status === 'visible');
}
