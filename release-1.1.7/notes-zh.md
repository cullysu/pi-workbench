# v1.1.7 — 资源上限与依赖审计

外部技术评审（v1.1.6，31 项分层清单）可动项落地。

### Added
- **并发 tab 上限**（`MAX_TABS = 16`）：每个 tab 是一个活着的 pi 子进程，超过上限的新开请求返回 `open-denied` 及原因；替换已有 tabId 不受影响。
- **CI 依赖审计**：lint job 新增 `npm audit --omit=dev --audit-level=high`，对运行时依赖树（当前仅 ws）做漏洞门禁。

### Fixed
- 无其它行为变化——本轮评审的其余"缺失"项经核实多为误报或既有能力（CSP 实为 HTTP 响应头每响应携带完整策略；failover 实战链路已有 failover-e2e；配置/模型本就免重启热读取；cron 有持久化状态+逐次日志+bootReset 恢复；E2E 用户路径由 chat-e2e/ui-probe 覆盖）。

门禁：lint 0/0（含 npm audit）、35/35 测试、47/47 路由扫描、ws-probe / failover-e2e / ui-probe 全 PASS；CI 8 job 全绿，五包同源单一 commit（f039dbb）。

说明：内置 Node v22.14.0；仍未代码签名（需要证书账号，唯一遗留项）。
