# v1.2.5 — 外壳完整性与第十五波收口

第十五轮独立评审（v1.2.4 全版本审查）的真实发现全量落地；数条与源码不符的主张以行号证据驳回（见发布说明末尾）。

### 完整性
- **Electron 外壳文件纳入完整性覆盖**：CI 打包时写入 `shell-manifest.json`（逐文件 sha256，afterPack 钩子），打包版启动时校验自身外壳，失败即拒绝启动——与 runtime manifest 同语义的 fail-closed。开发模式豁免。
- 备份 ZIP 解析预算收紧到 64MB 总量（原 1GB——配置备份用不到，敌意归档的膨胀空间被封住）；备份导入临时名全局唯一 + 进行中互斥（两个并发导入不再争用同一 `.imp-<pid>` 文件）。
- `engines.node` 提到 `>=22.19.0`（pi 0.85.0 的真实下限）——旧的 22.13 承诺了一个跑不起来的区间。

### 费用与数据
- 供应商测试的 OpenAI-compatible **400/422 回退分支**补上 `max_tokens: 512`（与主路径一致）——推理中继不再能在重试上无限计费。
- MCP 桥对单次工具结果设 256KB 上限并带明确截断标记——失控的 MCP server 不再能把无限文本灌进 pi 上下文。
- 思考等级下拉先问 pi（`get_available_thinking_levels`），只列出当前模型支持的等级——不再对不支持的模型提供 off…max 全列表。
- 用量角标对"仅统计最近 300 个会话"的窗口显示 ⚠ 与悬停说明（含磁盘真实总数）；`readJsonl` 的行数上限精确到 max（原实现晚一行生效、尾行路径绕过）。

### 加固
- **全部 JSON 响应带 `Cache-Control: no-store`**——配置、会话、用量摘要不再滞留浏览器/代理缓存。
- token 文件在 Windows 上显式收紧 ACL（`icacls /inheritance:r`，仅当前用户）——POSIX 一直是 0600，Windows 补齐。
- cron `daily` 校验时间范围（00:00–23:59）——`99:99` 这类旧格式检查放过的值不再静默存在。
- `knownProject()` 改用与项目注册相同的大小写折叠比较——Windows 上路径大小写不同不再导致项目边界检查（文件浏览、git 路由、cron cwd）失认。
- 会话树的 `activePath` 裁剪到实际返回的节点——超 4000 节点的会话不再高亮 UI 拿不到的节点。

### 与源码不符、以证据驳回的主张
- "provider test 无 `max_tokens`"——主路径本就带 16/512（server.mjs:307/324），只有回退分支缺失（本轮已补）。
- "`collectProc()` 只杀直接子进程"——早已树杀（lib/io.mjs:95，注释在位）。
- "usage 统计静默截断"——300 窗口带 `truncated`/`diskSessions` 字段（lib/sources.mjs:189-191）、256KB rollout 截断有明确警示文本（lib/sources.mjs:406），本轮补上面板角标。
- "备份默认含明文 key"——API 默认就是排除（server.mjs:1229 `!== '0'`），包含是显式选择。
- "ledger 混淆 cache 读写"——回退链逐字段严格对应（ledger.mjs:19-20）。
- "release 9 资产 vs 7"——GitHub 页面把两个自动生成的源码包也列在资产区。

门禁：lint 0/0、测试 40/40、路由扫描 47 PASS/0 FAIL、ws-probe / failover-e2e / ui-probe / chat-e2e 全 PASS。

仍未代码签名（等证书账号，唯一遗留项）。
