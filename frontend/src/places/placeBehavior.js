// Best-effort authenticated telemetry: never delay opening a map app or a share sheet.
export function recordPlaceBehavior(backendUrl, token, placeId, eventType, channel) {
    if (!backendUrl || !token || !/^[1-9]\d*$/.test(String(placeId)) || !Number.isSafeInteger(Number(placeId))) {
        return Promise.resolve(false);
    }
    try {
        const eventId = globalThis.crypto?.randomUUID?.()
            || `event_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        return fetch(`${backendUrl}/api/preferences/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ event_id: eventId, place_id: Number(placeId), event_type: eventType, channel,trigger:'user',surface:'place_card',contract_version:1 }),
            keepalive: true
        }).then((response) => response.ok).catch(() => false);
    } catch (_) {
        return Promise.resolve(false);
    }
}

// A resolved native share means handoff to the OS/app, not delivery to a recipient.
// nativeShare 返回 'shared' | 'cancelled' | 'unsupported' | 'failed'（见 platform/share.js）；
// 旧式实现（直接 resolve/reject）也兼容。用户取消属于正常操作，不复制、不提示。
export async function sharePlaceContent({ data, nativeShare, copy, record, channel }) {
    if (nativeShare) {
        let result;
        try {
            result = await nativeShare(data);
        } catch (_) {
            return 'cancelled_or_failed';
        }
        if (result === undefined || result === 'shared') {
            record('share', channel);
            return 'shared';
        }
        if (result === 'cancelled') return 'cancelled';
        if (result === 'failed') return 'cancelled_or_failed';
        // 'unsupported'：浏览器不支持系统分享，改为复制链接
    }
    return copyPlaceContent({ text: data.url, copy, record, channel });
}

export async function copyPlaceContent({ text, copy, record, channel }) {
    try {
        if (!await copy(text)) return 'failed';
        record('share_copy', channel);
        return 'copied';
    } catch (_) {
        return 'failed';
    }
}
