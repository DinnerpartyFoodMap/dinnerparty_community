import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { markdownToNativeInline, markdownToPlainText, renderMarkdownHtml } from '../../../src/components/markdown/markdownText.js';
import { MARKDOWN_SANITIZE_CONFIG } from '../../../src/components/markdown/markdownSanitize.js';

const require = createRequire(import.meta.url);
const backend = require('../../../../backend/modules/places/services/markdownText.js');

// 渲染：GFM、单个换行即换行、图片显示为链接（不加载外链图片）
{
    const html = renderMarkdownHtml('## 招牌\n**牛肉粉**很好吃\n第二行\n\n- 一\n- 二\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n![门头](https://x.com/a.png) ~~休息~~');
    for (const part of ['<h2>招牌</h2>', '<strong>牛肉粉</strong>很好吃<br>第二行', '<li>一</li>', '<table>', '<del>休息</del>', '<a href="https://x.com/a.png">门头</a>']) {
        assert.ok(html.includes(part), `缺少 ${part}`);
    }
    assert.ok(!html.includes('<img'), '图片不直接加载');
    assert.equal(renderMarkdownHtml('   '), '');
    assert.equal(renderMarkdownHtml(null), '');
    // HTML 交给 DOMPurify 清理，marked 本身原样输出
    assert.ok(renderMarkdownHtml('<script>alert(1)</script>').includes('<script>'));
}

// 裸网址：只到第一个非 ASCII 字符，句末标点与不成对的右括号不算
{
    const links = (text) => [...renderMarkdownHtml(text).matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)].map((m) => m[1]);
    assert.deepEqual(links('看 https://x.com/a。很好吃'), ['https://x.com/a']);
    assert.deepEqual(links('看 https://x.com/a很好吃'), ['https://x.com/a']);
    assert.deepEqual(links('(见 https://x.com/a) 和 https://x.com/b?c=1.'), ['https://x.com/a', 'https://x.com/b?c=1']);
    assert.deepEqual(links('https://zh.wikipedia.org/wiki/A_(B)'), ['https://zh.wikipedia.org/wiki/A_(B)']);
    assert.deepEqual(links('[文字](https://x.com/中文路径)'), [`https://x.com/${encodeURI('中文路径')}`], '显式链接不受影响（marked 会编码）');
}

// 清理白名单：没有脚本、样式、表单、媒体与嵌入；链接只允许 http / https / mailto
{
    const { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP } = MARKDOWN_SANITIZE_CONFIG;
    for (const tag of ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'img', 'svg', 'math', 'video', 'audio', 'source', 'form', 'input', 'button', 'textarea', 'select', 'link', 'meta', 'base', 'template']) {
        assert.ok(!ALLOWED_TAGS.includes(tag), `不应允许 <${tag}>`);
    }
    for (const attr of ['style', 'class', 'id', 'src', 'srcset', 'action', 'formaction', 'target', 'name']) assert.ok(!ALLOWED_ATTR.includes(attr), `不应允许 ${attr}`);
    assert.ok(ALLOWED_ATTR.every((attr) => !attr.startsWith('on')));
    for (const good of ['https://x.com', 'http://x.com', 'mailto:a@b.c']) assert.ok(ALLOWED_URI_REGEXP.test(good), good);
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:x', 'data:text/html,x', 'vbscript:x', '/admin', '//evil.test', '#top']) assert.ok(!ALLOWED_URI_REGEXP.test(bad), bad);
}

// 纯文本：去掉标记与 HTML 标签（脚本内容也去掉），解码实体，保留换行；有序列表保留序号
assert.equal(markdownToPlainText('## 招牌 & <b>粗</b>\n**牛肉粉** `a<b>` [点评](https://x.com/a)\n第二行 &amp; x\n\n- 一 *斜*\n- 二\n\n3. 三\n\n> 引 **粗**\n\n<div>块级 <i>html</i><script>alert(1)</script></div>\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---'),
    '招牌 & 粗\n牛肉粉 a<b> 点评\n第二行 & x\n一 斜\n二\n3. 三\n引 粗\n块级 html\na b\n1 2');
assert.equal(markdownToPlainText('  普通文字  '), '普通文字', '没有 Markdown 的描述不变');
assert.equal(markdownToPlainText('snake_case_name 与 2 * 3 * 4'), 'snake_case_name 与 2 * 3 * 4');
assert.equal(markdownToPlainText(''), '');

// iOS 原生：块级展开、行内保留、HTML 标签去掉、其余字符转义；只保留 http(s) / mailto 链接
assert.equal(markdownToNativeInline('# 招牌\n**牛肉粉** <b>x</b> a_b\n\n- 一\n- 二\n\n1. 三\n\n[链](https://x.com/(a)) [坏](javascript:x) `c`\n\n---'),
    '**招牌**\n\n**牛肉粉** x a\\_b\n\n• 一\n• 二\n\n1. 三\n\n[链](https://x.com/%28a%29) 坏 `c`\n\n────────');
assert.equal(markdownToNativeInline('1 < 2 &amp; *x*'), '1 \\< 2 & *x*');
assert.equal(markdownToNativeInline('`` a`b ``'), '``a`b``', '代码里有反引号时加长分隔');

// 后端纯文本与前端一致（分享页、QQ 机器人用后端版本）
const samples = [
    '', '普通文字', '# 标题\n正文', '**粗** *斜* ~~删~~ `码`', '- a\n- b\n\n1. c', '> 引用\n> 第二行', '```\ncode <x>\n```', '---',
    '[a](https://x.com) ![b](https://x.com/b.png) https://example.com/c。后文', '<b>html</b> &amp; "quote" &#x4E2D;', 'snake_case_name', '\\*escaped\\*',
    '[坏](javascript:alert(1)) 后面', '**未闭合 *也是', '<div>块 <script>x</script></div>', '| a | b |\n|---|---|\n| 1 | 2 |', '- [ ] 待办\n- [x] 完成'
];
for (const sample of samples) assert.equal(backend.markdownToPlainText(sample), markdownToPlainText(sample), JSON.stringify(sample));
console.log('Markdown tests passed.');
