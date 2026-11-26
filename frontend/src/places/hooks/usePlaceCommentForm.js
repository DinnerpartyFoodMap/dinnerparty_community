import { useState } from 'react';
import * as Api from '../../api/client';
import { t } from '../../i18n/index.js';
import { commentProblem, commentProblemText, normalizeComment } from '../placeComments';
import { ratingFailureText } from '../ratingActions';

/**
 * 评论表单（复用编辑地点的面板：网页 ManagePanel 的评论模式、iOS 原生地点表单的 comment 模式）。
 * 只有评论和评价两项：打开时预填自己已有的评论和评价；评价必填。
 * 提交时评价有变化先走原有评价接口（单票与每日配额照旧），再提交评论；评论先经初筛，公开前只有自己看得到。
 *   place：当前地点；comments：usePlaceComments 的结果；rating：usePlaceRating 的结果；myScore：自己当前的评价
 *   notify(text, tone)：结果提示（网页 toast）；confirm：网页删除前的确认框（useConfirm）
 * submit / remove 返回 { ok, message }，原生表单把 message 显示在自己的提示框里。
 */
export default function usePlaceCommentForm({ backendUrl, token, place, comments, rating, myScore, notify, confirm }) {
    const [form, setForm] = useState(null);
    const placeId = place && place.isMarked !== false ? place.id : null;
    const open = !!form && form.placeId === placeId && form.token === token;
    const mine = comments.mine;

    const openForm = () => {
        if (placeId == null) return;
        setForm({
            placeId,
            token,
            content: mine?.content || '',
            rating: Number.isInteger(myScore) ? myScore : null,
            commentId: mine?.id ?? null,
            status: mine?.status || null,
            submitting: false,
            message: ''
        });
    };
    const close = () => setForm(null);
    const update = (patch) => setForm((current) => (current ? { ...current, ...patch } : current));

    const fail = (message) => {
        update({ submitting: false, message });
        return { ok: false, message };
    };

    // values 缺省为网页表单的草稿；iOS 原生表单传入 { content, rating }
    const submit = async (values) => {
        if (!open || form.submitting) return { ok: false, message: '' };
        const content = normalizeComment(values ? values.content : form.content);
        const score = values ? values.rating : form.rating;
        const problem = commentProblem(content);
        if (problem) return fail(commentProblemText(problem));
        if (!Number.isInteger(score) || score < 1 || score > 4) return fail(t('map:placeComments.form.ratingRequired'));
        update({ content, rating: score, submitting: true, message: '' });
        if (score !== myScore) {
            try {
                await rating.submit(score);
            } catch (error) {
                if (error?.status === 429) rating.reload();
                return fail(ratingFailureText(error));
            }
        }
        let saved;
        try {
            saved = await Api.savePlaceComment(backendUrl, token, placeId, content);
        } catch (error) {
            return fail(t('map:placeComments.form.failed', { message: error.message || error }));
        }
        setForm(null);
        await comments.reload();
        notify?.(saved?.comment?.status === 'visible' ? t('map:placeComments.form.published') : t('map:placeComments.form.submitted'), 'success');
        return { ok: true };
    };

    // 网页先确认（confirmFirst）；iOS 原生表单已经自己确认过
    const remove = async ({ confirmFirst = false } = {}) => {
        if (!open || form.submitting || form.commentId == null) return { ok: false, message: '' };
        if (confirmFirst && confirm && !(await confirm(t('map:placeComments.form.deleteTitle'), { destructive: true, confirmLabel: t('common:action.delete') }))) {
            return { ok: false, message: '' };
        }
        update({ submitting: true, message: '' });
        try {
            await Api.deletePlaceComment(backendUrl, token, form.commentId);
        } catch (error) {
            return fail(t('map:placeComments.form.deleteFailed', { message: error.message || error }));
        }
        setForm(null);
        await comments.reload();
        notify?.(t('map:placeComments.form.deleted'), 'success');
        return { ok: true };
    };

    return {
        open,
        form: open ? form : null,
        openForm,
        close,
        setContent: (content) => update({ content, message: '' }),
        setRating: (score) => update({ rating: score, message: '' }),
        submit,
        remove
    };
}
