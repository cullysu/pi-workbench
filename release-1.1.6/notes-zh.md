# v1.1.6 — 工程加固（单元测试 / 日志脱敏 / 运维文档）

外部技术评审（v1.1.5）可动项落地版本。

### Added
- **failover 单元测试**（10 例，直测路由大脑）：ctx 接线契约、splitModel、$ENV 求并、冷却过期、按键轮换与池耗尽、nextInChain 跳过禁用/冷却/无 key 跳点、providerCooled 仅全模型冷却时成立、envOverrideFor 轮换语义、clearCool 作用域。测试套件现为 **35 例 / 8 秒**。
- **运维三件套**：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)（启动失败/端口占用/MCP/会话为空/日志位置）、[CONTRIBUTING.md](CONTRIBUTING.md)（环境搭建+门禁清单+代码约定）、[CHANGELOG.md](CHANGELOG.md)（1.0.0 → 1.1.6 逐版行为变化）。
- **vendor 版本声明**：public/vendor/README.md 固定 marked 18.0.11 / DOMPurify 3.1.7 / uPlot 1.6.32。

### Fixed
- **日志脱敏**：`server.log` 落盘前自动遮蔽 sk- 类密钥、GitHub/Slack token 形状、Bearer 头——错误信息原样带出上游报错时不再连带密钥落盘。
- **日志轮转**：超 2MB 改为保留一代 `server.log.old`（原为直接清空丢历史）。
- Windows 下 Program Files 路径改用环境变量解析（不再硬编码 C 盘）。
- `test` script 覆盖两个测试文件（failover.test.mjs 新入列）。

门禁：lint 0/0、35/35 测试（8s）、47/47 路由扫描、ws-probe（含 adopt 语义）/ failover-e2e / ui-probe 全 PASS；CI 8 job 全绿，五包同源单一 commit（0ade7a5）。

说明：安装包内置 Node v22.14.0 运行时（无需本机 Node）；仍未代码签名（需要证书账号，唯一遗留项）。
