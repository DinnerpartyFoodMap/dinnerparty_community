'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');
const Database = require('better-sqlite3');
const { backendPath } = require('../../infrastructure/paths');

function reportRows(database) {
    const hasTable = (name) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    const regionTable = hasTable('PlaceRegion') ? 'PlaceRegion' : '(SELECT NULL AS place_id, NULL AS city)';
    const checkTable = hasTable('PlaceChainCheck') ? 'PlaceChainCheck' : `(SELECT
        NULL AS place_id, NULL AS name_key, NULL AS verdict, NULL AS brand, NULL AS scope,
        NULL AS confidence, NULL AS source, 0 AS tag_applied, 0 AS suppressed)`;
    return database.prepare(`SELECT p.id AS place_id, p.name, r.city, p.category, p.moderation_status, c.name_key,
        c.verdict, c.brand, c.scope, c.confidence, c.source,
        COALESCE(c.tag_applied, 0) AS tag_applied, COALESCE(c.suppressed, 0) AS suppressed
        FROM Place p LEFT JOIN ${regionTable} r ON r.place_id = p.id
        LEFT JOIN ${checkTable} c ON c.place_id = p.id ORDER BY p.id`).all();
}

const csvValue = (value) => {
    const text = String(value ?? '');
    return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

async function main() {
    const { values } = parseArgs({ options: {
        db: { type: 'string' }, classify: { type: 'boolean' }, limit: { type: 'string' }, out: { type: 'string' }
    } });
    if (values.classify && !values.db) throw new Error('--classify 必须同时显式指定 --db <file>');
    const limit = values.limit === undefined ? Infinity : Number(values.limit);
    if (values.limit !== undefined && (!values.classify || !Number.isSafeInteger(limit) || limit <= 0)) {
        throw new Error('--limit 必须用于 --classify，且为正整数');
    }

    require('dotenv').config({ path: backendPath('.env'), quiet: true });
    const configured = String(process.env.DB_FILE || '').trim();
    const file = values.db ? path.resolve(values.db) : backendPath(configured || 'data.sqlite');
    const output = values.out && path.resolve(values.out);
    if (output && fs.existsSync(output) && fs.existsSync(file)) {
        const outputStat = fs.statSync(output);
        const dbStat = fs.statSync(file);
        if (outputStat.dev === dbStat.dev && outputStat.ino === dbStat.ino) throw new Error('--out 不能覆盖数据库');
    }

    const { hasDeepseekConfiguration } = require('../../infrastructure/aiClients');
    const { BATCH_SIZE, VERDICTS, classifyPlaces, hasChainTag, pendingTagCategory, readChainTagConfig, selectPendingPlaces } =
        require('../../modules/places/services/placeChainTags');
    if (values.classify && !hasDeepseekConfiguration()) throw new Error('--classify 需要 DEEPSEEK_API_KEY');
    const database = new Database(file, { readonly: !values.classify, fileMustExist: true });
    try {
        if (values.classify) {
            require('../../modules/places/services/placeRegionSchema').initPlaceRegionSchema(database);
            require('../../modules/places/services/placeChainTagSchema').initPlaceChainTagSchema(database);
            let processed = 0;
            const eligibilityTime = Date.now();
            while (processed < limit) {
                const places = selectPendingPlaces({ database, now: eligibilityTime, limit: Math.min(BATCH_SIZE, limit - processed) });
                if (!places.length) break;
                const { requestStatus } = await classifyPlaces(places, { database });
                if (requestStatus === 'failed') throw new Error('DeepSeek 批次请求失败，已停止本次连锁店判断');
                processed += places.length;
            }
        }

        const { minConfidence } = readChainTagConfig();
        const rows = reportRows(database).map((row) => ({ ...row, has_tag_now: +hasChainTag(row.category) }));
        for (const verdict of VERDICTS) console.log(`${verdict}：${rows.filter((row) => row.verdict === verdict).length}`);
        console.log(`会打：${rows.filter((row) => pendingTagCategory(row, minConfidence) !== null).length}`);
        console.log(`已打：${rows.filter((row) => row.tag_applied).length}`);
        console.log(`已锁定：${rows.filter((row) => row.suppressed).length}`);
        console.log(`人工标了但模型判为非 chain：${rows.filter((row) => row.has_tag_now && !row.tag_applied
            && row.source === 'model' && row.verdict && row.verdict !== 'chain').length}`);
        if (output) {
            const fields = ['place_id', 'name', 'city', 'category', 'verdict', 'brand', 'scope', 'confidence', 'source',
                'tag_applied', 'suppressed', 'has_tag_now'];
            const lines = rows.map((row) => fields.map((field) => csvValue(row[field])).join(','));
            fs.writeFileSync(output, `${[fields.join(','), ...lines].join('\r\n')}\r\n`, 'utf8');
        }
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
