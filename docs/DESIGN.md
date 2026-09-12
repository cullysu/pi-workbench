# Pi Workbench 设计规范（v1.1）

依据：Apple HIG 的层级哲学、Microsoft Fluent 2 字阶、GitHub Primer 语义色与交互态、4px/8px 间距栅格。
适用范围：pi-workbench 全部界面。改任何样式先对照本文件；与本文件冲突的旧样式一律以本文件为准。

## 1. 原则

1. **层级靠字重与灰度，不靠加色**。标题不换色、不加粗滥用；semibold 只用于真正的一级强调。
2. **语义命名，不写裸色值**。组件只允许引用 token（`var(--…)`），新 CSS 里出现裸 hex 即为违规（图表数据色与品牌色除外，且必须走 `--chart-*`）。
3. **一切都是 4 的倍数**。间距、圆角、控件高度、行高全部落在 4px 栅格上；半像素字号（12.5/13.5）禁止。
4. **状态三件套**：每个可交互元素必须有 hover（6% 覆盖）、active（10% 覆盖）、focus-visible（2px accent 外环）；disabled 统一 45% 不透明度。
5. **克制**：一个视图最多一个强调色焦点；阴影只有两级；圆角只有五档。

## 2. 字体

```
--font-sans: "Segoe UI Variable Text", "Segoe UI", system-ui,
             "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei",
             "WenQuanYi Micro Hei", sans-serif;
--font-mono: "Cascadia Code", "Consolas", ui-monospace, monospace;
```

规则（来源：西文在前中文在后、per-glyph 回退）：
- 西文/数字走 Segoe UI Variable，中文回落雅黑 UI（紧凑度标），必须**英文写法**字体名。
- 衬线栈仅保留备用（`--font-serif`），默认 UI 不使用——中文衬线无内置字体会回落宋体，是廉价感第一来源。

## 3. 字阶（Fluent 2 ramp，px/行高）

| token | size/line-height | 用途 |
|---|---|---|
| --text-caption | 11/16 | 时间戳、badge、辅助角标 |
| --text-body-sm | 12/18 | 次要信息、表格、工具参数 |
| --text-body | 13/20 | 列表行、表单、默认 UI 文本 |
| --text-body-lg | 14/22 | 正文、消息气泡 |
| --text-subtitle | 16/24 | 面板标题 |
| --text-title | 20/28 | 页标题（cfg-title） |
| --text-message | 15/26 | 消息正文（对话可读性优先） |
| --text-display | 40/48 | 工作台问候语（无衬线，weight 600） |

字重：400 常规、600 semibold（标题/强调）、700 禁用（视觉过重）。
正文对比度 ≥ 4.5:1；辅助文本用 --text-tertiary（仍需 ≥ 3:1）。

## 4. 间距（4px 栅格）

token：`--space-1=4 --space-2=8 --space-3=12 --space-4=16 --space-5=20 --space-6=24 --space-7=32 --space-8=48`

- 组件内 padding：sm=4，md=8，lg=12（列表行 12，卡片 16）。
- 组件间 gap：8 或 12；区块之间 16 或 24。
- 半步 2px 仅允许用于图标与文字的对齐微调。
- 禁止值：5/7/9/10/11/13/14/15/17/18/19/21/22/25/30 …（全部归到最近档）。

## 5. 圆角（嵌套规则：内层 = 外层 − 相邻 padding，取档）

| token | 值 | 用途 |
|---|---|---|
| --radius-xs | 4 | checkbox、代码行内、badge 角 |
| --radius-sm | 8 | 小按钮、菜单项、列表行 |
| --radius-md | 12 | 输入框、卡片、工具卡 |
| --radius-lg | 16 | 大卡、对话框、composer 容器 |
| --radius-pill | 999 | chip、开关 |

## 6. 色彩（Primer 语义模型）

| token | light | dark | 用途 |
|---|---|---|---|
| --canvas | #ffffff | #1a1a1a | 主背景 |
| --surface | #f6f6f7 | #242424 | 侧栏/嵌套面 |
| --card | #ffffff | #2b2b2b | 卡片 |
| --line | #e4e4e7 | #383838 | 默认边线 |
| --line-soft | #ececef | #303030 | 弱分隔（70% 透明度思路） |
| --fg | #1f2328 | #e8e8e8 | 主文本 |
| --fg-2 | #59636e | #a8a8a8 | 次要 |
| --fg-3 | #8b949e | #7a7a7a | 三级 |
| --accent | #0969da | #4c8dff | 链接/焦点/主操作 |
| --ok / --warn / --err | Primer success/attention/danger | 同 | 语义 |

交互覆盖（Primer 方案，灰色叠加而非换色）：
`--overlay-hover: rgba(129,139,152,.10)`；`--overlay-active: rgba(129,139,152,.16)`；`--overlay-selected: rgba(129,139,152,.22)`。
阴影两级：`--shadow-1`（菜单/浮层）、`--shadow-2`（模态）。品牌色：主操作钮 = --fg（黑/白反转），强调蓝只给链接、焦点环、图表。

## 7. 控件规格

- 控件高度：sm=24（chip/工具条钮）、md=28（按钮/输入默认）、lg=32（主按钮/下拉触发钮）。
- 图标：14（行内）、16（按钮内）、20（导航）；线宽 1.8；矢量优先，emoji 禁止。
- 按钮：primary = 实底 --fg 反白；secondary = 1px --line 边框；ghost = 透明 + hover 覆盖。三种之外不得再造。
- 表单控件统一 --radius-md + 1px --line，聚焦边框 --accent（替代旧 text3 灰）。
- 列表行：双行（主行 --text-body，次行 --text-caption --fg-3），行高 40±4，hover --overlay-hover，选中 --overlay-selected + 左侧 2px accent 指示条可选。
- 对话框：--radius-lg + --shadow-2，遮罩 rgba(0,0,0,.45)。
- 空状态：图标 20 + 一句主文案（--fg-2）+ 一句可操作副文案（--fg-3），居中，无插图。

## 8. 动效

时长：120ms（hover/按压）、160ms（菜单/浮层进出）；缓动 ease-out。无弹跳、无 300ms+。

## 9. 违规清单（重构前实测，供回归对照）

- 字号出现 10.5/11.5/12.5/13.5/14.5/17 —— 全部归档到第 3 节。
- 圆角出现 5/7/9/10/14/18/24 —— 归档到第 5 节五档。
- 间距出现 5/7/9/10/11/13/14/15/18/30 —— 归档到第 4 节。
- 图表色 #4c8dff/#30a46c/#9a6700 未走 token —— 收编为 --chart-1/2/3。
- 焦点环缺失（focus-visible）—— 全局补齐。
- 品牌蓝 --link 与 --accent 两套并存 —— 合并为 --accent。

## v1.1 增补（截图体检结论）

- **深色模式变量继承陷阱**：在 :root 定义 `--bg: var(--canvas)` 这类别名，会在 html 层求值，body.dark 翻转原始 token 后别名不会跟随——**所有别名必须在 body.dark 内重新声明一遍**。
- **去框化**：卡片/表格/步骤卡不再用边框盒子，改为 surface 底色 + 无边框；表格只保留行间发丝线。框线泛滥 = 廉价感第二来源。
- **问候语无衬线**：40px weight 600 的 --font，负字距在中文上禁用。
- **侧栏单行**：会话/对话行 = 标题 + 右侧灰色时间，双行堆叠造成拥挤感。
- **消息正文 15/26**，composer 圆角 24 + shadow-2，浮动元素才用阴影。
- **滚动条** 6px、12% 灰、圆角 pill。
