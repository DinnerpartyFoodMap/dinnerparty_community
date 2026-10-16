// 此版本对应用户需要重新确认的政策版本；一般文字修正无需改变版本。
export const PRIVACY_POLICY_VERSION = '2026-10-16';
export const PRIVACY_CONSENT_KEY = 'foodmap.privacy-consent';
let sessionChoice = null;

export function parsePrivacyConsent(raw) {
    try {
        const record = JSON.parse(raw);
        if (record?.version === PRIVACY_POLICY_VERSION && ['accepted', 'rejected'].includes(record.decision)) {
            return record.decision;
        }
    } catch { /* 缺失、损坏或旧版记录都不能视为同意。 */ }
    return 'pending';
}

export function readPrivacyConsent() {
    if (sessionChoice) return sessionChoice;
    try {
        return parsePrivacyConsent(window.localStorage.getItem(PRIVACY_CONSENT_KEY));
    } catch {
        return 'pending';
    }
}

/** 保存失败仍保留本次打开的选择；下次启动重新询问。 */
export function rememberPrivacyChoice(decision) {
    if (!['accepted', 'rejected'].includes(decision)) throw new Error('Invalid privacy decision');
    sessionChoice = decision;
    try {
        window.localStorage.setItem(PRIVACY_CONSENT_KEY, JSON.stringify({
            version: PRIVACY_POLICY_VERSION, decision, updatedAt: new Date().toISOString()
        }));
        return true;
    } catch {
        return false;
    }
}
