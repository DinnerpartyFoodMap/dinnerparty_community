import React, { useState } from 'react';
import ScrollableView from '../components/layout/ScrollableView';
import Button from '../components/primitives/Button';
import PageHeading from '../components/layout/PageHeading';
import PlaceFilterPanel from './components/PlaceFilterPanel';
import PlaceListView from './PlaceListView';
import { EMPTY_PLACE_FILTER, isPlaceFilterActive } from './placeFilter';
import { t } from '../i18n/index.js';
import './placeList.css';

// 地点列表页（/places，可直接打开或分享）：列表本身见 PlaceListView；地图上的列表模式（MapListMode）是同一个列表。
export default function PlaceListPage({ backendUrl, token, onOpenPlace, onBack }) {
    const [filter, setFilter] = useState(EMPTY_PLACE_FILTER);
    const [filterOpen, setFilterOpen] = useState(false);
    const active = isPlaceFilterActive(filter);
    return (
        <ScrollableView as="main" className="fm-place-list-page">
            <div className="fm-place-list">
                <PageHeading title={t('places:list.title')} onBack={onBack} />
                <PlaceListView
                    backendUrl={backendUrl}
                    token={token}
                    filter={filter}
                    onOpenPlace={onOpenPlace}
                    toolbar={(
                        <Button themeAware onClick={() => setFilterOpen((open) => !open)} aria-expanded={filterOpen} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                            <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>filter_list</span>
                            {active ? t('places:filter.buttonActive') : t('places:filter.button')}
                        </Button>
                    )}
                >
                    {filterOpen && (
                        <div className="fm-place-list__filter">
                            <PlaceFilterPanel backendUrl={backendUrl} value={filter} onChange={setFilter} />
                        </div>
                    )}
                </PlaceListView>
            </div>
        </ScrollableView>
    );
}
