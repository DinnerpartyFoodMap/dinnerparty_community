export async function submitCheckIn({ retry, hasReceipt, send, locate }) {
    if (retry || hasReceipt) {
        const replay = await send();
        if (replay.ok || hasReceipt || replay.body.code !== 'CHECK_IN_LOCATION_INVALID') return replay;
    }
    return send(await locate());
}
