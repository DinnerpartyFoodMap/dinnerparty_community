# 设计变量

tokens.json 是颜色、字体、阴影、圆角、间距、字号、字重、层级的唯一来源，`npm run tokens` 生成 tokens.generated.css（网页 CSS 变量）与 `ios/App/App/DesignTokens.swift`（原生 `FM` 常量）；tokens.css 引入生成文件并放焦点环等基础规则，由 main.jsx 导入。住民可改的主题色由 theme 在运行时覆盖 `--theme-*`。规格见 [设计参考](../../../doc/DESIGN_SYSTEM.md)；现有行内样式按页面逐步迁移。

维护流程：改 tokens.json → `npm run tokens` → `npm run test:design-tokens`（同步与对比度）→ 核对公共组件和业务页面 → 检查桌面/窄屏/深色/原生安全区。选用 CSS 变量便于跨组件复用，对照把每处数值独立复制更易同步；已有巨量行内样式需分步迁移，不以强行统一数值为目标。

案例（待视觉回归自动化）：STY-C01 主题变化不改变布局尺寸；STY-C02 320px 窄屏和安全区不遮挡操作；STY-C03 reduced motion 与高对比文字可用。位置和日记浏览器测试覆盖部分窄屏，完整设计变量覆盖见 UI-01 的 [清单](../../../doc/HISTORY_AND_TODO.md)。
