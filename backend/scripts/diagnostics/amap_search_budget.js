// Run on the backend host; changes apply to new requests without a restart.
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env'), quiet: true });
const { db } = require('../../infrastructure/database');
const { getSearchBudget } = require('../../modules/maps/services/amapSearchBudget');
try {
    const args = process.argv.slice(2);
    const patch = {};
    let used;
    for (const arg of args) {
        const match = /^--(enabled|monthly-limit|daily-limit|used)=(.+)$/.exec(arg);
        if (!match) throw new Error('Usage: node scripts/diagnostics/amap_search_budget.js [--enabled=true|false] [--monthly-limit=4000] [--daily-limit=0] [--used=1234]');
        const [, name, value] = match;
        if (name === 'enabled') {
            if (!['true', 'false'].includes(value)) throw new Error('enabled must be true or false');
            patch.enabled = value === 'true';
        } else {
            if (!/^\d+$/.test(value)) throw new Error(`${name} must be a non-negative integer`);
            if (name === 'used') used = Number(value);
            else patch[name === 'monthly-limit' ? 'monthlyLimit' : 'dailyLimit'] = Number(value);
        }
    }
    const budget = getSearchBudget();
    db._raw.transaction(() => {
        if (Object.keys(patch).length) budget.configure(patch);
        if (used !== undefined) budget.reconcile(used);
    }).immediate();
    console.log(JSON.stringify(budget.status(), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db.close(); }
