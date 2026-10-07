# v1.1.4 — 密钥遮蔽与纵深防御补全

外部独立审查（v1.1.3，7.5/10）P1/P2 项的全量落地版本。全部五包产自同一 commit（3ba8a93），溯源单一。

## 安全
- **API key 只写化**：`/api/models` GET 对明文 key 回 `***`（`$ENV` 引用保持可读，面板显示环境变量名）；保存时哨兵自动换回真实 key，输入新值即替换；备份 zip 仍含明文 key（还原所需），README 已明示
- **WS adopt 握手**：无主 tab 的事件不再向所有连接广播——重开的窗口必须显式 `adopt` 才能重新收到帧、发送 rpc 或关闭；外来连接从"静默旁听"变为"必须声明"，协议语义经 ws-probe 端到端验证
- **Tauri 壳补上运行时清单校验**（sha256 全文件核对，与 Electron 对等）——两个壳的损坏安装都在启动时显式报错
- **runtime.zip 解压**对 realpath 化的根目录做二次包含检查（symlink 化的安装目录也逃不出去）

## 可靠性
- **备份导入失败原子回滚**：逐文件 tmp+rename 写入，中途失败自动从导入前快照回滚，半导入状态不再存活
- **会话导出流式化**：逐行流式输出 + 背压，大会话不再整读入内存，导出期间服务端照常响应

## 工程化
- **ui-probe 进入 CI**：e2e job 现在跑 ws-probe（含 adopt 语义）+ failover-e2e + 浏览器级 UI 探针（playwright Chromium，17 面板 + 回放 + 零 console error）
- 测试套件 25/25（新增 key 遮蔽与 WS adopt 两条）；SBOM 注明覆盖范围（平台无关 JS 依赖树）
- README 修正：Tauri 安装包实际 ≈32MB（非 10MB）、"main 分支 push 产出五包"口径、密钥处理说明
- Linux 终端候选补 terminator/tilix

## 说明
- 安装包未做代码签名（唯一遗留项，需要证书账号）；macOS 首次打开请 `xattr -d com.apple.quarantine /Applications/Pi\ Workbench.app`
- 桌面壳依赖本机 Node.js ≥ 22.13（安装包不含 Node）
- 与 v1.1.3 的关系：v1.1.3 tag 已重指 707ffabc（修正 Tauri 资产溯源）；v1.1.4 起五包一律单 commit 构建
