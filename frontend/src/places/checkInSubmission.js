// 打卡表单的上限（网页面板、原生面板与 usePlaceCheckIn 共用）
export const CHECK_IN_PHOTO_LIMIT = 3;
export const CHECK_IN_DESCRIPTION_LIMIT = 1000;

export async function submitCheckIn({ retry, hasReceipt, send, locate }) {
    if (retry || hasReceipt) {
        const replay = await send();
        if (replay.ok || hasReceipt || replay.body.code !== 'CHECK_IN_LOCATION_INVALID') return replay;
    }
    return send(await locate());
}
