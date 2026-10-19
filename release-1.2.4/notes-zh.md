# v1.2.4 — 发布链与进程树治理

第十四轮评审的可动项全量落地，**并补齐 v1.2.3 tag 实际缺失的一部分上轮修复**（一次被错误 pathspec 中止的 `git add` 批量暂存，修复提交只补回了六个文件——本版起，发布说明所列修复全部真实存在于发布二进制中）。

### 发布链
- **随发布附带 `SHA256SUMS.txt`**：覆盖全部五个安装包与 SBOM，下载后可独立校验。
- **runtime manifest 覆盖 `extensions/`**（MCP bridge 此前可被替换而不触发校验失败）；**双桌面壳对打包安装缺 manifest 一律拒绝启动**（fail-closed，开发模式豁免）。
- **README 的干净 checkout 构建路径真实可用**：`npm run prepare-runtime` 按提交进库的 runtime 锁文件组装 `pkg-build/`（与 CI 同一套依赖集，脚本已实测）。
- 根/运行时两份锁文件根版本同步到 1.2.4；extensions 首次提交锁文件（typebox 1.3.30 按 integrity 哈希锁定，官方 registry）。

### 进程与资源治理
- **关闭 tab 杀掉 pi 的整棵进程树**（MCP server、shell 工具），不再只杀直接子进程：POSIX 独立进程组 + 组信号，Windows `taskkill /T /F`；cron killer 与模型探测同样处理。
- **pi stdout 洪泛不再能 OOM 服务**：无换行缓冲 16MB 封顶（保留尾部降级）。
- **cron 运行日志单次 10MB 封顶**；cron `cwd` 保存时与执行时都限制在已注册项目（与终端 API 同一边界）。
- WS 离线队列封顶 200 帧；WS 帧入口加轻量字符串类型门；**MCP 安装等待 `npm ci` 完成并如实返回成败**（此前后台安装未完成就返回成功）。

### 桌面壳
- Electron 支持 `PIWB_PORT`（与服务端、Tauri 一致）；**token 改经进程环境传递给渲染层**，不再出现在命令行。
- Tauri 外部页面一律交系统浏览器——应用自有 viewer WebView 加载远程页面的路径已移除。
- 更新检查返回当前版本并做真实 semver 比较（`updateAvailable`）。

### CI
- **该门禁首轮就抓到真问题**：随包运行时树里 pi 0.85.x 钉死的 `undici` 8.9.0（10 个 GHSA，8.10.2+ 修复）与 `brace-expansion` 5.0.9（3 个 DoS GHSA，5.0.12 修复）。runtime 锁文件已把两者钉在修复版——npm 的 `overrides` 引擎在本树静默失效（npm 11.12.1 实测），锁文件即强制、审计门禁即绊线。
- **随包分发的 runtime 依赖树独立 `npm audit` 门禁**（根树审计不覆盖它）；`cargo audit` 门禁 Tauri 壳依赖；同仓库 PR 现在也跑完整 e2e/构建门禁。

门禁：lint 0/0、40/40 测试（新增 StringDecoder 跨块边界回归）、47/47 路由扫描、ws-probe（含 adopt 握手）/ failover-e2e / ui-probe / chat-e2e 全 PASS；`prepare-runtime` 实测通过。

仍未代码签名（需要证书账号，唯一遗留项）。
