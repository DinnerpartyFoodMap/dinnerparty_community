import { useEffect, useRef } from 'react';
import {
    createDinner, deleteDinner, DINNER_PAGE_SIZE, fetchDinnerById, fetchDinners,
    saveDinnerProposal, saveDinnerSchedule, setDinnerParticipation
} from '../api/client.js';
import { t } from '../i18n/index.js';
import { getPlatform, isPluginAvailable } from '../platform/env.js';
import { nativeThemeColors } from '../theme/theme.js';

export function supportsNativeDinners() {
    return getPlatform() === 'ios' && isPluginAvailable('NativeDinner');
}

let nextSession = 0;

function dinnerLabels() {
    const labels = {
        back: t('common:action.back'), retry: t('common:action.retry'),
        loadError: t('dinner:loadFailed'), actionError: t('dinner:updateFailed'), saving: t('dinner:saving'),
        title: t('dinner:list.title'), create: t('dinner:list.create'), search: t('dinner:list.search'),
        submitSearch: t('common:action.search'),
        showEnded: t('dinner:list.showEnded'), loading: t('dinner:list.loading'), empty: t('dinner:list.empty'),
        noResults: t('dinner:list.noResults'), more: t('dinner:list.loadMore'), viewDetail: t('dinner:list.viewDetail'),
        titleField: t('dinner:create.titlePlaceholder'), placeField: t('dinner:create.placePlaceholder'),
        timeField: t('dinner:create.timeOptional'), max: t('dinner:create.maxParticipantsPlaceholder'),
        contact: t('dinner:create.contactPlaceholder'), contactLabel: t('dinner:detail.contactLabel'),
        description: t('dinner:create.descriptionPlaceholder'),
        submit: t('dinner:create.submit'), detail: t('dinner:detail.title'), join: t('dinner:detail.join'),
        leave: t('dinner:detail.leave'), confirmLeave: t('dinner:detail.confirmLeave'), full: t('dinner:detail.full'),
        share: t('dinner:detail.shareTitle'), delete: t('dinner:detail.delete'), confirmDelete: t('dinner:detail.confirmDelete'),
        cancel: t('common:action.cancel'), proposal: t('dinner:proposal.title'), proposalHint: t('dinner:proposal.hint'),
        saveProposal: t('dinner:proposal.save'), proposalSaved: t('dinner:proposal.saved'),
        suggestions: t('dinner:proposal.suggested'), noSuggestions: t('dinner:proposal.empty'),
        places: t('dinner:proposal.places'), times: t('dinner:proposal.times'),
        schedule: t('dinner:schedule.title'), saveSchedule: t('dinner:schedule.save'), scheduleSaved: t('dinner:schedule.saved'),
        schedulePlace: t('dinner:schedule.place'), scheduleTime: t('dinner:schedule.time')
    };
    for (let number = 1; number <= 3; number += 1) {
        labels[`proposalPlace${number}`] = t('dinner:proposal.place', { number });
        labels[`proposalTime${number}`] = t('dinner:proposal.time', { number });
    }
    return labels;
}

function validId(value) {
    return Number.isSafeInteger(value) && value > 0;
}

function nativeDinner(item, backendUrl, currentUserId, isAdmin) {
    const start = Date.parse(item.start_time);
    const toProposal = proposal => ({
        places: proposal.places,
        times: proposal.times.map(value => Date.parse(value)).filter(Number.isFinite)
    });
    return {
        id: item.id, title: item.title, description: item.description, place: item.place_name,
        start: Number.isFinite(start) ? start : null,
        timeLabel: Number.isFinite(start) ? '' : t('dinner:timeTbd'),
        placeLabel: item.place_name || t('dinner:placeTbd'),
        status: t('dinner:list.meta', {
            status: item.is_ended ? t('dinner:detail.statusEnded') : t('dinner:detail.statusOpen'),
            creator_name: item.creator_name || t('dinner:anonymous')
        }),
        contact: item.contact_info,
        participants: item.max_participants
            ? t('dinner:detail.participantsLimited', { count: item.participant_count, max: item.max_participants })
            : t('dinner:detail.participants', { count: item.participant_count }),
        isEnded: !!item.is_ended, isOrganizer: item.is_organizer, isJoined: item.is_joined,
        isFull: item.max_participants != null && item.participant_count >= item.max_participants,
        canDelete: item.is_organizer || (!!currentUserId && (item.creator_id === String(currentUserId) || isAdmin)),
        myProposal: item.my_proposal ? toProposal(item.my_proposal) : null,
        proposals: item.proposals.map(toProposal),
        shareUrl: `${backendUrl.replace(/\/+$/, '')}/dinners/${item.id}/share`
    };
}

function schedule(values) {
    return { place_name: values.place, start_time: values.start };
}

async function dinnerAction({ type, values = {} }, backendUrl, token, signal, present) {
    if (type === 'list') {
        const offset = Number.isSafeInteger(values.offset) && values.offset >= 0 ? values.offset : 0;
        const query = typeof values.query === 'string' ? values.query.slice(0, 120) : '';
        const items = await fetchDinners(backendUrl, { query, includeEnded: values.includeEnded === true, offset, signal });
        return { items: items.map(present), hasMore: items.length === DINNER_PAGE_SIZE, nextOffset: offset + items.length };
    }

    if (type === 'create' && token) {
        const item = await createDinner(backendUrl, token, {
            ...schedule(values), title: values.title, description: values.description,
            max_participants: values.max, contact_info: values.contact
        });
        return { item: present(item) };
    }

    const { dinnerId } = values;
    if (!validId(dinnerId)) throw new Error(t('dinner:updateFailed'));
    if (type === 'detail') return { item: present(await fetchDinnerById(backendUrl, dinnerId, { token, signal })) };
    if (!token) throw new Error(t('dinner:updateFailed'));

    switch (type) {
        case 'join': return { item: present(await setDinnerParticipation(backendUrl, token, dinnerId, true)) };
        case 'leave': return { item: present(await setDinnerParticipation(backendUrl, token, dinnerId, false)) };
        case 'proposal': return { item: present(await saveDinnerProposal(backendUrl, token, dinnerId, { places: values.places, times: values.times })) };
        case 'schedule': return { item: present(await saveDinnerSchedule(backendUrl, token, dinnerId, schedule(values))) };
        case 'delete': await deleteDinner(backendUrl, token, dinnerId); return {};
        default: throw new Error(t('dinner:updateFailed'));
    }
}

export default function NativeDinnerHost({ backendUrl, token, dinnerId, create, dark, themeColor, currentUserId, isAdmin, onBack, onAuth, onUnavailable }) {
    const callbacks = useRef({ onBack, onAuth, onUnavailable });
    callbacks.current = { onBack, onAuth, onUnavailable };
    const latestTheme = useRef(null);
    latestTheme.current = { ...nativeThemeColors(), primary: themeColor, dark };
    const nativeSession = useRef(null);

    useEffect(() => {
        const id = `dinner-${Date.now()}-${++nextSession}`;
        const controller = new AbortController();
        const { signal } = controller;
        let plugin;
        let listener;
        const removeListener = async () => {
            const handle = listener;
            listener = null;
            await handle?.remove().catch(() => {});
        };
        const start = async () => {
            try {
                const { registerPlugin } = await import('@capacitor/core');
                if (signal.aborted) return;
                plugin = registerPlugin('NativeDinner');
                listener = await plugin.addListener('dinnerEvent', async event => {
                    if (signal.aborted || event?.id !== id || typeof event.requestId !== 'string') return;
                    let response;
                    try {
                        const payload = await dinnerAction(event, backendUrl, token, signal, item => nativeDinner(item, backendUrl, currentUserId, isAdmin));
                        response = { ok: true, payload };
                    } catch (error) {
                        response = { ok: false, message: String(error?.message || t('dinner:updateFailed')).slice(0, 200) };
                    }
                    if (!signal.aborted) await plugin.respond({ id, requestId: event.requestId, ...response }).catch(() => {});
                });
                if (signal.aborted) return;

                const options = { id, labels: dinnerLabels(), canWrite: Boolean(token), create, dinnerId };
                nativeSession.current = { id, plugin };
                let result;
                for (let attempt = 0; !signal.aborted; attempt += 1) {
                    try { result = await plugin.open({ ...options, theme: latestTheme.current }); break; }
                    catch (error) {
                        if (error?.code !== 'BUSY' || attempt >= 15) throw error;
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }
                }
                if (signal.aborted) return;
                if (result?.id !== id) throw new Error(t('dinner:loadFailed'));
                if (result.action === 'login') callbacks.current.onAuth(result.create === true, validId(result.dinnerId) ? result.dinnerId : null);
                else callbacks.current.onBack();
            } catch {
                if (!signal.aborted) callbacks.current.onUnavailable();
            } finally {
                if (nativeSession.current?.id === id) nativeSession.current = null;
                await removeListener();
            }
        };
        void start();
        return () => {
            controller.abort();
            void removeListener();
            void plugin?.close({ id }).catch(() => {});
        };
    }, [backendUrl, token, dinnerId, create, currentUserId, isAdmin]);

    useEffect(() => {
        const active = nativeSession.current;
        if (active) void active.plugin.update({ id: active.id, theme: latestTheme.current }).catch(() => {});
    }, [dark, themeColor]);

    return null;
}
