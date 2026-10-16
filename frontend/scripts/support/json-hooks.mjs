// 由 json-modules.mjs 注册的模块加载钩子：没有 import 属性的 .json 当作 export default 的 ES 模块加载。
import { readFile } from 'node:fs/promises';

export async function load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json') {
        const source = await readFile(new URL(url), 'utf8');
        return { format: 'module', source: `export default ${source};`, shortCircuit: true };
    }
    return nextLoad(url, context);
}
