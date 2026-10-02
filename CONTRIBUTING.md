# 贡献指南 / Contributing

## 环境搭建

要求：Node.js ≥ 22.13（`node:sqlite` 等），git，Python 3（仅 route-sweep 用），Rust 工具链（仅改 Tauri 壳时需要）。

```bash
git clone https://github.com/cullysu/pi-workbench.git
cd pi-workbench
npm ci            # 完整依赖（含 pi-coding-agent）
npm start         # http://127.0.0.1:32123
```

## 改动后必须跑的门禁（全绿才算完）

```bash
npm run lint                                   # eslint 0/0
npm test                                       # node --test tests/（隔离 HOME，不碰真实数据）
python scripts/route-sweep.py                  # 47 条路由全量验收
node scripts/ws-probe.mjs                      # 真实 pi 子进程走完整 WS 链（含 adopt 语义）
node scripts/failover-e2e.mjs                  # 真 pi + 3 mock 供应商验证回退链
node scripts/chat-e2e.mjs                      # 浏览器级核心链路（需本机 Chromium，CHROME_EXE 可指定）
node scripts/ui-probe.mjs                      # 浏览器级 17 面板 + 零 console error（CHROME_EXE 可指定）
```

CI（GitHub Actions）在每次 main push 上跑同样的 lint + 三系统测试（ubuntu 腿含 route-sweep）+ e2e（ws-probe/failover-e2e/ui-probe）+ 三平台构建（AppImage 有 xvfb 启动验证 + /api/kernel pi 应答检查）。

## 代码约定

- 服务端：`server.mjs`（HTTP/WS 入口 + 路由表）+ `lib/` 工厂模块（ctx 显式注入，**启动即校验依赖契约**）。
- 新增依赖要克制：运行时依赖目前只有 `ws`；前端库走 `public/vendor/`（版本见该目录 README）。
- 错误分级：启动接线问题 throw（崩在启动）；业务错误返回 `{ ok:false, error }`；可恢复错误走 `logErr`（自动脱敏 sk- 类密钥）。
- 注释写约束和"为什么"，不复述代码。
- 版本号：`package.json` 与 `tauri/tauri.conf.json` 同步改。

## 提 PR

1. 从 main 拉分支；改动附测试（修 bug 附复现用例）。
2. PR 模板里逐项勾选已跑的门禁。
3. 说明行为变化与取舍；不 fork/修改 pi 本体的边界不变。

## 报 bug

用 issue 模板（平台 / 版本 / 现象 / `server.log` 片段）。日志已自动脱敏密钥，但仍请检查会话内容等敏感信息。
