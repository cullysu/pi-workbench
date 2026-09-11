# pi-workbench

**pi-workbench** — a local-first desktop workbench for the [pi coding agent](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`). Windows 桌面应用（Electron + NSIS 安装器），中文界面。

不 fork、不改 pi。工作台以子进程运行 `pi --mode rpc`（stdin/stdout JSONL）驱动 pi 本体：会话文件是 pi 原生格式（`~/.pi/agent/sessions`），自定义模型在 `~/.pi/agent/models.json`，与 pi CLI 完全互通。

## 功能

- **桌面壳**：顶栏 工作台 / 配置 / 高级；项目树左栏（对话挂在项目下，⊕ 就地新建）；状态栏
- **多供应商**：`models.json` 可配任意 OpenAI-compatible / Anthropic / Google 兼容上游；页面填 URL + API Key 即可自动拉取模型列表、逐模型真实回信测试、单选默认模型
- **当前配置一览**：默认模型 / API 地址 / Key 状态常驻显示，一键在多套供应商配置间切换
- **回退路由**：模型级 fallback 链 + 冷却恢复；失败自动沿链切换并重发（等 pi 自身 auto_retry 放弃后才切）
- **技能**：扫描 pi 的 Agent Skills（全局 + 项目），开关直接控制下次会话是否加载
- **用量与缓存**：今日 / 按供应商 / 按模型统计，缓存命中率；每轮回复显示输入 / 输出 / 缓存率
- **导入**：Codex / Claude / ZCode / OpenCode / OMP / Gemini / Grok CLI / Aider 历史会话只读浏览
- **周边**：目标模式自动续跑、实时事件日志、项目文件浏览、git diff、终端、备份恢复、配置迁移

## 安装

从 [GitHub Releases](../../releases) 下载 `PiWorkbench-Setup-x.y.z.exe`：

- 跟随系统语言（中文 / English），可选安装路径，桌面 + 开始菜单快捷方式
- 覆盖升级保留配置与会话；卸载不影响 `~/.pi-workbench` 与 `~/.pi`
- 首次启动自动解压内置运行时（用系统 Node，不捆绑 node.exe）

## 配置

所有个人配置都在本机，不进仓库：

- `~/.pi-workbench/config.json` — 工作台配置（项目、主题、语言、默认模型、技能开关）
- `~/.pi-workbench/routing.json` — 回退链与冷却状态
- `~/.pi/agent/models.json` — 供应商与模型（pi 原生格式）

供应商密钥支持 `$ENV_NAME` 环境变量引用；也可在 `config.json` 里配置可选的 `relaySecret`（从本机其它应用的 settings.json 读取令牌，仅驻内存，需指纹校验）。仓库本身不含任何密钥、地址或账号信息。

## 开发

```bash
npm install
node server.mjs        # http://127.0.0.1:32123
npm run electron       # 或: node_modules\.bin\electron .
```

打包：`npx electron-builder --win nsis --x64`（产物在 `dist_electron/`，不随 git 提交）。

## License

MIT — 见 [LICENSE](LICENSE)。第三方组件见 [ThirdPartyNotices.txt](ThirdPartyNotices.txt)。
