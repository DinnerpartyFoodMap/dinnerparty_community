import React, { useCallback, useEffect, useRef, useState } from "react";
import TextInput from "../components/forms/TextInput";
import ScrollableView from "../components/layout/ScrollableView";
import Button from "../components/primitives/Button";
import qrcodeImg from "../img/qrcode.png";
import useDarkMode from "../theme/useDarkMode";
import { getThemeColor, getThemeSecondary, colorToRgba, darkenColor } from "../theme/theme";
import { reportAuthStage } from "./services/authDiagnostics";
import { getClientInfo } from "../platform/env";
import { t, tx } from "../i18n/index.js";

const REQUEST_TIMEOUT_MS = 12000;
const MAX_USERNAME_LENGTH = 64;
const MAX_PASSWORD_LENGTH = 128;
const MAX_QQ_LENGTH = 15;
const QQ_PATTERN = /^[1-9]\d{4,14}$/;
const VERIFICATION_CODE_LENGTH = 6;
const VERIFICATION_CODE_PATTERN = /^\d{6}$/;
const MIN_RESET_PASSWORD_LENGTH = 6;
// 机器人要先确认群成员再私聊，比普通请求慢
const SEND_CODE_TIMEOUT_MS = 25000;
const DEFAULT_RESEND_SECONDS = 60;
// 超过这个等待时间（小时级限流）只提示，不在按钮上倒计时
const MAX_COUNTDOWN_SECONDS = 120;
const CODE_PURPOSE = { register: 'register', reset: 'reset_password' };

function getStaticColors(dark) {
    return {
        panelBackground: 'var(--color-bg-surface)',
        textStrong: 'var(--color-text-primary)',
        textMuted: 'var(--color-text-secondary)',
        border: 'var(--color-border)',
        tabGroupBackground: 'var(--color-bg-overlay)',
        inputBackground: 'var(--color-bg-overlay)',
        successText: 'var(--color-success)',
        successBackground: dark ? 'rgba(92, 214, 152, 0.12)' : 'rgba(61, 153, 112, 0.10)',
        errorText: 'var(--color-danger)',
        errorBackground: dark ? 'rgba(255, 107, 107, 0.12)' : 'rgba(217, 83, 79, 0.10)'
    };
}

function getThemeUIColors(themeColor) {
    const primary = themeColor || '#E2789F';
    const secondary = getThemeSecondary() || primary;
    const primaryBorder = darkenColor(primary, 0.18);
    const primaryDisabled = colorToRgba(primary, 0.5);
    const tabActiveBg = colorToRgba(secondary, 0.15);
    const tabActiveBorder = colorToRgba(secondary, 0.4);
    const tabActiveText = primary;
    return {
        primaryAction: primary,
        primaryActionBorder: primaryBorder,
        primaryActionDisabled: primaryDisabled,
        tabActiveBackground: tabActiveBg,
        tabActiveBorder: tabActiveBorder,
        tabActiveText: tabActiveText
    };
}

function getTabButtonStyle(isActive, disabled, uiColors) {
    return {
        border: `1px solid ${isActive ? uiColors.tabActiveBorder : "transparent"}`,
        background: isActive ? uiColors.tabActiveBackground : "transparent",
        color: isActive ? uiColors.tabActiveText : uiColors.textMuted,
        borderRadius: 8,
        padding: "7px 14px",
        lineHeight: 1.2,
        fontWeight: isActive ? 700 : 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.7 : 1
    };
}

async function parseResponseBody(res) {
    const text = await res.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { error: text.slice(0, 160) };
    }
}

function getFriendlyErrorMessage(status, fallback, action) {
    const serverMessage = typeof fallback === "string" ? fallback : "";
    if (serverMessage) return serverMessage;
    if (status === 400) return t('auth:page.error.badRequest', { action });
    if (status === 401) return t('auth:page.error.wrongCredentials');
    if (status === 403) return t('auth:page.error.forbidden');
    if (status === 404) return t('auth:page.error.unavailable', { action });
    if (status === 409) return t('auth:page.error.usernameTaken');
    if (status === 429) return t('auth:page.error.tooManyRequests');
    if (status >= 500) return t('auth:page.error.server');
    return t('auth:page.error.failedStatus', { action, status });
}

function appendRequestId(message, requestId) {
    const safeRequestId = typeof requestId === 'string' && /^[A-Za-z0-9._:-]{8,128}$/.test(requestId)
        ? requestId
        : '';
    return safeRequestId ? t('auth:page.withRequestId', { message, safeRequestId }) : message;
}

function createClientRequestId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch (error) { }
    const random = Math.random().toString(36).slice(2, 12);
    return `web-${Date.now().toString(36)}-${random}`;
}

function withRequestId(url, requestId) {
    const separator = String(url).includes('?') ? '&' : '?';
    return `${url}${separator}request_id=${encodeURIComponent(requestId)}`;
}

function createRequestState() {
    return {
        controller: typeof AbortController !== "undefined" ? new AbortController() : null,
        xhr: null,
        requestId: createClientRequestId(),
        cancelled: false,
        timedOut: false
    };
}

// 登录/注册时附带客户端平台与版本，服务端据此区分设备会话（不含任何凭证或设备指纹）
function clientFields() {
    const client = getClientInfo();
    return { 'client[platform]': client.platform, 'client[app_version]': client.app_version };
}

function formBody(fields) {
    return Object.entries(fields)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&");
}

function isIOSChrome() {
    if (typeof navigator === 'undefined') return false;
    return /CriOS\//i.test(navigator.userAgent || '');
}

function parseResponseText(text) {
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch {
        return { error: String(text).slice(0, 160) };
    }
}

function xhrResponseWithTimeout(url, options, request, timeoutMs) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        let settled = false;
        let deadlineTimerId;
        let readyStatePollId;
        request.xhr = xhr;

        const cleanup = () => {
            window.clearTimeout(deadlineTimerId);
            window.clearInterval(readyStatePollId);
            request.xhr = null;
        };
        const resolveCompletedResponse = () => {
            if (settled || xhr.readyState !== 4) return;
            // Status 0 means the request was aborted or the response was not
            // exposed to JavaScript. Treating it as a completed HTTP response
            // can strand the loading state after an iOS lifecycle interruption.
            if (xhr.status === 0) {
                rejectOnce(new TypeError(t('auth:page.error.xhrAborted')));
                return;
            }
            settled = true;
            cleanup();
            try {
                request.requestId = xhr.getResponseHeader('X-Request-ID') || request.requestId;
                resolve({
                    response: { ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status },
                    data: parseResponseText(xhr.responseText)
                });
            } catch (error) {
                reject(error);
            }
        };
        const rejectOnce = (error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        xhr.open(options.method || 'GET', url, true);
        xhr.timeout = timeoutMs;
        for (const [key, value] of Object.entries(options.headers || {})) {
            xhr.setRequestHeader(key, value);
        }
        xhr.onreadystatechange = resolveCompletedResponse;
        xhr.onload = resolveCompletedResponse;
        xhr.onloadend = resolveCompletedResponse;
        xhr.ontimeout = () => {
            request.timedOut = true;
            const error = new Error('Request timed out');
            error.name = 'RequestTimeoutError';
            rejectOnce(error);
        };
        xhr.onerror = () => {
            rejectOnce(new TypeError(t('auth:page.error.network')));
        };
        xhr.onabort = () => {
            const error = new Error('Request aborted');
            error.name = 'AbortError';
            rejectOnce(error);
        };

        // On iOS Chrome the networking layer can mark a request complete and
        // cancel xhr.timeout without delivering the final load event. Polling
        // readyState catches that state; the independent deadline guarantees
        // the UI can never remain in "登录中" indefinitely.
        readyStatePollId = window.setInterval(resolveCompletedResponse, 100);
        deadlineTimerId = window.setTimeout(() => {
            if (settled) return;
            request.timedOut = true;
            try { xhr.abort(); } catch (error) { }
            const timeoutError = new Error('Request timed out');
            timeoutError.name = 'RequestTimeoutError';
            rejectOnce(timeoutError);
        }, timeoutMs);
        xhr.send(options.body || null);
    });
}

async function fetchResponseWithTimeout(url, options, request, timeoutMs = REQUEST_TIMEOUT_MS) {
    // Chrome on iOS uses WebKit but has its own networking/storage integration.
    // Its fetch() can occasionally leave a completed login response pending;
    // XMLHttpRequest has a native whole-response timeout and is more reliable here.
    if (isIOSChrome() && typeof XMLHttpRequest !== 'undefined') {
        return xhrResponseWithTimeout(url, options, request, timeoutMs);
    }

    let timerId;
    const timeoutPromise = new Promise((resolve, reject) => {
        timerId = window.setTimeout(() => {
            request.timedOut = true;
            if (request.controller) request.controller.abort();
            const error = new Error("Request timed out");
            error.name = "RequestTimeoutError";
            reject(error);
        }, timeoutMs);
    });

    const requestOptions = request.controller
        ? { ...options, signal: request.controller.signal }
        : options;

    try {
        return await Promise.race([
            (async () => {
                const response = await fetch(url, requestOptions);
                request.requestId = response.headers.get('X-Request-ID') || request.requestId;
                const data = await parseResponseBody(response);
                return { response, data };
            })(),
            timeoutPromise
        ]);
    } finally {
        window.clearTimeout(timerId);
    }
}

export default function AuthPage({ backendUrl, onLoginSuccess, onClose, closeRef }) {
    const [tab, setTab] = useState("login"); // "login" | "register" | "reset"（找回通行密码）
    const [registerStep, setRegisterStep] = useState("qrcode"); // "qrcode" | "form"
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [confirmPassword, setConfirmPassword] = useState("");
    const [showPassword, setShowPassword] = useState(false);
    const [qq, setQq] = useState("");
    const [verificationCode, setVerificationCode] = useState("");
    // 验证码已私聊发到哪个 QQ，显示在验证码输入框下方
    const [codeSentTo, setCodeSentTo] = useState(null); // { qq, minutes } | null
    // 重新获取的倒计时只对刚发送过的那个 QQ 生效，改了 QQ 号可以立即获取
    const [cooldown, setCooldown] = useState({ qq: "", seconds: 0 });
    // 提示是成功还是错误由设置的地方说明，不从文字内容推断
    const [notice, setNotice] = useState({ text: "", tone: "error" });
    const message = notice.text;
    const setMessage = useCallback((text, tone = "error") => setNotice({ text, tone }), []);
    const [loading, setLoading] = useState(false);
    const [pendingAction, setPendingAction] = useState(null); // "submit" | "code"
    const [slowConnection, setSlowConnection] = useState(false);
    const activeRequestRef = useRef(null);
    const slowTimerRef = useRef(null);
    const closingRef = useRef(false);
    const handleCloseRef = useRef(null);

    const clearSlowTimer = useCallback(() => {
        if (slowTimerRef.current) {
            window.clearTimeout(slowTimerRef.current);
            slowTimerRef.current = null;
        }
    }, []);

    const startRequest = useCallback((action = "submit") => {
        const request = createRequestState();
        activeRequestRef.current = request;
        closingRef.current = false;
        setLoading(true);
        setPendingAction(action);
        setSlowConnection(false);
        clearSlowTimer();
        slowTimerRef.current = window.setTimeout(() => setSlowConnection(true), 4000);
        return request;
    }, [clearSlowTimer]);

    const finishRequest = useCallback((request) => {
        if (activeRequestRef.current !== request) return;
        activeRequestRef.current = null;
        clearSlowTimer();
        setLoading(false);
        setPendingAction(null);
        setSlowConnection(false);
    }, [clearSlowTimer]);

    const cancelRequest = useCallback((showCancelledMessage = true) => {
        const request = activeRequestRef.current;
        activeRequestRef.current = null;
        if (request) {
            request.cancelled = true;
            if (request.xhr) request.xhr.abort();
            if (request.controller) request.controller.abort();
        }
        clearSlowTimer();
        setLoading(false);
        setPendingAction(null);
        setSlowConnection(false);
        if (showCancelledMessage) setMessage(t('auth:page.cancelled'));
    }, [clearSlowTimer]);


    // 逻辑关闭立即取消请求；表单内容保留到退出动画结束（组件随浮层卸载时自然清空），
    // 避免关闭时画面先被清空再淡出。
    const handleClose = useCallback(() => {
        closingRef.current = true;
        cancelRequest(false);
        onClose && onClose();
    }, [cancelRequest, onClose]);

    useEffect(() => {
        handleCloseRef.current = handleClose;
        if (closeRef) closeRef.current = handleClose;
    }, [handleClose, closeRef]);

    useEffect(() => {
        // Escape 由统一浮层栈处理（只关闭最上层）
        return () => {
            closingRef.current = true;
            const request = activeRequestRef.current;
            activeRequestRef.current = null;
            if (request) {
                request.cancelled = true;
                if (request.xhr) request.xhr.abort();
                if (request.controller) request.controller.abort();
            }
            clearSlowTimer();
        };
        // Request cleanup belongs to the component lifetime. In particular, it
        // must not run merely because a parent render supplied a new callback.
    }, [clearSlowTimer]);

    useEffect(() => {
        if (cooldown.seconds <= 0) return undefined;
        const timerId = window.setTimeout(() => {
            setCooldown((prev) => ({ ...prev, seconds: Math.max(0, prev.seconds - 1) }));
        }, 1000);
        return () => window.clearTimeout(timerId);
    }, [cooldown]);

    const switchTab = (nextTab) => {
        if (loading) return;
        // 找回密码填的是新密码，不沿用登录框里输错的那个
        if (nextTab === "reset" || tab === "reset") {
            setPassword("");
            setConfirmPassword("");
        }
        setTab(nextTab);
        setRegisterStep("qrcode");
        setVerificationCode("");
        setCodeSentTo(null);
        setMessage("");
    };

    const handleUsernameChange = (value) => {
        if (message) setMessage("");
        setUsername(value);
    };

    const handlePasswordChange = (value) => {
        if (message) setMessage("");
        setPassword(value);
    };

    const handleConfirmPasswordChange = (value) => {
        if (message) setMessage("");
        setConfirmPassword(value);
    };

    const togglePasswordVisibility = () => {
        setShowPassword((prev) => !prev);
    };

    const handleQqChange = (value) => {
        if (message) setMessage("");
        setQq(value);
    };

    const handleVerificationCodeChange = (value) => {
        if (message) setMessage("");
        // 允许直接粘贴机器人整条消息：验证码是消息里最先出现的数字
        setVerificationCode(value.replace(/\D/g, "").slice(0, VERIFICATION_CODE_LENGTH));
    };

    const showRequestError = (err, request) => {
        if (closingRef.current || request.cancelled) return;
        if (request.timedOut || (err && err.name === "RequestTimeoutError")) {
            setMessage(appendRequestId(t('auth:page.error.timeout'), request.requestId));
        } else if (err && err.name === "AbortError") {
            setMessage(t('auth:page.cancelled'));
        } else {
            setMessage(appendRequestId(t('auth:page.error.networkWithMessage', { message: err && err.message ? err.message : t('auth:page.error.retryLater') }), request.requestId));
        }
    };

    const handleLogin = async (e) => {
        e && e.preventDefault();
        if (loading) return;
        setMessage("");
        const normalizedUsername = username.trim();
        if (!normalizedUsername || !password) return setMessage(t('auth:page.login.missingFields'));
        if (normalizedUsername.length > MAX_USERNAME_LENGTH) return setMessage(t('auth:page.usernameTooLong', { MAX_USERNAME_LENGTH }));
        if (password.length > MAX_PASSWORD_LENGTH) return setMessage(t('auth:page.passwordTooLong', { MAX_PASSWORD_LENGTH }));
        const request = startRequest();
        reportAuthStage(backendUrl, request.requestId, 'submitted', isIOSChrome() ? 'crios' : 'other');
        try {
            const { response: res, data } = await fetchResponseWithTimeout(withRequestId(`${backendUrl}/users/login`, request.requestId), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: formBody({ username: normalizedUsername, password, ...clientFields() })
            }, request);
            reportAuthStage(backendUrl, request.requestId, 'response_received', String(res.status));
            if (request.cancelled || activeRequestRef.current !== request) return;
            if (res.ok) {
                if (data.user && data.token) {
                    reportAuthStage(backendUrl, request.requestId, 'success_payload_valid');
                    finishRequest(request);
                    reportAuthStage(backendUrl, request.requestId, 'success_callback_started');
                    onLoginSuccess && onLoginSuccess(data.user, data.token, request.requestId);
                    reportAuthStage(backendUrl, request.requestId, 'success_callback_returned');
                } else {
                    setMessage(t('auth:page.login.noUserInfo'));
                }
            } else {
                setMessage(appendRequestId(getFriendlyErrorMessage(res.status, data.error, t('auth:page.login.action')), data.requestId));
            }
        } catch (err) {
            if (closingRef.current) return;
            if (request.cancelled) return;
            if (request.timedOut || (err && err.name === "RequestTimeoutError")) {
                reportAuthStage(backendUrl, request.requestId, 'request_timed_out');
                setMessage(appendRequestId(t('auth:page.error.timeout'), request.requestId));
            } else if (err && err.name === "AbortError") {
                setMessage(t('auth:page.cancelled'));
            } else {
                reportAuthStage(backendUrl, request.requestId, 'request_failed', err && err.name);
                setMessage(appendRequestId(t('auth:page.error.networkWithMessage', { message: err && err.message ? err.message : t('auth:page.error.retryLater') }), request.requestId));
            }
        } finally {
            finishRequest(request);
        }
    };

    // 让 QQ 机器人把验证码私聊发到填写的 QQ（注册与找回密码共用）
    const handleSendCode = async () => {
        if (loading) return;
        setMessage("");
        const normalizedQq = qq.trim();
        if (!QQ_PATTERN.test(normalizedQq)) return setMessage(t('auth:page.code.invalidQq'));
        if (cooldown.seconds > 0 && cooldown.qq === normalizedQq) return;
        const purpose = tab === "reset" ? CODE_PURPOSE.reset : CODE_PURPOSE.register;
        const request = startRequest("code");
        try {
            const { response: res, data } = await fetchResponseWithTimeout(withRequestId(`${backendUrl}/users/verification-code`, request.requestId), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: formBody({ qq: normalizedQq, purpose })
            }, request, SEND_CODE_TIMEOUT_MS);
            if (request.cancelled || activeRequestRef.current !== request) return;
            if (res.ok) {
                setCooldown({ qq: normalizedQq, seconds: Number(data.resend_after) || DEFAULT_RESEND_SECONDS });
                setCodeSentTo({ qq: normalizedQq, minutes: Math.max(1, Math.round((Number(data.expires_in) || 300) / 60)) });
            } else {
                const retryAfter = Number(data.retry_after);
                if (res.status === 429 && retryAfter > 0 && retryAfter <= MAX_COUNTDOWN_SECONDS) {
                    setCooldown({ qq: normalizedQq, seconds: retryAfter });
                }
                setMessage(appendRequestId(getFriendlyErrorMessage(res.status, data.error, t('auth:page.code.action')), data.requestId));
            }
        } catch (err) {
            showRequestError(err, request);
        } finally {
            finishRequest(request);
        }
    };

    const handleRegister = async (e) => {
        e && e.preventDefault();
        if (loading) return;
        setMessage("");
        const normalizedUsername = username.trim();
        const normalizedQq = qq.trim();
        const normalizedCode = verificationCode.trim();
        if (!normalizedUsername || !password || !confirmPassword || !normalizedQq || !normalizedCode) return setMessage(t('auth:page.register.missingFields'));
        if (normalizedUsername.length > MAX_USERNAME_LENGTH) return setMessage(t('auth:page.usernameTooLong', { MAX_USERNAME_LENGTH }));
        if (password.length > MAX_PASSWORD_LENGTH) return setMessage(t('auth:page.passwordTooLong', { MAX_PASSWORD_LENGTH }));
        if (password !== confirmPassword) return setMessage(t('auth:page.register.passwordMismatch'));
        if (!QQ_PATTERN.test(normalizedQq)) return setMessage(t('auth:page.code.invalidQq'));
        if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) return setMessage(t('auth:page.code.invalidCode'));
        const request = startRequest();
        try {
            const { response: res, data } = await fetchResponseWithTimeout(withRequestId(`${backendUrl}/users/register`, request.requestId), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: formBody({ username: normalizedUsername, password, qq: normalizedQq, verificationCode: normalizedCode, ...clientFields() })
            }, request);
            if (request.cancelled || activeRequestRef.current !== request) return;
            if (res.ok || res.status === 201) {
                // 注册接口会返回 { user, token }，若返回 token 则自动登录
                if (data.user && data.token) {
                    onLoginSuccess && onLoginSuccess(data.user, data.token);
                    setMessage(t('auth:page.register.success'), "success");
                } else {
                    setMessage(t('auth:page.register.successReturn'), "success");
                    setTab("login");
                }
            } else {
                setMessage(appendRequestId(getFriendlyErrorMessage(res.status, data.error, t('auth:page.register.action')), data.requestId));
            }
        } catch (err) {
            showRequestError(err, request);
        } finally {
            finishRequest(request);
        }
    };

    const handleReset = async (e) => {
        e && e.preventDefault();
        if (loading) return;
        setMessage("");
        const normalizedQq = qq.trim();
        const normalizedCode = verificationCode.trim();
        if (!normalizedQq || !normalizedCode || !password || !confirmPassword) return setMessage(t('auth:page.reset.missingFields'));
        if (!QQ_PATTERN.test(normalizedQq)) return setMessage(t('auth:page.code.invalidQq'));
        if (!VERIFICATION_CODE_PATTERN.test(normalizedCode)) return setMessage(t('auth:page.code.invalidCode'));
        if (password.length < MIN_RESET_PASSWORD_LENGTH) return setMessage(t('auth:page.reset.passwordTooShort', { MIN_RESET_PASSWORD_LENGTH }));
        if (password.length > MAX_PASSWORD_LENGTH) return setMessage(t('auth:page.passwordTooLong', { MAX_PASSWORD_LENGTH }));
        if (password !== confirmPassword) return setMessage(t('auth:page.register.passwordMismatch'));
        const request = startRequest();
        try {
            const { response: res, data } = await fetchResponseWithTimeout(withRequestId(`${backendUrl}/users/password-reset`, request.requestId), {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: formBody({ qq: normalizedQq, verificationCode: normalizedCode, newPassword: password, ...clientFields() })
            }, request);
            if (request.cancelled || activeRequestRef.current !== request) return;
            if (res.ok) {
                // 重设成功后直接以该住民身份登录（其他设备上的会话已被撤销）
                if (data.user && data.token) {
                    onLoginSuccess && onLoginSuccess(data.user, data.token);
                    setMessage(t('auth:page.reset.success'), "success");
                } else {
                    if (data.user && data.user.username) setUsername(data.user.username);
                    setTab("login");
                    setMessage(t('auth:page.reset.successReturn'), "success");
                }
            } else {
                setMessage(appendRequestId(getFriendlyErrorMessage(res.status, data.error, t('auth:page.reset.action')), data.requestId));
            }
        } catch (err) {
            showRequestError(err, request);
        } finally {
            finishRequest(request);
        }
    };

    const dark = useDarkMode();
    const themeColor = getThemeColor();
    const uiColors = { ...getStaticColors(dark), ...getThemeUIColors(themeColor) };

    const isSuccessMessage = notice.tone === "success";
    const submitting = loading && pendingAction === "submit";
    const modeText = tab === "login"
        ? t('auth:page.login.mode')
        : tab === "register" ? t('auth:page.register.mode') : t('auth:page.reset.mode');
    const modeHint = tab === "login"
        ? t('auth:page.login.hint')
        : tab === "reset"
            ? t('auth:page.reset.hint')
            : registerStep === "qrcode"
                ? t('auth:page.register.qrHint')
                : t('auth:page.register.hint');
    const submitButtonText = tab === "login"
        ? (submitting ? t('auth:page.login.submitting') : t('auth:page.login.submit'))
        : tab === "register"
            ? (submitting ? t('auth:page.register.submitting') : t('auth:page.register.submit'))
            : (submitting ? t('auth:page.reset.submitting') : t('auth:page.reset.submit'));
    const labelStyle = {
        display: "block",
        marginBottom: 6,
        fontSize: 13,
        color: uiColors.textMuted
    };
    const submitButtonStyle = {
        marginTop: 14,
        padding: "10px 12px",
        borderRadius: 8,
        border: `1px solid ${uiColors.primaryActionBorder}`,
        fontWeight: 700,
        letterSpacing: "0.02em"
    };
    const linkButtonStyle = {
        border: "none",
        background: "transparent",
        padding: "4px 2px",
        color: uiColors.tabActiveText,
        fontSize: 13,
        cursor: loading ? "not-allowed" : "pointer",
        opacity: loading ? 0.7 : 1
    };

    const renderPasswordField = ({ id, label, placeholder, value, onChange }) => (
        <div style={{ marginTop: 10 }}>
            <label htmlFor={id} style={labelStyle}>{label}</label>
            <div style={{ position: 'relative' }}>
                <TextInput
                    id={id}
                    type={showPassword ? "text" : "password"}
                    placeholder={placeholder}
                    value={value}
                    autoComplete="new-password"
                    maxLength={MAX_PASSWORD_LENGTH}
                    onChange={(e) => onChange(e.target.value)}
                    style={{ width: '100%', paddingRight: 40 }}
                />
                <button
                    type="button"
                    onClick={togglePasswordVisibility}
                    tabIndex={-1}
                    aria-label={showPassword ? t('auth:page.field.hidePassword') : t('auth:page.field.showPassword')}
                    style={{
                        position: 'absolute',
                        right: 8,
                        top: '50%',
                        transform: 'translateY(-50%)',
                        border: 'none',
                        background: 'transparent',
                        cursor: 'pointer',
                        padding: 4,
                        lineHeight: 0,
                        color: uiColors.textMuted,
                        fontSize: 20
                    }}
                >
                    <span className="material-symbols-outlined" style={{ fontSize: 20 }}>
                        {showPassword ? "visibility_off" : "visibility"}
                    </span>
                </button>
            </div>
        </div>
    );

    // QQ 号 + 获取验证码按钮 + 验证码输入框
    const renderVerificationFields = (idPrefix) => {
        const normalizedQq = qq.trim();
        const coolingDown = cooldown.seconds > 0 && cooldown.qq === normalizedQq;
        const sentToCurrentQq = !!codeSentTo && codeSentTo.qq === normalizedQq;
        const sendLabel = loading && pendingAction === "code"
            ? t('auth:page.code.sending')
            : coolingDown
                ? t('auth:page.code.resendIn', { seconds: cooldown.seconds })
                : sentToCurrentQq ? t('auth:page.code.resend') : t('auth:page.code.send');
        return (
            <>
                <div style={{ marginTop: 10 }}>
                    <label htmlFor={`${idPrefix}-qq`} style={labelStyle}>{t('common:label.qq')}</label>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <TextInput
                            id={`${idPrefix}-qq`}
                            type="text"
                            inputMode="numeric"
                            autoComplete="off"
                            placeholder={t('auth:page.field.qqPlaceholder')}
                            value={qq}
                            maxLength={MAX_QQ_LENGTH}
                            onChange={(e) => handleQqChange(e.target.value)}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                        <Button
                            type="button"
                            onClick={handleSendCode}
                            disabled={loading || coolingDown}
                            style={{
                                flexShrink: 0,
                                height: 44,
                                boxSizing: 'border-box',
                                padding: '0 14px',
                                borderRadius: 22,
                                border: `1px solid ${uiColors.primaryActionBorder}`,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                fontVariantNumeric: 'tabular-nums',
                                opacity: coolingDown ? 0.6 : 1
                            }}
                        >
                            {sendLabel}
                        </Button>
                    </div>
                </div>
                <div style={{ marginTop: 10 }}>
                    <label htmlFor={`${idPrefix}-code`} style={labelStyle}>{t('auth:page.field.verificationCode')}</label>
                    <TextInput
                        id={`${idPrefix}-code`}
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder={t('auth:page.field.verificationCodePlaceholder')}
                        value={verificationCode}
                        onChange={(e) => handleVerificationCodeChange(e.target.value)}
                        aria-describedby={sentToCurrentQq ? `${idPrefix}-code-hint` : undefined}
                        style={{ width: '100%', letterSpacing: verificationCode ? '0.2em' : undefined }}
                    />
                    {sentToCurrentQq && (
                        <p id={`${idPrefix}-code-hint`} style={{ margin: '6px 2px 0', fontSize: 12, color: uiColors.textMuted, lineHeight: 1.5 }}>
                            {t('auth:page.code.sent', { qq: codeSentTo.qq, minutes: codeSentTo.minutes })}
                        </p>
                    )}
                </div>
            </>
        );
    };

    return (
        <ScrollableView
            className="fm-auth-page"
            aria-labelledby="auth-modal-title"
            data-sheet-scroll=""
            style={{
                width: "100%",
                boxSizing: "border-box",
                maxHeight: "100%",
                overflowY: "auto",
                overscrollBehavior: "contain",
                background: uiColors.panelBackground,
                padding: 18
            }}
        >
            <h2 id="auth-modal-title" style={{ margin: "0 0 10px 0", fontSize: 20, color: uiColors.textStrong }}>{t('auth:page.title')}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                <div className="fm-auth-tabs" style={{ display: "inline-flex", gap: 4, padding: 4, borderRadius: 'var(--radius-md)', border: `1px solid ${uiColors.border}`, background: uiColors.tabGroupBackground }}>
                    <Button
                        type="button"
                        aria-pressed={tab !== "register"}
                        disabled={loading}
                        onClick={() => switchTab("login")}
                        style={getTabButtonStyle(tab !== "register", loading, uiColors)}
                    >
                        {t('auth:page.tab.login')}
                    </Button>
                    <Button
                        type="button"
                        aria-pressed={tab === "register"}
                        disabled={loading}
                        onClick={() => switchTab("register")}
                        style={getTabButtonStyle(tab === "register", loading, uiColors)}
                    >
                        {t('auth:page.tab.register')}
                    </Button>
                </div>
                <div style={{ marginLeft: "auto" }}>
                    <Button
                        type="button"
                        onClick={handleClose}
                        style={{ border: `1px solid ${uiColors.border}`, borderRadius: 8, padding: "7px 10px" }}
                    >
                        {loading ? t('auth:page.cancelAndClose') : t('common:action.close')}
                    </Button>
                </div>
            </div>

            <p style={{ margin: "0 0 12px 0", fontSize: 13, color: uiColors.textMuted }}>
                {t('auth:page.currentModePrefix')}<strong style={{ color: uiColors.textStrong }}>{modeText}</strong>{tx('auth:page.currentModeHint', { modeHint })}
            </p>

            {tab === "login" ? (
                <form onSubmit={handleLogin}>
                    <div>
                        <label htmlFor="auth-username" style={labelStyle}>{t('auth:page.field.username')}</label>
                        <TextInput
                            id="auth-username"
                            placeholder={t('auth:page.field.usernamePlaceholder')}
                            value={username}
                            autoComplete="username"
                            maxLength={MAX_USERNAME_LENGTH}
                            onChange={(e) => handleUsernameChange(e.target.value)}
                            style={{ width: '100%' }}
                        />
                    </div>
                    <div style={{ marginTop: 10 }}>
                        <label htmlFor="auth-password-login" style={labelStyle}>{t('auth:page.field.password')}</label>
                        <TextInput
                            id="auth-password-login"
                            type="password"
                            placeholder={t('auth:page.field.passwordPlaceholder')}
                            value={password}
                            autoComplete="current-password"
                            maxLength={MAX_PASSWORD_LENGTH}
                            onChange={(e) => handlePasswordChange(e.target.value)}
                            style={{ width: '100%' }}
                        />
                    </div>
                    <div style={{ marginTop: 6, textAlign: "right" }}>
                        <button type="button" disabled={loading} onClick={() => switchTab("reset")} style={linkButtonStyle}>
                            {t('auth:page.reset.entry')}
                        </button>
                    </div>
                    <Button
                        type="submit"
                        disabled={loading}
                        full
                        style={{ ...submitButtonStyle, marginTop: 8 }}
                    >
                        {submitButtonText}
                    </Button>
                </form>
            ) : tab === "reset" ? (
                <form onSubmit={handleReset}>
                    {renderVerificationFields("auth-reset")}
                    {renderPasswordField({
                        id: "auth-password-reset",
                        label: t('auth:page.field.newPassword'),
                        placeholder: t('auth:page.field.newPasswordPlaceholder'),
                        value: password,
                        onChange: handlePasswordChange
                    })}
                    {renderPasswordField({
                        id: "auth-confirm-password-reset",
                        label: t('auth:page.field.confirmPassword'),
                        placeholder: t('auth:page.field.confirmPasswordPlaceholder'),
                        value: confirmPassword,
                        onChange: handleConfirmPasswordChange
                    })}
                    <Button
                        type="submit"
                        disabled={loading}
                        full
                        style={submitButtonStyle}
                    >
                        {submitButtonText}
                    </Button>
                    <div style={{ marginTop: 8, textAlign: "center" }}>
                        <button type="button" disabled={loading} onClick={() => switchTab("login")} style={linkButtonStyle}>
                            {t('auth:page.reset.back')}
                        </button>
                    </div>
                </form>
            ) : registerStep === "qrcode" ? (
                <div style={{ textAlign: 'center' }}>
                    <p style={{ margin: "0 0 12px 0", fontSize: 14, color: uiColors.textStrong, lineHeight: 1.6 }}>
                        {t('auth:page.register.qrLine1')}<br />{t('auth:page.register.qrLine2')}
                    </p>
                    <img
                        src={qrcodeImg}
                        alt={t('auth:page.register.qrAlt')}
                        style={{
                            width: 200,
                            height: 200,
                            display: 'block',
                            margin: '0 auto 16px auto',
                            border: `1px solid ${uiColors.border}`,
                            borderRadius: 8
                        }}
                    />
                    <p style={{ margin: "0 0 12px 0", fontSize: 14, color: uiColors.textStrong, lineHeight: 1.6 }}>
                        {t('auth:page.register.qqGroup')}
                    </p>
                    <Button
                        type="button"
                        full
                        onClick={() => setRegisterStep("form")}
                        style={{ ...submitButtonStyle, marginTop: 0 }}
                    >
                        {t('auth:page.register.joinedGroup')}
                    </Button>
                </div>
            ) : (
                <form onSubmit={handleRegister}>
                    <div>
                        <label htmlFor="auth-username-register" style={labelStyle}>{t('auth:page.field.username')}</label>
                        <TextInput
                            id="auth-username-register"
                            placeholder={t('auth:page.field.usernamePlaceholder')}
                            value={username}
                            autoComplete="username"
                            maxLength={MAX_USERNAME_LENGTH}
                            onChange={(e) => handleUsernameChange(e.target.value)}
                            style={{ width: '100%' }}
                        />
                    </div>
                    {renderPasswordField({
                        id: "auth-password-register",
                        label: t('auth:page.field.password'),
                        placeholder: t('auth:page.field.newPasswordPlaceholder'),
                        value: password,
                        onChange: handlePasswordChange
                    })}
                    {renderPasswordField({
                        id: "auth-confirm-password-register",
                        label: t('auth:page.field.confirmPassword'),
                        placeholder: t('auth:page.field.confirmPasswordPlaceholder'),
                        value: confirmPassword,
                        onChange: handleConfirmPasswordChange
                    })}
                    {renderVerificationFields("auth-register")}
                    <Button
                        type="submit"
                        disabled={loading}
                        full
                        style={submitButtonStyle}
                    >
                        {submitButtonText}
                    </Button>
                </form>
            )}

            {slowConnection && (
                <div
                    role="status"
                    aria-live="polite"
                    style={{
                        marginTop: 12,
                        padding: "10px 11px",
                        borderRadius: 8,
                        border: "1px solid var(--color-warning)",
                        color: "var(--color-text-primary)",
                        background: "color-mix(in srgb, var(--color-warning) 12%, var(--color-bg-surface))",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        fontSize: 13
                    }}
                >
                    <span>{t('auth:page.slowConnection')}</span>
                    <Button type="button" onClick={() => cancelRequest(true)} style={{ flexShrink: 0, padding: "6px 9px" }}>
                        {t('auth:page.cancelRequest')}
                    </Button>
                </div>
            )}

            {message && (
                <p
                    role="status"
                    aria-live="polite"
                    style={{
                        marginTop: 12,
                        padding: "9px 11px",
                        borderRadius: 8,
                        border: `1px solid ${isSuccessMessage ? 'var(--color-success)' : 'var(--color-danger)'}`,
                        color: isSuccessMessage ? uiColors.successText : uiColors.errorText,
                        background: isSuccessMessage ? uiColors.successBackground : uiColors.errorBackground,
                        overflowWrap: "anywhere",
                        whiteSpace: "pre-wrap"
                    }}
                >
                    {message}
                </p>
            )}
        </ScrollableView>
    );
}
