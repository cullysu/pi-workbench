# v1.2.2 — 备份快照权限加固

### Fixed
- **备份导入前的快照文件在 POSIX 上 `0600`**——快照携带与原文件相同的明文密钥，权限不应更宽。
- README：安装示例版本、服务端规模数字与实际同步。

维护项：CHANGELOG 补齐 1.2.0/1.2.1/1.2.2 条目（v1.2.1 的全部修复内容见其条目：主窗口导航守卫、preload token 竞态修复、导出按钮、sessionTree realpath、cron 状态保留、config 形状校验、discover API 类型、孤儿 tab TTL、MCP 遮蔽/原子写、pkg-build lockfile、可复现构建、chat-e2e 进 CI）。

门禁：lint 0/0（含 npm audit）、36/36 测试、47/47 路由扫描、ws-probe / failover-e2e / ui-probe / chat-e2e 全 PASS；CI 8 job 全绿；五包同源单一 commit。

说明：仍未代码签名（需要证书账号，唯一遗留项）。
