# v1.2.3 — 请求悬挂修复与会话路径边界

第十三轮源码级评审（含小规模隔离复现）的可动项全量落地。

### Fixed（P0/P1）
- **异步路由异常不再悬挂请求**：路由派发未 await handler promise，首个 await 之后的异常会逃逸为 unhandledRejection，客户端永久等待——现在一律返回 JSON 500（评审用伪造 handler 复现，一个 await 修复）。
- **WS `open` 校验 `sessionPath`**：与全部会话端点同等的 realpath 包含检查——构造帧此前可让 `pi --session` 指向 sessions 目录之外。
- **cron 三修**：陈旧 `running` 标志只在服务启动时清理（此前一次面板刷新就会清掉运行锁并双重派生）；设置保存保留活运行标志；payload 强校验（字符串 name/prompt、ID 唯一、interval ≥0.5 分钟、≤100 任务）。
- **孤儿 tab TTL 真正生效**：清扫循环此前被创建时的 `adoptedEver` 标记跳过，无主 pi 子进程实际不可回收。
- **failover 拿到真实供应商错误文本**（401/429 分类从 UI 主链路终于可用）。
- 普通发送**不再清空可见会话历史**（仅清空首屏空状态）。
- 403 刷新循环源头移除（成功请求重新武装一次性重载）。

### Fixed（数据与供应链）
- `atomicWrite` 唯一临时名（并发写共享同一 tmp 路径的竞态）。
- `readJsonl` 使用 StringDecoder（跨 1MiB 块边界的中文字符不再损坏）+ 单行 32MB 上限。
- 账本接受 camelCase usage 形状（ZCode rollout 计入统一账本）。
- MCP 扩展 typebox 锁定 1.3.30 精确版本 + `--ignore-scripts` 安装；运行时 manifest 纳入捆绑 node；CI 以规范名拷贝 runtime 清单（SBOM 应用版本不再 0.0.0）；chat-e2e 自愈先验证进程映像再清端口残留。

门禁：lint 0/0（含 npm audit）、36/36 测试、47/47 路由扫描、ws-probe（含 adopt）/ failover-e2e / ui-probe / chat-e2e 全 PASS；CI 8 job 全绿；五包同源单一 commit。

说明：仍未代码签名（需要证书账号，唯一遗留项）。
