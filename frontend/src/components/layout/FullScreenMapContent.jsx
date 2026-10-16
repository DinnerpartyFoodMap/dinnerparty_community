import React from 'react';
import { getPlatform } from "../../platform/env";
import FullPageHeader from './FullPageHeader';
import { t } from "../../i18n/index.js";

export default function FullScreenMapContent({ title = t('common:action.pickOnMap'), onBack, children }) {
    if (getPlatform() !== 'ios') return children;
    return <section className="fm-full-page fm-map-picker-shell">
        <FullPageHeader title={title} onBack={onBack} />
        <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>{children}</div>
    </section>;
}
