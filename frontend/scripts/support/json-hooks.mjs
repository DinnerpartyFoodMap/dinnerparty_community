// 由 json-modules.mjs 注册的模块加载钩子：
// - 没有 import 属性的 .json 当作 export default 的 ES 模块加载（src/i18n 引入文案文件时不带 with { type: 'json' }）；
// - 图片（png / jpg / gif / webp / svg）像 Vite 一样导出一个地址字符串，样式表（.css）导出空模块，
//   这样引用了素材的模块（如 map/markerContent.js）也能在 Node 里测试。
import { readFile } from 'node:fs/promises';

const ASSET = /\.(png|jpe?g|gif|webp|svg)$/i;

export async function load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.json') && context.importAttributes?.type !== 'json') {
        const source = await readFile(new URL(url), 'utf8');
        return { format: 'module', source: `export default ${source};`, shortCircuit: true };
    }
    if (url.startsWith('file:') && ASSET.test(url)) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        return { format: 'module', source: `export default ${JSON.stringify(`/assets/${name}`)};`, shortCircuit: true };
    }
    if (url.startsWith('file:') && url.endsWith('.css')) {
        return { format: 'module', source: 'export default "";', shortCircuit: true };
    }
    return nextLoad(url, context);
}
