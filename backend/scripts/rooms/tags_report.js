const { parseArgs } = require('node:util');
const { loadCorpus } = require('../../modules/rooms/services/roomCorpus');
const { inferTags, readActivityMinutes, activityStats } = require('../../modules/rooms/services/roomTraits');
const { openSnapshot } = require('./roomPreviewDatabase');

const SETTINGS = Object.freeze({ bins: 10 });

async function main() {
    const { values } = parseArgs({ args: process.argv.slice(2), options: { db: { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) return console.log('npm run room:tags:report -- [--db <file>]');
    const now = new Date();
    const database = openSnapshot(values.db);
    try {
        const tags = loadCorpus().tags.groups.flatMap((group) => group.tags);
        const counts = new Map(tags.map((tag) => [tag, 0]));
        const raters = database.prepare('SELECT DISTINCT user_id FROM PlaceRating ORDER BY user_id').all();
        const night = Array(SETTINGS.bins).fill(0);
        const morning = Array(SETTINGS.bins).fill(0);
        const bin = (share) => Math.min(SETTINGS.bins - 1, Math.floor(SETTINGS.bins * share));
        let haveActivity = 0;
        for (const { user_id: userId } of raters) {
            const inferred = await inferTags(database, userId, { now });
            for (const tag of inferred.tags) counts.set(tag, counts.get(tag) + 1);
            const activity = activityStats(readActivityMinutes(database, userId, now));
            if (!activity.enough) continue;
            haveActivity += 1;
            night[bin(activity.night)] += 1;
            morning[bin(activity.morning)] += 1;
        }
        const lines = [
            '# 观察屋标签推断', '', `有评价的住民 ${raters.length} 人 ｜ 作息样本充足 ${haveActivity} 人`, '',
            '| 标签 | 人数 |', '| --- | ---: |',
            ...[...counts].map(([tag, count]) => `| ${tag} | ${count} |`),
            '', '| 占比 | 夜间人数 | 早晨人数 |', '| --- | ---: | ---: |',
            ...night.map((count, i) => {
                const width = 100 / SETTINGS.bins;
                const end = (i + 1) * width;
                return `| ${i * width}%–${end === 100 ? '' : '<'}${end}% | ${count} | ${morning[i]} |`;
            })
        ];
        console.log(lines.join('\n'));
    } finally {
        database.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
