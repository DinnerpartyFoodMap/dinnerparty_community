import React, { useState } from "react";
import { useAuth } from "../AuthContext";
import Notice from "../../components/feedback/Notice";
import { t, tx } from "../../i18n/index.js";

export default function BanNotice({ canClose = true, style }) {
    const { user } = useAuth();
    const [visible, setVisible] = useState(true);
    if (!visible) return null;
    if (!user || !user.is_banned) return null;
    const reason = user.ban_reason || t('auth:banNotice.noReason');
    const expires = user.ban_expires ? (new Date(user.ban_expires)).toLocaleString() : t('auth:banNotice.permanent');

    // 封禁通知强制不可关闭
    const closable = Boolean(canClose) && !user.is_banned;

    return (
        <Notice
            title={t('auth:banNotice.title')}
            tone="danger"
            canClose={closable}
            onClose={() => setVisible(false)}
            zIndex={9999}
            style={style}
        >
            <div style={{ fontSize: 13, marginTop: 6 }}>{tx('auth:banNotice.detail', { reason, expires })}</div>
            <div style={{ fontSize: 13, marginTop: 6 }}>{t('auth:banNotice.hint')}</div>
        </Notice>
    );
}
