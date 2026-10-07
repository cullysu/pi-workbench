# v1.1.5 — 自包含安装包（内置 Node 运行时）

针对用户体验审查最重的一条：**安装包现在捆绑 Node 运行时，无需本机安装 Node.js，双击即用。**

- **内置 Node**（Windows/Linux/macOS x64 官方二进制，CI 固定版本 v22.14.0）：桌面壳本就优先使用应用目录内的 node，此前只是从未随包发布——现在补齐。Apple Silicon 经 Rosetta 运行 x64 二进制。
- **代价**：包体增大（Electron 143→176MB、Tauri 33→66MB、AppImage 136→179MB、dmg +75MB），换取零外部依赖。
- **备份导出新增「不含密钥」选项**：导出前明示「密钥以明文写入备份」，可选择排除 models.json（还原后需重新填 key）。默认动作仍为完整备份。
- **package.json 元数据补齐**：author / keywords / repository / bugs / homepage。
- chat-e2e 链切换断言改为确定性信号（okB 独有回复即链切换证据；状态栏文案仅存活 ~300ms，只作辅助日志）。

其余：25/25 API 测试、47/47 路由扫描、ws-probe（含 adopt 语义）/ failover-e2e / ui-probe / chat-e2e 全 PASS；CI 8 job 全绿，五包同源于单一 commit。

说明：安装包仍未代码签名（需要证书账号，唯一遗留项）；macOS 首次打开 `xattr -d com.apple.quarantine /Applications/Pi\ Workbench.app`。
