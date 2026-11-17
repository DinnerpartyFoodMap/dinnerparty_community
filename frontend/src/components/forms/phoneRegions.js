// 手机号区号选择：常用国家或地区（名称在 common:phoneRegion.<id>），其余用“其他”手填区号。
// 后端按区号决定短信通道：+86 走号码认证服务，其他走短信服务的国际 / 港澳台通道。
export const PHONE_REGIONS = Object.freeze([
    { id: 'CN', code: '86' },
    { id: 'HK', code: '852' },
    { id: 'MO', code: '853' },
    { id: 'TW', code: '886' },
    { id: 'JP', code: '81' },
    { id: 'KR', code: '82' },
    { id: 'SG', code: '65' },
    { id: 'MY', code: '60' },
    { id: 'TH', code: '66' },
    { id: 'VN', code: '84' },
    { id: 'PH', code: '63' },
    { id: 'ID', code: '62' },
    { id: 'US', code: '1' },
    { id: 'GB', code: '44' },
    { id: 'AU', code: '61' },
    { id: 'NZ', code: '64' },
    { id: 'DE', code: '49' },
    { id: 'FR', code: '33' },
    { id: 'IT', code: '39' },
    { id: 'ES', code: '34' },
    { id: 'NL', code: '31' },
    { id: 'RU', code: '7' },
    { id: 'AE', code: '971' },
    { id: 'IN', code: '91' }
]);

export const DEFAULT_COUNTRY_CODE = '86';

/** 区号：1–3 位数字、不以 0 开头（与后端 normalizeCountryCode 一致）；可带 + / 00。不合法时返回 null。 */
export function normalizeCountryCode(value) {
    const text = String(value ?? '').trim().replace(/^(?:\+|00)/, '');
    if (!text) return DEFAULT_COUNTRY_CODE;
    return /^[1-9]\d{0,2}$/.test(text) ? text : null;
}

/**
 * 粘贴进号码框的完整国际号码（+852 6123 4567 / 0085261234567）：按列表里最长匹配的区号拆开。
 * 返回 { countryCode, phone }；不是完整国际号码或区号不在列表里时返回 null（保持原样交给后端校验）。
 */
export function splitInternationalNumber(value) {
    const match = /^(?:\+|00)([\d\s\-()]+)$/.exec(String(value || '').trim());
    if (!match) return null;
    const digits = match[1].replace(/\D/g, '');
    const region = [...PHONE_REGIONS].sort((a, b) => b.code.length - a.code.length).find((item) => digits.startsWith(item.code));
    return region ? { countryCode: region.code, phone: digits.slice(region.code.length) } : null;
}

/** 与后端 normalizePhone 一致的规范形式 "+<区号> <号码>"；不合法时返回 null。 */
export function normalizePhoneNumber(phone, countryCode) {
    const code = normalizeCountryCode(countryCode);
    if (!code) return null;
    let digits = String(phone || '').trim().replace(/[\s\-()]/g, '');
    const international = /^(?:\+|00)(\d+)$/.exec(digits);
    if (international) {
        if (!international[1].startsWith(code)) return null;
        digits = international[1].slice(code.length);
    } else if (code === '86' && /^861\d{10}$/.test(digits)) {
        digits = digits.slice(2);
    }
    if (!/^\d+$/.test(digits)) return null;
    if (code === '86') return /^1[3-9]\d{9}$/.test(digits) ? `+86 ${digits}` : null;
    digits = digits.replace(/^0+/, '');
    if (digits.length < 4 || code.length + digits.length > 15) return null;
    return `+${code} ${digits}`;
}
