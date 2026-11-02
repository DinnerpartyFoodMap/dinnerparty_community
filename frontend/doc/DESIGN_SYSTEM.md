# 东方饭联地图 · 设计参考（网页 + iOS）

本文是前端视觉的唯一参考：网页（浏览器、Android / iOS 的 WebView）与 iOS SwiftUI 原生页面都按这里取值。
数值写成"网页 px = iOS pt"。令牌的取值在 [tokens.json](../src/styles/tokens.json)，生成方式见第 9 节。
旧页面仍有大量行内样式没有迁移到这里的规格，按页面逐步改。

## 0. 原则

1. **一份令牌，两端生成。** 颜色、字号、圆角、间距、阴影只在令牌源里定义一次，CSS 变量和 Swift 常量都由它生成（见第 9 节），不在组件里写死数值。
2. **结构跟平台，外观跟品牌。** iOS 原生继续用系统导航、sheet、List、液态玻璃和 Dynamic Type；底色、主题色、语义色、圆角、图标含义与网页一致。
3. **材质分两层。** 浮在地图上的东西（工具栏、搜索、浮动按钮、菜单、半屏面板）用玻璃或浮层；整页（设置、个人主页、日记、后台、列表）用不透明底色。两端规则相同。
4. **App 里看不出接缝。** 从原生页进入网页页（或反过来）时，底色、标题栏、按钮形状、字号不跳变。
5. **默认外观是基准。** 皮肤只能通过 `src/skins/slots.js` 里已有的槽位覆盖；改默认值时同步 `var(--skin-…, <默认值>)` 的回退值。

## 1. 颜色

### 1.1 主题色（住民可在设置里改）

| 令牌 | 浅色默认 | 深色默认 | 用途 |
|---|---|---|---|
| `--theme-primary` | `#E2789F` | `#FF8FB1` | 主要按钮底、选中态、开关、进度、焦点环 |
| `--theme-primary-text`（新增） | 计算值，默认约 `#9E546F` | 同 primary | 主色当**文字**用：链接、文字按钮、返回、标题栏右侧操作 |
| `--theme-on-primary`（新增，替代日记的 `--journey-on-primary`） | 计算值，默认 `#2B2533` | 计算值，默认 `#2B2533` | 主色底上的文字和图标 |
| `--theme-secondary` | `#8C6BB1` | `#A882DD` | 标签/分类的选中、次要强调、图标色（`--theme-icon`） |
| `--theme-primary-0-2` / `-0-25` | 主色 20% / 25% | 同 | 焦点外圈、选中底 |
| `--theme-secondary-0-12` / `-0-2` | 辅色 12% / 20% | 同 | 标签底、信息块底 |

规则：

- 默认粉色上白字只有 2.8:1，所以 **on-primary 一律用计算值**（`pickContrastTextColor`），不写死白色。
- 浅色模式下主色当文字只有 2.8:1。`--theme-primary-text` 由 `theme.js` 在应用主题时计算：把主色逐步加深（`darkenColor`），直到在 `bg-surface` 和 `bg-overlay` 上都 ≥ 4.5:1；深色模式直接用主色（8.3:1）。
- 两个计算值由 `theme.js` 的 `applyThemeColor` 写入（`pickContrastTextColor`、`readableTextColor`），tokens.json 里是默认主题算出的结果，`test:design-tokens` 检查两者一致。
- iOS 原生从主题快照（`nativeThemeColors()`）拿 `primary`、`secondary`、`onPrimary`、`primaryText` 四个值，`tint` 用 primary，文字按钮用 primaryText。
- `--color-on-emphasis`（固定 `#2B2533`）不跟主题色走：它是红色、橙色等语义色底上的文字。

### 1.2 中性色

| 令牌 | 浅色 | 深色 | iOS 原生对应 | 用途 |
|---|---|---|---|---|
| `--color-bg-base` | `#F9F8FA` | `#121016` | `FM.bgBase`（替代 `systemGroupedBackground`） | 整页底 |
| `--color-bg-surface` | `#FFFFFF` | `#1A1625` | `FM.bgSurface`（替代 `secondarySystemGroupedBackground`） | 卡片、分组、整页上的面 |
| `--color-bg-overlay` | `#F2EEF5` | `#251F34` | `FM.bgOverlay` | 输入框底、分段控件底、悬停、次要按钮底 |
| `--color-border` | `#E6DCEB` | `#382E47` | `FM.border` | 分隔线、描边 |
| `--color-text-primary` | `#2B2533` | `#F3EFEF` | `Color.primary` | 正文、标题 |
| `--color-text-secondary` | `#6E6578` | `#9E97A9` | `.secondary` | 次要信息、组标题、说明 |
| `--color-text-muted` | `#857C90` | **`#7D748A`**（原 `#60586E`，2.6:1 不达标） | `.tertiary` | 只用于占位符、禁用态、纯装饰 |
| `--color-backdrop` | `rgba(18,16,22,.32)` | `rgba(8,6,12,.68)` | 系统 | 模态遮罩 |

规则：

- 传达信息的辅助文字用 `text-secondary`（浅 5.5:1 / 深 6.3:1）。`text-muted` 在浅色白底只有 4.0:1，只能用于占位符和禁用态。
- 玻璃面板（iOS 26 半屏 sheet、地图浮层）上的分组底继续用系统半透明填充（`tertiarySystemFill` / 网页 `--glass-*`）；不透明整页才用上表的 `bg-*`。
- 原生文字色继续用系统 `primary/secondary/tertiary`，它们和网页文字色差别很小，并且跟随系统的"增强对比度"设置。

### 1.3 语义色

| 令牌 | 浅色 | 深色 | 文字用变体（浅色，新增） | iOS 原生对应 |
|---|---|---|---|---|
| `success` | `#3D9970` | `#5CD698` | `#317A5A` | `FM.success`（替代 `.green`） |
| `warning` | `#E67E22` | `#FFB049` | `#A15818` | `FM.warning`（替代 `.orange`） |
| `danger` | `#D9534F` | `#FF6B6B` | `#B64642` | `FM.danger`（替代 `.red`） |
| `info` | `#3498DB` | `#64B5F6` | `#2670A2` | `FM.info` |

规则：

- 语义色本色只用作填充、图标、描边。浅色模式下当小字用要换 `--color-<tone>-text`（上表，≥ 4.5:1）；深色模式本色已达标。
- `tone` 名在两端含义相同：`primary` → 主色，`secondary` → 辅色，`success / warning / danger / info` → 对应语义色，空 → `text-secondary`。原生不能把 `warning` 映射成辅色、把 `success` 映射成主色。
- 淡色底统一写法：`color-mix(in srgb, <tone> 14%, var(--color-bg-surface))`，描边 `color-mix(… 40%, var(--color-border))`；原生 `tone.opacity(0.14)` + `tone.opacity(0.4)` 描边。不写死浅色十六进制（深色模式会变成亮块）。

### 1.4 评价四档

| 档位 | 颜色 | 图标（两端同一含义） |
|---|---|---|
| 4 强烈推荐 | success | 实心赞 |
| 3 均线之上 | theme-primary | 空心赞 |
| 2 均线之下 | warning | 空心踩 |
| 1 强烈拒绝 | danger | 实心踩 |

网页 Material Symbols `thumb_up` / `thumb_down`（实心用 `FILL 1`），iOS `hand.thumbsup(.fill)` / `hand.thumbsdown(.fill)`。皮肤的"评价表情"槽位照旧覆盖。两端的定义都在 `src/places/rating.js`（`icon` + `fill`、`symbol`）。

## 2. 字体

### 2.1 字体族

```css
--font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
             "Microsoft YaHei", system-ui, "Noto Sans CJK SC", sans-serif;
```

- 苹果设备是 SF + 苹方（与原生页相同），Windows 是 Segoe UI + 微软雅黑，安卓是系统字体 + Noto。
- 设在 `body` 上；`button, input, select, textarea` 继承字体族（字号仍由组件决定）。下载页 `home.css`、协议 / 隐私 / 备案页不加载主应用令牌，写同一串字面值；备案页左上角徽记的衬线体是有意的。
- 数字（人均、距离、计数、评分人数）用 `font-variant-numeric: tabular-nums`，原生 `.monospacedDigit()`。
- 等宽（兑换码、代码）：`ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`。
- Canvas 出图（海报、分享卡、日记封面）可以有自己的字号，字体族顺序与上面一致。

### 2.2 字号阶梯

网页用 CSS 变量：`--text-<名>` 是 `font` 简写（`font: var(--text-body)`），另有 `--text-<名>-size`、`-line`、`-weight` 单项；iOS 用对应的 Dynamic Type 样式（不写 `.system(size:)`，图标除外）。

| 令牌 | 字号 / 行高 | 字重 | iOS 样式 | 用途 |
|---|---|---|---|---|
| `--text-title1` | 28 / 34 | 700 | `.title.bold()` | 主页大标题、空状态大字 |
| `--text-title2` | 22 / 28 | 700 | `.title2.bold()` | 个人主页名字、评价档位大字 |
| `--text-title3` | 20 / 25 | 700 | `.title3.bold()` | 半屏面板 / 弹窗标题 |
| `--text-headline` | 17 / 22 | 600 | `.headline` | 整页标题栏、店名、列表行主文字（强调） |
| `--text-body-lg` | 17 / 24 | 400 | `.body` | 列表行主文字、设置项 |
| `--text-body` | 15 / 22 | 400 | `.subheadline` | 正文、简介、按钮文字 |
| `--text-footnote` | 13 / 18 | 400 | `.footnote` | 次要信息、组标题、说明 |
| `--text-caption` | 12 / 16 | 400 | `.caption` | 时间、计数、修改人 |
| `--text-caption2` | 11 / 13 | 600 | `.caption2` | 工具栏按钮文字、徽章 |

- 字重只用 400 / 500 / 600 / 700。不用 800、`bold` 关键字。`--weight-regular` 是 400。
- 例外：网页输入框 16px（小于 16 时 iOS Safari 聚焦会放大页面）。
- 不在阶梯里的字号（10、12.5、13.5、14、16、18、19、24、26、30、32、36）按就近原则并入：14 → 15 或 13，16 → 15 或 17，18/19 → 17 或 20，24 → 22，26 以上 → 28。

## 3. 圆角

iOS 一律 `RoundedRectangle(cornerRadius:style: .continuous)`。

| 令牌 | 值 | 用途 |
|---|---|---|
| `--radius-xs` | 6 | ≤ 40 的小缩略图、行内代码、设置项图标底（原生 30×30 图标底现为 7） |
| `--radius-sm` | 8 | 卡片里的图片、菜单项高亮、表格 |
| `--radius-md` | 12 | 输入框（单行与多行同一值）、提示条、小卡片、分段控件外框 |
| `--radius-lg` | 20 | 内容卡片、列表分组、宽屏地图店卡、原生 `NativeSheetGroup` |
| `--radius-xl` | 28 | 浮层：弹窗、侧面板、下拉菜单、浏览器里的底部面板顶角、App 内网页玻璃浮层 |
| `--radius-sheet` | 40 | 仅 App 内底部面板（与 iPhone 屏幕圆角同心，对应 iOS 26 系统 sheet） |
| `--radius-full` | 999 | 按钮、标签/筛选芯片、徽章、搜索框、圆形图标按钮、工具栏 |

嵌套规则：内层圆角 = 外层圆角 − 内边距（例如 lg 卡片 16 内边距里的图片用 sm 或 xs）。

## 4. 间距与尺寸

- 4 的倍数：`--space-1` 4、`-2` 8、`-3` 12、`-4` 16、`-5` 24、`-6` 32，新增 `--space-4-5` 20（原生分组间距、sheet 顶部）。
- 页面左右边距 16；分组之间 24；分组内行与行之间用分隔线，不加间距。
- 可点区域最小 44 × 44（图标按钮、关闭钮、列表行、工具栏按钮）。
- 列表行：左右 16、上下 11、最小高 44（与 `NativeSheetRow` 相同）。
- 整页内容最大宽度 720，居中（网页宽屏）。
- 宽屏地图店卡宽 `min(92vw, 320px)`，内边距 12。

## 5. 层级、阴影与材质

| 层级 | 网页令牌 | 用途 | App 内 |
|---|---|---|---|
| e0 | 无阴影，`1px solid var(--color-border)` | 整页里的卡片、分组 | 同 |
| e1 | `--shadow-sm` `0 2px 8px rgba(43,37,51,.10)` | 地图上的浮动按钮、搜索框（浏览器） | `--glass-shadow` |
| e2 | `--shadow-md` `0 4px 14px rgba(43,37,51,.14)` | 店卡、下拉菜单、侧面板 | `--glass-shadow` |
| e3 | `--shadow-surface` | 弹窗、底部面板 | `--glass-shadow` |

- 深色模式的阴影值已在 `--shadow-surface` 里给出；e1/e2 的深色值同样要补（目前只有浅色）。
- 玻璃（`overlay.css` 的 `--glass-*`，iOS 26 的 `glassEffect`）只用在第 0 节第 3 条说的地图浮层上；iOS 26 以前用 `.regularMaterial`。
- 层级 `z-index` 继续用 `tokens.css` 的 `--z-*`。

## 6. 图标

- 网页：Material Symbols Outlined（站内自托管的 `/fonts/material-symbols.css`），默认 `wght 400`、`FILL 0`；选中 / 已收藏用 `FILL 1`。尺寸 20（行内、卡片操作）或 24（工具栏）。
- iOS：SF Symbols，默认 `.regular`，与文字同行时跟随文字样式；选中用 `.fill` 变体。
- 两端的对应关系集中在一张表（建议 `src/platform/iconRegistry.js`：语义名 → `{ material, sfSymbol }`），业务里写语义名，不各写各的。
- 颜色：普通图标用 `text-secondary`，强调图标用 `--theme-icon`（辅色），危险操作用 danger。

## 7. 组件规格

### 7.1 按钮

| 变体 | 网页 | iOS |
|---|---|---|
| primary | 主色底、`--theme-on-primary` 字、无描边 | `.borderedProminent` + tint |
| secondary | `bg-overlay` 底、`text-primary` 字 | `.bordered` |
| plain | 透明、`--theme-primary-text` 字 | `.borderless` |
| destructive | `danger` 字；需要底时 danger 14% 底 | `role: .destructive` |

- 形状：胶囊（`--radius-full`）。尺寸 sm 32 高 / 13 号字，md 44 高 / 15 号字（默认），lg 50 高 / 17 号 600（整宽主操作）。左右内边距 16（sm 12）。
- 一组按钮里只放一个 primary。禁用：透明度 0.45，不改颜色。
- 按压：`.fm-pressable`（缩放 0.97）；原生系统按压效果。

### 7.2 图标按钮

44 × 44 圆形；默认透明底；需要底时用 `color-mix(text-primary 8%)`（原生 `Color.primary.opacity(0.08)`）。关闭按钮图标 `close` / `xmark`，17 号 semibold。

### 7.3 输入框

- 高 44，圆角 md 12，底 `bg-overlay`，1px `border`；聚焦描边换 `theme-primary` 并加 3px `--theme-primary-0-25` 外圈；错误用 danger。
- 多行同一圆角，最小高 96。搜索框例外：胶囊。
- 原生用 `nativeFieldBackground()`（12 圆角、`Color.primary.opacity(0.07)`），在玻璃上可以保留系统填充。

### 7.4 芯片 / 标签 / 徽章

| 组件 | 规格 |
|---|---|
| 筛选/分类芯片 | 胶囊，高 32，左右 12，13 号字；未选：透明底 + `border`；选中：辅色 16% 底 + 辅色描边 + 辅色字，600；排除：danger 同样写法，前面加 `block` 图标；包含：success，前面加 `check` 图标 |
| 徽章 | 胶囊，11 号 600，左右 7、上下 3；底 tone 14%，字用 tone 的文字变体 |
| 链接型芯片（展开全部） | 无描边，`--theme-primary-text` 字 |

原生只保留一个芯片实现（`NativeTagChip`），`nativeChip` 并入它。

### 7.5 卡片与分组

- 整页里的卡片：`bg-surface`、圆角 lg 20、内边距 16、e0（描边不加阴影）。
- 列表分组：同上，行之间 1px 分隔线（缩进 16）；组标题在组外，footnote、`text-secondary`，左右 16。
- 宽屏地图店卡：圆角 lg 20、e2，内边距 12。

### 7.6 面板标题栏

| 场景 | 布局 |
|---|---|
| 所有面板：弹窗、侧面板、底部面板（浏览器、App 内网页、iOS 原生一致） | 左：44 圆形关闭钮（`close` / `xmark`，底 `text-primary` 8–10%）；中：标题 title3，居中单行；右：主操作或 44 占位 |
| 整页标题栏（两端） | 左：44 圆形返回钮（`chevron_left` / `chevron.backward`，与关闭钮同样式，对应 iOS 26 导航栏的玻璃圆钮）；中：标题 headline 居中，可带一行 caption 小字；右：文字操作，`--theme-primary-text` 600；下边 1px `border` |

网页实现：面板是 `ResponsivePanel` 导出的 `PanelHeader`（地图列表面板 `MapPanel` 也用它），整页是 `components/layout/FullPageHeader`（日记 · 同好的 `PageHeader` 直接用它，右侧按钮加 `jw-header__action`）。

拖动条：36 × 5，胶囊，`border` 色，上下 8 / 4。

### 7.7 分段控件

外框 `bg-overlay`、圆角 md 12、内边距 3；选中块 `bg-surface`、圆角 9、`--shadow-sm`、主色文字 600；高 38（小号 32）。iOS 用 `.pickerStyle(.segmented)`。

### 7.8 提示与反馈

- 行内提示条：圆角 md，tone 10% 底（`color-mix`），左侧图标，15 号字。
- Toast：胶囊或 md 圆角，e3，屏幕底部安全区上方 16。
- 空状态：图标 40（`text-muted`）+ headline + footnote 说明 + 可选 md 按钮，居中。
- AI 标签：保持 `AiLabel` 现样式（徽章规格）。

### 7.9 开关、勾选

`accent-color: var(--theme-primary)`；勾选框 20 × 20；原生 `Toggle` 用 tint。

## 8. 动效

沿用 `src/motion/` 与 `docs/map-motion-implementation.md`：页面切换 220ms `cubic-bezier(.05,.7,.1,1)`，控件过渡 150–160ms ease，按压 120ms；`prefers-reduced-motion` 与 `data-motion='reduced'` 降级为淡入淡出。原生用系统动画，不额外定义。

## 9. 令牌的来源与生成

```
frontend/src/styles/tokens.json       ← 唯一来源（字体、颜色含 light/dark、主题色默认值、阴影、圆角、间距、字号、字重、层级）
        │  npm run tokens（scripts/build-design-tokens.mjs）
        ├─► src/styles/tokens.generated.css   :root 与 :root[data-theme='dark'] 的 CSS 变量，经 tokens.css 的 @import 由 main.jsx 引入
        ├─► src/styles/tokens.system.css      静态页用：引入上一份，深色改由 prefers-color-scheme 切换（下载、协议、隐私、技术支持页）
        └─► ios/App/App/DesignTokens.swift    enum FM：FM.bgBase（Color）、FM.UI.bgBase（UIColor）、FM.Radius.lg、FM.Space.s4
```

- 生成文件不要手改；改 tokens.json 后运行 `npm run tokens`，生成的三份一起提交。备案页只有浅色，直接引用 tokens.generated.css。
- Swift 里不生成品牌主色 / 辅色（原生以网页下发的住民设置为准），只有 `themePrimary` 等缺省值；字号用 Dynamic Type，不生成。
- 主题色（住民可改）仍由 `theme.js` 运行时写入，并负责算出 `--theme-primary-text`、`--theme-on-primary`；原生从主题快照拿。
- `npm run test:design-tokens`：两份生成文件与 tokens.json 同步、主题色默认值与 `theme.js` 一致、文字配色对比度（正文与语义色文字 ≥ 4.5:1、muted ≥ 3:1）、Swift 文件已加入 Xcode 工程。
- `DesignTokens.swift` 已登记在 `App.xcodeproj/project.pbxproj` 与 `scripts/patch-native-projects.mjs`；以后新增 Swift 文件同样两处都要加。

## 10. 改动时的检查清单

- 浏览器宽屏 / 窄屏（320px）× 浅色 / 深色；iOS App 原生页与网页页 × 浅色 / 深色；Android App。
- 换一个自定义主题色（很浅的黄、很深的蓝）看 on-primary 和 primary-text 是否可读。
- 启用一个皮肤，确认槽位覆盖仍生效、未启用时外观正确。
- 组件里不出现新的十六进制颜色、不在阶梯里的字号、令牌外的圆角（`test:design-tokens` 可加扫描）。
