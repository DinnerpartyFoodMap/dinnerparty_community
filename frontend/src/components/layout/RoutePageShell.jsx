import React from 'react';
import { getPlatform } from "../../platform/env";
import FullPageHeader from './FullPageHeader';
import { t } from "../../i18n/index.js";

const TITLES = {
    '/settings': t('common:nav.accountSettings'), '/settings/avatar': t('common:nav.editAvatar'), '/settings/username': t('common:nav.editUsername'),
    '/settings/password': t('common:nav.editPassword'), '/settings/themes': t('common:nav.customThemes'), '/settings/personalize': t('common:nav.personalizeMap'), '/settings/skins': t('common:nav.skins'),
    '/admin': t('common:routePageShell.admin'), '/posters/new': t('common:routePageShell.posterExport'), '/dinners': t('common:routePageShell.dinners'), '/dinners/new': t('common:routePageShell.dinnerCreate'),
    '/places': t('places:list.title')
};

export default function RoutePageShell({ path, onNavigate, children }) {
    if (getPlatform() !== 'ios') return children;
    const parent = path.startsWith('/settings/') ? '/settings' : /^\/dinners\/\d+/.test(path) ? '/dinners' : '/';
    return <section className="fm-full-page fm-route-page">
        <FullPageHeader title={TITLES[path] || (path.startsWith('/users/') ? t('profile:title') : t('common:routePageShell.dinnerDetail'))} onBack={() => onNavigate(parent)} />
        <div className="fm-route-page__content">{children}</div>
    </section>;
}
