const zlib = require('zlib');

// JSON 响应压缩（客户端接受 br 时用 br，否则 gzip）。地图缩小时 /places/nearby 一次返回几千个地点、
// 约 3 MB JSON，而线上反向代理没有压缩，手机网络下要几秒；压缩后约 0.4 MB。
// 只处理 res.json / res.send 发出的 JSON 字符串或 Buffer：流式响应（地图代理）、图片、
// 已带 Content-Encoding 或 Cache-Control: no-transform 的响应原样发送。
// 压缩在 libuv 线程池里完成，不占用事件循环。
const DEFAULT_THRESHOLD = 1024;

function chooseEncoding(req) {
    if (req.acceptsEncodings('br')) return 'br';
    if (req.acceptsEncodings('gzip')) return 'gzip';
    return null;
}

function jsonCompression({ threshold = DEFAULT_THRESHOLD, brotliQuality = 4, gzipLevel = 6 } = {}) {
    return function jsonCompressionMiddleware(req, res, next) {
        if (req.method === 'HEAD') return next();
        const send = res.send;
        res.send = function sendMaybeCompressed(body) {
            // 对象交给原 send → res.json → 回到这里时已是字符串
            if (typeof body !== 'string' && !Buffer.isBuffer(body)) return send.call(this, body);
            res.send = send;
            const type = String(res.getHeader('Content-Type') || '');
            if (!/json/i.test(type)
                || Buffer.byteLength(body) < threshold
                || res.getHeader('Content-Encoding')
                || res.statusCode === 204 || res.statusCode === 304
                || /no-transform/i.test(String(res.getHeader('Cache-Control') || ''))) {
                return send.call(this, body);
            }
            res.vary('Accept-Encoding');
            const encoding = chooseEncoding(req);
            if (!encoding) return send.call(this, body);
            const input = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
            const finish = (error, output) => {
                if (res.headersSent || res.writableEnded || res.destroyed) return;
                if (error) return send.call(res, body);
                res.setHeader('Content-Encoding', encoding);
                // 原 send 收到字符串时会补 charset，收到 Buffer 时不会
                if (typeof body === 'string' && !/charset=/i.test(type)) res.setHeader('Content-Type', `${type}; charset=utf-8`);
                send.call(res, output);
            };
            if (encoding === 'br') {
                zlib.brotliCompress(input, {
                    params: {
                        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
                        [zlib.constants.BROTLI_PARAM_QUALITY]: brotliQuality,
                        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: input.length
                    }
                }, finish);
            } else {
                zlib.gzip(input, { level: gzipLevel }, finish);
            }
            return this;
        };
        next();
    };
}

module.exports = { jsonCompression };
