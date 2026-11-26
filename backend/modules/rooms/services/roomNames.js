const DEFAULT_ROLE_NAME = '饭桶';
const NAME_MAX = 12;
const CHARACTERS = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}]|[#*]\uFE0F?\u20E3/u;
const DOMAIN = /[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?[.。](?:[a-z]{2,}|xn--[a-z0-9-]+|中国|中國|公司|网络|網絡|香港|入口|在线|在線)/iu;
const CONTACT = /qq|微信|[vw]x|wechat|weixin|手机号|电话|邮箱|@/iu;

function validateName(value, defaultName) {
    const name = typeof value === 'string' ? value.trim() : '';
    const errors = [];
    let length = 0;
    for (const _ of CHARACTERS.segment(name)) {
        if (++length > NAME_MAX) break;
    }
    if (length < 1 || length > NAME_MAX) {
        errors.push(`名字须为 1 到 ${NAME_MAX} 字`);
    }
    if (/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(name)) errors.push('名字不能含换行或无效字符');
    if (name && /^[\p{P}\p{S}\p{Cf}\p{M}\s]+$/u.test(name) && !EMOJI.test(name)) {
        errors.push('名字不能全是标点或符号');
    }
    const canonical = name.normalize('NFKC').replace(/\p{Cf}/gu, '');
    if (name && canonical === defaultName?.trim().normalize('NFKC')) errors.push('名字不能和当前角色的默认名一样');
    const compact = canonical.replace(/\s/gu, '');
    if (/https?|www/iu.test(compact) || DOMAIN.test(compact)) errors.push('名字不能含链接');
    const digitsJoined = compact.replace(/(?<=\p{Nd})[-‐‑–—.·()]+(?=\p{Nd})/gu, '');
    if (CONTACT.test(compact) || /\p{Nd}{6,}/u.test(digitsJoined)) errors.push('名字不能含联系方式');
    return errors;
}

module.exports = { DEFAULT_ROLE_NAME, NAME_MAX, validateName };
