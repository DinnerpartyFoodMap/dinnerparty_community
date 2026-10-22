import React from 'react';
import { useTips } from "../components/feedback/Tips";
import FeedbackPanel from "./FeedbackPanel";
import useNativeFeedback from "./useNativeFeedback";
import { t } from "../i18n/index.js";

// 意见反馈入口的落点：iOS App 呈现原生 SwiftUI 反馈页，其他平台（以及原生打不开时）显示网页面板。
// prefill 预填一部分表单（地点举报），两边都支持。
export default function FeedbackHost({ open, onClose, backendUrl, token, onRequireAuth, prefill = null }) {
    const showTip = useTips();
    const native = useNativeFeedback({
        open, backendUrl, token, prefill,
        onClose: (action) => {
            if (action === 'submitted') showTip(t('feedback:submitted'));
            onClose?.(action);
        }
    });
    return <FeedbackPanel open={open && !native} onClose={onClose} backendUrl={backendUrl} token={token} onRequireAuth={onRequireAuth} prefill={prefill} />;
}
