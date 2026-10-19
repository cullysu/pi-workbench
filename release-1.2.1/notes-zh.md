# v1.2.1 — 壳边界与发布链硬化

第十一轮源码级评审（v1.2.0）可动项全量落地。

### Fixed（安全，P0/P1）
- **Electron 主窗口导航守卫**：主窗口永远不离开本地源——markdown 里的恶意链接或脚本触发的导航会转到系统浏览器，token 注入（dom-ready）再也不可能落在外部页面上。
- **token 注入时机竞态修复**：token 改经 sandboxed preload（contextBridge，argv 通道）在**页面脚本运行之前**就位——app.js 首批 API 调用不再 403/重载打转。
- **导出按钮修复**：`<a href>` 导航无法携带 x-api-token（真实 UI 点击必 403 而单测通过）——改为带 header 的 fetch + blob 下载。
- 会话树 realpath 双端校验（sessions 内 symlink 不再能把读取指向外部文件）。
- MCP 配置 GET 对 env 值 `***` 遮蔽（POST 哨兵还原）；MCP 文件原子写 + POSIX 0600；备份快照文件 0600。
- `/api/config` 形状校验（projects/disabledSkills 必须数组）；回退链过滤非法元素。
- discover 请求携带用户选择的 API 类型（显式选择优先于嗅探）。
- 孤儿 tab 30 分钟 TTL 回收（无主的 pi 子进程不再永久占位触发 "too many live tabs"）。

### Fixed（供应链与可复现）
- **pkg-build 运行时改为 lockfile 驱动**：提交 runtime-package.json + package-lock.json，CI `npm ci` 安装——发行包的传递依赖不再随 registry 漂移；SBOM 标识修正为 pi-workbench-runtime@版本。
- **可复现归档**：runtime 遍历排序 + `SOURCE_DATE_EPOCH` 固定 zip 时间戳。
- chat-e2e 进 CI e2e job（本轮起四探针全部在 CI 内）；chat-e2e 完成 linux 化。
- README：示例版本、io 原语计数、数据流向说明补齐英文侧。

门禁：lint 0/0（含 npm audit）、36/36 测试、47/47 路由扫描、ws-probe / failover-e2e / ui-probe / chat-e2e 全 PASS（**后三者均在 CI 内运行**）；CI 8 job 全绿；五包同源单一 commit。

说明：仍未代码签名（需要证书账号，唯一遗留项）。
