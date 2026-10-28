import { t, tx } from '../i18n/index.js';
import { markdownToPlainText } from '../components/markdown/markdownText.js';

export function randomFoodChromeSheet({ result, activeOrigin, busy, error }) {
    const place = result?.place;
    const distance = Number(result?.distanceKm);
    const distanceText = Number.isFinite(distance) ? (distance < 1
        ? t('map:randomFood.meters', { distance: Math.round(distance * 1000) })
        : t('map:randomFood.kilometers', { distance: distance.toFixed(1) })) : '';
    const category = place?.category || t('common:label.uncategorized');
    return {
        id: 'random', size: 'fit', title: t('map:randomFood.title'),
        subtitle: activeOrigin ? t('map:randomFood.introOrigin', { name: activeOrigin.label }) : t('map:randomFood.intro'),
        message: busy ? t('map:randomFood.picking') : error || (!place ? result?.message : undefined),
        messageTone: busy ? 'loading' : error ? 'danger' : undefined,
        paragraphs: place ? [
            { id: 'place', title: place.name, text: [
                activeOrigin ? tx('map:randomFood.metaOrigin', { category, name: activeOrigin.label, distance: distanceText }) : tx('map:randomFood.meta', { category, distance: distanceText }),
                Number(place.per_person_cost) > 0 ? t('common:label.perPersonCost', { per_person_cost: place.per_person_cost }) : ''
            ].join('') },
            place.description && { id: 'description', text: markdownToPlainText(place.description) },
            { id: 'candidates', text: [result.personalized && t('map:randomFood.personalized'), tx('map:randomFood.candidates', { candidateCount: result.candidateCount })].filter(Boolean).join('\n') }
        ].filter(Boolean) : [],
        actions: [
            place && { id: 'view', title: t('map:randomFood.viewPlace'), symbol: 'mappin.and.ellipse', tone: 'accent', disabled: busy, keepsOpen: true },
            { id: 'another', title: busy ? t('map:randomFood.pickingShort') : place ? t('map:randomFood.another') : t('map:randomFood.tryAgain'), symbol: 'dice', disabled: busy, keepsOpen: true },
            { id: 'redraw', title: t('map:randomFood.redraw'), symbol: 'scope', disabled: busy, keepsOpen: true }
        ].filter(Boolean)
    };
}
