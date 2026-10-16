import React, { useRef } from 'react';
import AuthPage from '../AuthPage';
import ResponsivePanel from "../../components/overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";

// 登录/登记：宽屏居中对话框，窄屏底部面板。返回键、Escape、点击遮罩都经由 AuthPage 的关闭逻辑（立即取消请求）。
export default function AuthModal({ open = true, backendUrl, onLoginSuccess, onClose }) {
    const closeRef = useRef(null);
    const requestClose = () => {
        if (closeRef.current) closeRef.current();
        else if (onClose) onClose();
    };

    return (
        <ResponsivePanel
            open={open}
            onClose={requestClose}
            label={t('auth:page.title')}
            kind="auth"
            desktop="center"
            mobile="sheet"
            width="min(420px, calc(100vw - 32px))"
            maxHeight="calc(100% - 32px)"
            plain
            showClose={false}
            bodyStyle={{ overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
        >
            <AuthPage backendUrl={backendUrl} onLoginSuccess={onLoginSuccess} onClose={onClose} closeRef={closeRef} />
        </ResponsivePanel>
    );
}
