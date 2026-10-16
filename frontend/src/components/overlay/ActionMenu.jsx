import React, { useRef, useState } from 'react';
import Button from "../primitives/Button";
import AnchoredPopover from "./AnchoredPopover";
import { t } from "../../i18n/index.js";

// 更多操作菜单：从按钮位置展开；窄屏触屏上较长的列表改为底部操作面板。
export default function ActionMenu({ items = [], label = t('common:action.more'), disabled = false }) {
    const [open, setOpen] = useState(false);
    const anchorRef = useRef(null);

    const close = () => setOpen(false);
    const toggle = () => {
        if (disabled) return;
        setOpen((value) => !value);
    };

    return (
        <>
            <span ref={anchorRef} style={{ display: 'inline-block' }}>
                <Button themeAware onClick={toggle} disabled={disabled} aria-haspopup="menu" aria-expanded={open} style={{ minHeight: 38, padding: '7px 10px', whiteSpace: 'nowrap' }}>
                    <span className="material-symbols-outlined" style={{ fontSize: 19, verticalAlign: 'middle', marginRight: 3 }}>more_horiz</span>
                    {label}
                </Button>
            </span>
            <AnchoredPopover
                open={open}
                onClose={close}
                anchorRef={anchorRef}
                placement="bottom-end"
                label={label}
                title={label}
                sheetOnNarrow={items.length > 3}
                style={{ padding: 7 }}
            >
                {items.map((item, index) => (
                    <Button
                        key={item.key || `${item.label}-${index}`}
                        themeAware
                        variant="menu"
                        full
                        role="menuitem"
                        aria-disabled={item.disabled ? true : undefined}
                        disabled={item.disabled}
                        onClick={() => {
                            close();
                            item.onClick?.();
                        }}
                        style={{
                            minHeight: 40,
                            justifyContent: 'flex-start',
                            color: item.tone === 'danger' ? 'var(--color-danger)' : item.tone === 'warning' ? 'var(--color-warning)' : 'var(--color-text-primary)'
                        }}
                    >
                        {item.label}
                    </Button>
                ))}
            </AnchoredPopover>
        </>
    );
}
