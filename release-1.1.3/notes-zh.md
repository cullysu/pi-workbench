# v1.1.3 — 安全与完整性强化版

外部全面审计（P2-05..P2-35）两波响应的落地版本。30+ 项修复，重点：

## 安全
- WS 按 tab 隔离：对话事件只发给创建它的连接；其它连接的 rpc/close 被拒；断线后事件重新广播供重连同窗口收养
- DNS rebinding 防护：所有请求与 WS 升级校验 Host 头（只认 127.0.0.1 / localhost / [::1]）
- 供应商 URL 强制 http(s) + 响应流式 2MB 上限（discover / 探测 / 试回复三处）
- Anthropic 官方接口改用 x-api-key 头；Google generativelanguage 获得真实协议适配（模型发现 / 连通探测 / 真实回信测试）
- 文件浏览、会话读取/删除/导出、导入读取全部 realpath 包含校验（symlink/junction 逃不出注册项目根）
- git diff/工作树、终端打开/执行、pi 会话 cwd 全部限制在已注册项目（HOME 除外）
- 定时任务 ID 白名单（写入侧 + 运行侧双防）；cron 兜底杀进程定时器不再阻止服务端退出
- zip 读取器加 5 万条目 / 1GB 解压上限；备份导入先全部验证再写盘（坏包零落盘）
- 配置/路由/模型/定时写入全部原子化（tmp+rename），损坏文件自动留证
- /api 网关拒绝跨站 Origin；uncaughtException 后 /api/kernel 报告 degradedSince

## 可靠性
- node:sqlite 真正改为软导入（旧 Node 可启动，仅 OpenCode 导入降级）+ engines >= 22.13
- 运行时 manifest：出包时对全部运行时文件做 sha256，壳启动前校验，安装损坏在启动时明确报错
- AppImage 出包前 boot 测试升级：HTTP 200 + /api/kernel 确认内置 pi 应答
- Windows 测试/探针收尾改树杀（修复本地套件 905 秒挂起 → 5 秒）

## 工程化
- 新增 failover-e2e：真 pi + 3 个 mock 供应商验证回退链语义（错误上报、链行走、冷却跳过、401 走换 key 分支、真实流式回信）
- 每个 build 产出 CycloneDX 1.5 SBOM artifact
- CI：ubuntu 测试腿加 47 路由扫描；e2e job 跑 ws-probe + failover-e2e；issue/PR 模板；图标按钮 aria-label

## 说明
- 安装包未做代码签名（SmartScreen/Gatekeeper 会提示，macOS 首次打开请 `xattr -d com.apple.quarantine /Applications/Pi\ Workbench.app`）
- 桌面壳依赖本机 Node.js ≥ 22.13（安装包不含 Node）
- 完整变更见 commit 6a1b718..372cb72
