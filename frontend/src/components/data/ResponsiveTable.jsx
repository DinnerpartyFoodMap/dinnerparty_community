import React from 'react';
import ScrollableView from "../layout/ScrollableView";
import useMediaQuery from "../../hooks/useMediaQuery";
import { t } from "../../i18n/index.js";

export default function ResponsiveTable({
    children,
    minWidth = 720,
    wrapperStyle = {},
    tableStyle = {},
    style,
    ...tableProps
}) {
    const isMobile = useMediaQuery('(max-width: 640px)');
    const containerStyle = {
        width: '100%',
        maxWidth: '100%',
        overflowX: 'auto',
        overflowY: 'hidden',
        WebkitOverflowScrolling: 'touch',
        msOverflowStyle: '-ms-autohiding-scrollbar',
        ...wrapperStyle
    };

    const tableStyle_ = {
        borderCollapse: 'collapse',
        width: '100%',
        minWidth: `max(${minWidth}px, 100%)`,
        ...style,
        ...tableStyle
    };

    return (
        <div style={{ width: '100%', minWidth: 0 }}>
            {isMobile && minWidth > 640 && (
                <div style={{ marginBottom: 6, color: 'var(--color-text-secondary)', fontSize: 12 }}>
                    {t('common:responsiveTable.scrollHint')}
                </div>
            )}
            <ScrollableView style={containerStyle}>
                <table {...tableProps} style={tableStyle_}>
                    {children}
                </table>
            </ScrollableView>
        </div>
    );
}
