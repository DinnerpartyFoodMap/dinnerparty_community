import React, { useEffect, useRef, useState } from 'react';
import PageTemplate from "../components/layout/PageTemplate";
import Button from "../components/primitives/Button";
import TextInput from "../components/forms/TextInput";
import { useTips } from "../components/feedback/Tips";
import { t } from '../i18n/index.js';
import PhoneNumberInput from "../components/forms/PhoneNumberInput";
import { DEFAULT_COUNTRY_CODE, normalizePhoneNumber } from "../components/forms/phoneRegions";
import { loadPhoneBinding, requestPhoneCode, savePhone } from './accountSettings';

// 超过这个等待时间（小时级限流）只提示，不在按钮上倒计时
const MAX_COUNTDOWN_SECONDS = 120;

// 绑定 / 换绑手机号：只验证新号码。网页与 Android 用这一页；iOS 原生设置首页的“绑定手机号”也交回这里。
export default function EditPhone({ user, onBack, backendUrl, token, onUpdateUser }) {
    const [current, setCurrent] = useState(user ? user.phone_masked : undefined);
    const [countryCode, setCountryCode] = useState(DEFAULT_COUNTRY_CODE);
    const [phone, setPhone] = useState('');
    const [code, setCode] = useState('');
    const [sending, setSending] = useState(false);
    const [saving, setSaving] = useState(false);
    // 倒计时只对刚发送过的那个号码生效，改了号码可以立即获取
    const [cooldown, setCooldown] = useState({ phone: '', seconds: 0 });
    const [sentTo, setSentTo] = useState(null); // { phone, masked, minutes }
    const showTip = useTips();
    const alive = useRef(true);
    useEffect(() => () => { alive.current = false; }, []);

    // 当前号码以服务器为准（登录时的 user 可能还没有 phone_masked）
    useEffect(() => {
        let cancelled = false;
        loadPhoneBinding({ backendUrl, token }).then((result) => {
            if (!cancelled && result.ok) setCurrent(result.phoneMasked);
        }).catch(() => { });
        return () => { cancelled = true; };
    }, [backendUrl, token]);

    useEffect(() => {
        if (cooldown.seconds <= 0) return undefined;
        const timer = window.setTimeout(() => setCooldown((prev) => ({ ...prev, seconds: Math.max(0, prev.seconds - 1) })), 1000);
        return () => window.clearTimeout(timer);
    }, [cooldown]);

    // 规范形式 "+区号 号码"：倒计时与“已发送”提示都按它比较，换了区号也算换了号码
    const normalized = normalizePhoneNumber(phone, countryCode);
    const coolingDown = cooldown.seconds > 0 && cooldown.phone === normalized;
    const sentToCurrent = !!sentTo && sentTo.phone === normalized;

    const handleSend = async () => {
        if (sending || coolingDown) return;
        if (!normalized) { showTip(t('settings:editPhone.invalidPhone')); return; }
        setSending(true);
        try {
            const result = await requestPhoneCode({ backendUrl, token, phone, countryCode });
            if (!alive.current) return;
            if (!result.ok) {
                if (result.retryAfter > 0 && result.retryAfter <= MAX_COUNTDOWN_SECONDS) setCooldown({ phone: normalized, seconds: result.retryAfter });
                showTip(result.message);
                return;
            }
            setCooldown({ phone: normalized, seconds: result.resendAfter });
            setSentTo({ phone: normalized, masked: result.phoneMasked, minutes: Math.max(1, Math.round(result.expiresIn / 60)) });
        } catch (ex) {
            showTip(ex.message || t('settings:editPhone.sendFailed'));
        } finally {
            if (alive.current) setSending(false);
        }
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        if (saving) return;
        setSaving(true);
        try {
            const result = await savePhone({ backendUrl, token, phone, countryCode, code });
            if (!alive.current) return;
            if (!result.ok) { showTip(result.message); return; }
            if (onUpdateUser && user) onUpdateUser({ ...user, phone_masked: result.phoneMasked || null }, token);
            setCurrent(result.phoneMasked || null);
            setPhone('');
            setCode('');
            setSentTo(null);
            if (typeof onBack === 'function') onBack();
            setTimeout(() => showTip(result.message), 120);
        } catch (ex) {
            showTip(ex.message || t('settings:editPhone.failed'));
        } finally {
            if (alive.current) setSaving(false);
        }
    };

    const labelText = { fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 6 };
    const sendLabel = sending
        ? t('settings:editPhone.sending')
        : coolingDown
            ? t('settings:editPhone.resendIn', { seconds: cooldown.seconds })
            : sentToCurrent ? t('settings:editPhone.resend') : t('settings:editPhone.send');

    return (
        <PageTemplate breadcrumb={[{ label: t('settings:common.nav.settings'), onClick: onBack }, { label: t('common:nav.editPhone') }]}>
            <form onSubmit={handleSubmit}>
                <div style={{ marginBottom: 12 }}>
                    <div style={labelText}>{t('settings:editPhone.current')}</div>
                    <div style={{ fontVariantNumeric: 'tabular-nums' }}>{current === undefined ? '…' : (current || t('settings:editPhone.unbound'))}</div>
                </div>

                <div style={{ marginBottom: 8 }}>
                    <label htmlFor="settings-phone" style={{ ...labelText, display: 'block' }}>{t('settings:editPhone.newPhone')}</label>
                    <PhoneNumberInput
                        id="settings-phone"
                        countryCode={countryCode}
                        onCountryCodeChange={setCountryCode}
                        phone={phone}
                        onPhoneChange={setPhone}
                        placeholder={t('settings:editPhone.newPhonePlaceholder')}
                    />
                </div>

                <label style={{ display: 'block', marginBottom: 8 }}>
                    <div style={labelText}>{t('settings:editPhone.code')}</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <TextInput
                            type="text"
                            inputMode="numeric"
                            autoComplete="one-time-code"
                            placeholder={t('settings:editPhone.codePlaceholder')}
                            value={code}
                            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                        <Button type="button" variant="secondary" onClick={handleSend} disabled={sending || coolingDown}
                            style={{ flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                            {sendLabel}
                        </Button>
                    </div>
                    {sentToCurrent && (
                        <div style={{ ...labelText, margin: '6px 2px 0' }}>{t('settings:editPhone.sent', { phone: sentTo.masked, minutes: sentTo.minutes })}</div>
                    )}
                </label>

                <p style={{ ...labelText, lineHeight: 1.6, margin: '4px 0 12px' }}>{t('settings:editPhone.hint')}</p>

                <div style={{ display: 'flex', gap: 8 }}>
                    <Button type="submit" disabled={saving}>{saving ? t('settings:common.status.saving') : t('common:action.save')}</Button>
                    <Button type="button" onClick={() => { if (onBack) onBack(); }} style={{ padding: '8px 12px' }}>{t('common:action.cancel')}</Button>
                </div>
            </form>
        </PageTemplate>
    );
}
