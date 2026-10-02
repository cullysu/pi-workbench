# 故障排查 / Troubleshooting

## 启动类

### 双击后没有任何窗口 / 弹出「本地服务启动失败」
1. 看日志：`~/.pi-workbench/server.log`（以及轮转前的 `server.log.old`）。
2. 常见原因按顺序排查：
   - **端口被占用**：日志会写 `端口 32123 已被其它程序占用`。找到占用进程（`netstat -ano | findstr 32123`）结束它，或设置环境变量 `PIWB_PORT` 换端口后从桌面快捷方式启动。
   - **运行时解压失败**：日志写 `FATAL ensureRuntime`。删除运行时目录后重装：Windows 为 `%LOCALAPPDATA%\Pi Workbench\runtime`（Electron）或 `%LOCALAPPDATA%\pi-workbench-tauri\runtime`（Tauri）。
   - **运行时校验失败**：弹窗写「运行时文件校验失败」= 安装包损坏，重新下载安装包。
3. Electron 壳的启动日志（`[main]` 前缀）在 `%APPDATA%\Pi Workbench\app.log`。

### 端口 32123 是谁在用
`netstat -ano | findstr 32123`（Windows）/ `ss -ltnp | grep 32123`（Linux/macOS）。pi-workbench 自己的旧实例会自动复用（单例锁），只有「其它程序」占用才需要处理。

## 模型与回退

### 模型测试失败 / 全部供应商报错
1. 「模型」页逐个供应商点「探测」：`baseUrl` 必须是 http(s) 地址，本地供应商（ollama/LM Studio）允许 127.0.0.1。
2. Anthropic 官方接口自动用 `x-api-key` 头；Google generativelanguage 自动走 v1beta 形状；中转站选 openai-completions 即可。
3. 回退没生效？链在「路由」页配置，切换只在工作台检测到助手报错后发生（先等 pi 自身 auto-retry 放弃）。

### API Key 相关
- 面板接口对明文 key 只回 `***`；编辑时**留空即保持**原 key。
- 推荐用 `$ENV_NAME` 写法引用环境变量（重启面板前先设好）。
- 备份 zip 含明文 key（还原需要）；不需要时用「不含密钥导出」。

## MCP

### MCP 工具没出现
1. 「配置 → MCP」页点安装（会把桥接扩展复制到 `~/.pi/agent/extensions/mcp-bridge` 并装 typebox）。
2. `~/.pi/agent/mcp.json` 里 server 配置是否正确（`command` 可执行）。
3. 给 server 加 `"lazy": true` 可以零启动成本（首次调用才 spawn）。
4. pi 会话的 stderr 会带 `[mcp-bridge]` 前缀日志。

## 会话与定时任务

### 会话列表为空
会话来自 pi 原生目录 `~/.pi/agent/sessions`——先用 CLI 在某个项目里跑过一次 pi，面板才能看到。

### 定时任务没触发
- 服务端必须开着（cron 是进程内调度，20 秒一轮）。
- 「上次运行/状态」列会显示最近一次结果；单次日志在 `~/.pi-workbench/cron-runs/<job-id>/`。
- 任务 ID 只允许字母数字和连字符。

## 日志位置汇总

| 内容 | 位置 |
|---|---|
| 服务端错误（脱敏后） | `~/.pi-workbench/server.log`（+ `.old`） |
| Electron 壳启动日志 | `%APPDATA%\Pi Workbench\app.log` |
| 定时任务单次输出 | `~/.pi-workbench/cron-runs/<job-id>/<时间>.log` |
| 损坏的配置留证 | `~/.pi-workbench/config.json.corrupt-<时间戳>` |

提交 issue 时请附上相关片段（已自动脱敏 sk- 类密钥）。
