import React, { useState } from 'react';
import TextInput from './TextInput';
import SelectInput from './SelectInput';
import { PHONE_REGIONS, splitInternationalNumber } from './phoneRegions';
import { t } from '../../i18n/index.js';

const OTHER = 'other';
// 语言在启动时固定，模块级 t() 是安全的；键写成字面量，i18n 检查才能覆盖
const REGION_LABELS = {
    CN: t('common:phoneRegion.CN'),
    HK: t('common:phoneRegion.HK'),
    MO: t('common:phoneRegion.MO'),
    TW: t('common:phoneRegion.TW'),
    JP: t('common:phoneRegion.JP'),
    KR: t('common:phoneRegion.KR'),
    SG: t('common:phoneRegion.SG'),
    MY: t('common:phoneRegion.MY'),
    TH: t('common:phoneRegion.TH'),
    VN: t('common:phoneRegion.VN'),
    PH: t('common:phoneRegion.PH'),
    ID: t('common:phoneRegion.ID'),
    US: t('common:phoneRegion.US'),
    GB: t('common:phoneRegion.GB'),
    AU: t('common:phoneRegion.AU'),
    NZ: t('common:phoneRegion.NZ'),
    DE: t('common:phoneRegion.DE'),
    FR: t('common:phoneRegion.FR'),
    IT: t('common:phoneRegion.IT'),
    ES: t('common:phoneRegion.ES'),
    NL: t('common:phoneRegion.NL'),
    RU: t('common:phoneRegion.RU'),
    AE: t('common:phoneRegion.AE'),
    IN: t('common:phoneRegion.IN'),
};

// 区号选择 + 号码输入（选项先写区号，窄宽度下截断时仍能看到区号）。countryCode 是不带 + 的区号字符串（默认 86）；选“其他”时手填区号。
// 粘贴完整国际号码（+852 6123 4567）时自动切换到对应区号。invalid 时两个输入框都标红。
export default function PhoneNumberInput({ id, countryCode, onCountryCodeChange, phone, onPhoneChange, placeholder, invalidProps = {}, disabled = false }) {
    const listed = PHONE_REGIONS.some((region) => region.code === countryCode);
    const [custom, setCustom] = useState(!listed);
    const regionValue = custom || !listed ? OTHER : PHONE_REGIONS.find((region) => region.code === countryCode).id;

    const handleRegion = (value) => {
        if (value === OTHER) {
            setCustom(true);
            onCountryCodeChange('');
            return;
        }
        setCustom(false);
        onCountryCodeChange(PHONE_REGIONS.find((region) => region.id === value).code);
    };

    const handlePhone = (value) => {
        const split = splitInternationalNumber(value);
        if (split) {
            setCustom(false);
            onCountryCodeChange(split.countryCode);
            onPhoneChange(split.phone);
            return;
        }
        onPhoneChange(value);
    };

    return (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <SelectInput
                id={id ? `${id}-region` : undefined}
                aria-label={t('common:phoneRegion.label')}
                value={regionValue}
                disabled={disabled}
                onChange={(e) => handleRegion(e.target.value)}
                style={{ flex: '0 1 auto', width: custom ? 96 : 136, minWidth: 0 }}
            >
                {PHONE_REGIONS.map((region) => (
                    <option key={region.id} value={region.id}>+{region.code} {REGION_LABELS[region.id] || region.id}</option>
                ))}
                <option value={OTHER}>{t('common:phoneRegion.other')}</option>
            </SelectInput>
            {(custom || !listed) && (
                <TextInput
                    aria-label={t('common:phoneRegion.codeLabel')}
                    type="text"
                    inputMode="numeric"
                    autoComplete="tel-country-code"
                    placeholder="+"
                    maxLength={4}
                    value={countryCode ? `+${countryCode}` : ''}
                    disabled={disabled}
                    onChange={(e) => onCountryCodeChange(e.target.value.replace(/\D/g, '').slice(0, 3))}
                    {...invalidProps}
                    style={{ width: 64, flexShrink: 0 }}
                />
            )}
            <TextInput
                id={id}
                type="tel"
                inputMode="tel"
                autoComplete="tel-national"
                maxLength={24}
                placeholder={placeholder}
                value={phone}
                disabled={disabled}
                onChange={(e) => handlePhone(e.target.value)}
                {...invalidProps}
                style={{ flex: 1, minWidth: 0 }}
            />
        </div>
    );
}
