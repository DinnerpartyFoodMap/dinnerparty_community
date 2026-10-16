import React from 'react';
import { isNativePlatform } from '../../platform/env.js';
import { buildPublicUrl } from '../../platform/runtimeConfig.js';
import { openExternal } from '../../platform/navigation.js';
import { t } from '../../i18n/index.js';

export default function PrivacyPolicyLink({ style }) {
    const native = isNativePlatform();
    const href = native ? buildPublicUrl('/privacy/') : '/privacy/';
    return (
        <a href={href} target="_blank" rel="noopener noreferrer" style={style}
            onClick={(event) => {
                if (!native) return;
                event.preventDefault();
                void openExternal(href);
            }}>
            {t('auth:page.privacyPolicy')}
        </a>
    );
}
