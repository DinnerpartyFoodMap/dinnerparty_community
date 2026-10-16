// QQ's 图文 (link share) card: title, description, preview image and a footer,
// opening jumpUrl in the browser when tapped. NapCat has no action for it, so
// the bot sends the raw OIDB request through NapCat's `send_packet`; the QQ
// server builds, signs and delivers the card itself.
//
// Request layout from SnowLuma / WeQ (captured from Android QQ 9.3.25),
// OidbSvcTrpcTcp.0xdc2_34:
//   OidbBase { 1 command = 0xdc2, 2 subCommand = 34, 4 body }
//   body { 1 appInfo, 2 meta }
//   appInfo { 1 appId = 100446242, 2 = 1, 3 = 0 (always sent), 5 { 1 = 1 }, 11 targetId, 12 content }
//   content { 1 flag = 1, 10 title, 11 desc, 12 summary, 13 jumpUrl, 14 previewUrl (always sent) }
//   meta { 1 peerType (0 private, 1 group; always sent), 2 targetId }
// Response: OidbBase { 3 errorCode, 4 body, 5 errorMsg }, body { 1 result { 4 errorCode,
// 5 errorMessage, 6 detail { 1 message } } }. The outer code can be 0 while delivery
// failed, so only result.errorCode = 0 means the card went out. SnowLuma PR #355
// delivered it from desktop NTQQ (private chat; same bytes as this encoder); WeQ
// also saw 901501 "rule type not match appid" rejections.
const COMMAND = 0xdc2;
const SUB_COMMAND = 34;
const SSO_COMMAND = 'OidbSvcTrpcTcp.0xdc2_34';
const TUWEN_APP_ID = 100446242;
const SEND_TIMEOUT_MS = 10000;

// ---------- minimal protobuf ----------

function uvarint(value) {
    const out = [];
    let rest = value;
    do {
        let byte = rest % 128;
        rest = Math.floor(rest / 128);
        if (rest > 0) byte |= 0x80;
        out.push(byte);
    } while (rest > 0);
    return out;
}

const key = (field, wireType) => uvarint(field * 8 + wireType);
const varintField = (field, value) => [...key(field, 0), ...uvarint(value)];
function bytesField(field, bytes) {
    return [...key(field, 2), ...uvarint(bytes.length), ...bytes];
}
const stringField = (field, text) => bytesField(field, [...Buffer.from(String(text || ''), 'utf8')]);

/** Decodes one message level into { field: [values] }; varints become numbers, length-delimited fields Buffers. */
function decodeMessage(buffer) {
    const fields = {};
    let offset = 0;
    const readVarint = () => {
        let result = 0;
        let multiplier = 1;
        for (;;) {
            if (offset >= buffer.length) throw new Error('truncated varint');
            const byte = buffer[offset++];
            result += (byte & 0x7f) * multiplier;
            if (!(byte & 0x80)) return result;
            multiplier *= 128;
            if (multiplier > 2 ** 63) throw new Error('varint too long');
        }
    };
    while (offset < buffer.length) {
        const tag = readVarint();
        const field = Math.floor(tag / 8);
        const wireType = tag % 8;
        let value;
        if (wireType === 0) value = readVarint();
        else if (wireType === 2) {
            const length = readVarint();
            if (offset + length > buffer.length) throw new Error('truncated field');
            value = buffer.subarray(offset, offset + length);
            offset += length;
        } else if (wireType === 1) { value = buffer.subarray(offset, offset + 8); offset += 8; }
        else if (wireType === 5) { value = buffer.subarray(offset, offset + 4); offset += 4; }
        else throw new Error(`unsupported wire type ${wireType}`);
        (fields[field] = fields[field] || []).push(value);
    }
    return fields;
}

const first = (fields, field) => (fields[field] ? fields[field][0] : undefined);
const text = (value) => (Buffer.isBuffer(value) ? value.toString('utf8') : '');

// ---------- 0xdc2_34 ----------

/** Hex of the whole OIDB request, as NapCat's send_packet takes it. */
function encodeTuwenArkRequest({ peerType, targetId, title, desc, summary, jumpUrl, previewUrl }) {
    const target = Number(targetId);
    if (!Number.isSafeInteger(target) || target <= 0) throw new Error('invalid targetId');
    const content = [
        ...varintField(1, 1),
        ...stringField(10, title),
        ...stringField(11, desc),
        ...stringField(12, summary),
        ...stringField(13, jumpUrl),
        ...stringField(14, previewUrl)
    ];
    const appInfo = [
        ...varintField(1, TUWEN_APP_ID),
        ...varintField(2, 1),
        ...varintField(3, 0),
        ...bytesField(5, varintField(1, 1)),
        ...varintField(11, target),
        ...bytesField(12, content)
    ];
    const meta = [...varintField(1, peerType ? 1 : 0), ...varintField(2, target)];
    const body = [...bytesField(1, appInfo), ...bytesField(2, meta)];
    const envelope = [...varintField(1, COMMAND), ...varintField(2, SUB_COMMAND), ...bytesField(4, body)];
    return Buffer.from(envelope).toString('hex');
}

/** { ok, errorCode, errorMessage } from send_packet's hex answer. */
function parseTuwenArkResponse(hex) {
    if (typeof hex !== 'string' || !/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('send_packet returned no packet');
    const outer = decodeMessage(Buffer.from(hex, 'hex'));
    const outerCode = first(outer, 3) || 0;
    if (outerCode !== 0) return { ok: false, errorCode: outerCode, errorMessage: text(first(outer, 5)) };
    const body = first(outer, 4);
    const result = Buffer.isBuffer(body) && first(decodeMessage(body), 1);
    // All-default fields leave an empty result: delivered.
    if (!Buffer.isBuffer(result)) return { ok: true, errorCode: 0, errorMessage: '' };
    const fields = decodeMessage(result);
    const errorCode = first(fields, 4) || 0;
    const detail = Buffer.isBuffer(first(fields, 6)) ? decodeMessage(first(fields, 6)) : {};
    return { ok: errorCode === 0, errorCode, errorMessage: text(first(fields, 5)) || text(first(detail, 1)) };
}

/**
 * Sends the card. Resolves { ok, errorCode, errorMessage }; rejects with NapCat's
 * error (`outcomeUnknown` when the request went out but no answer came back).
 */
async function sendTuwenArk(client, params) {
    const data = encodeTuwenArkRequest(params);
    const response = await client.call('send_packet', { cmd: SSO_COMMAND, data, rsp: true }, { timeoutMs: SEND_TIMEOUT_MS });
    return parseTuwenArkResponse(response);
}

module.exports = { sendTuwenArk, encodeTuwenArkRequest, parseTuwenArkResponse, decodeMessage, SSO_COMMAND, TUWEN_APP_ID };
