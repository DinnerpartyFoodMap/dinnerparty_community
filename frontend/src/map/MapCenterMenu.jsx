import React from 'react';
import { t } from '../i18n/index.js';
import '../places/placeList.css';

// 列表与随机美食共用的中心选择项；距离范围由调用方单独提供。
export default function MapCenterMenu({ options, selected, onPickCenter, disabled = false }) {
    return <>
        <div className="fm-map-list__menu-heading" role="presentation">{t('places:list.center.heading')}</div>
        {options.map(option => <button key={option.id} type="button" role="menuitemradio"
            aria-checked={selected === option.id} disabled={disabled}
            className="fm-map-list__menu-item" onClick={option.select}>
            <span className="material-symbols-outlined" aria-hidden="true">{option.icon}</span>
            <span>{option.label}</span>
            {selected === option.id && <span className="material-symbols-outlined fm-map-list__menu-check" aria-hidden="true">check</span>}
        </button>)}
        <button type="button" role="menuitem" className="fm-map-list__menu-item" disabled={disabled} onClick={onPickCenter}>
            <span className="material-symbols-outlined" aria-hidden="true">add_location_alt</span>
            <span>{t('places:list.center.change')}</span>
        </button>
    </>;
}
