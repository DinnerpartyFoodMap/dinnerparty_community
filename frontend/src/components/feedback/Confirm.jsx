import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import Button from "../primitives/Button";
import ResponsivePanel from "../overlay/ResponsivePanel";
import { t } from "../../i18n/index.js";

const ConfirmContext = createContext(null);

// 短确认在所有布局下都保留居中提示框；返回键、Escape 与点击遮罩等同于“取消”（设计参考 11.6）。
// confirm(message, { destructive, confirmLabel })：会删除、下架、撤销、丢弃的操作传 destructive，确认按钮显示为危险色；
// confirmLabel 写动作本身（「删除」「移除」），不传时为「确认」。
export function ConfirmProvider({ children }) {
    const [confirmState, setConfirmState] = useState(null);
    const [open, setOpen] = useState(false);
    const settledRef = useRef(false);

    const confirm = useCallback((message, options = {}) => {
        return new Promise((resolve) => {
            settledRef.current = false;
            const settle = (value) => {
                if (settledRef.current) return;
                settledRef.current = true;
                setOpen(false);
                resolve(value);
            };
            setConfirmState({
                message,
                destructive: !!options.destructive,
                confirmLabel: options.confirmLabel,
                onConfirm: () => settle(true),
                onCancel: () => settle(false)
            });
            setOpen(true);
        });
    }, []);

    return (
        <ConfirmContext.Provider value={confirm}>
            {children}
            <ResponsivePanel
                open={open && !!confirmState}
                onClose={() => confirmState && confirmState.onCancel()}
                label={t('common:confirm.title')}
                kind="confirm"
                role="alertdialog"
                desktop="center"
                mobile="center"
                width="min(400px, 90vw)"
                plain
                showClose={false}
                bodyStyle={{ padding: 24 }}
            >
                {confirmState && (
                    <>
                        <div style={{ fontSize: 16, lineHeight: 1.6, marginBottom: 24, whiteSpace: 'pre-line' }}>{confirmState.message}</div>
                        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
                            <Button variant="secondary" onClick={confirmState.onCancel}>{t('common:action.cancel')}</Button>
                            <Button variant={confirmState.destructive ? 'destructive' : 'primary'} onClick={confirmState.onConfirm}>
                                {confirmState.confirmLabel || t('common:confirm.confirm')}
                            </Button>
                        </div>
                    </>
                )}
            </ResponsivePanel>
        </ConfirmContext.Provider>
    );
}

export function useConfirm() {
    return useContext(ConfirmContext);
}
