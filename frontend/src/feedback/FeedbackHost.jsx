import React from 'react';
import { useTips } from "../components/feedback/Tips";
import FeedbackPanel from "./FeedbackPanel";
import useNativeFeedback from "./useNativeFeedback";
import { t } from "../i18n/index.js";

// 意见反馈入口的落点：iOS App 呈现原生 SwiftUI 反馈页，其他平台（以及原生打不开时）显示网页面板。
export default function FeedbackHost({ open, onClose, backendUrl, token, onRequireAuth }) {
    const showTip = useTips();
    const native = useNativeFeedback({
        open, backendUrl, token,
        onClose: (action) => {
            if (action === 'submitted') showTip(t('feedback:submitted'));
            onClose?.(action);
        }
    });
    return <FeedbackPanel open={open && !native} onClose={onClose} backendUrl={backendUrl} token={token} onRequireAuth={onRequireAuth} />;
}
