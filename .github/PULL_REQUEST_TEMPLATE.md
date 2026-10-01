## 改了什么 / What

<!-- 一段话说清改动目的与范围 -->

## 怎么验证的 / Verification

- [ ] `npm run lint` 0/0
- [ ] `npm test` 全过（scratch HOME，不碰真实数据）
- [ ] `python3 scripts/route-sweep.py` 全 PASS
- [ ] 涉及 WS/pi 链路：`node scripts/ws-probe.mjs` ALL PASS
- [ ] 涉及回退链：`node scripts/failover-e2e.mjs` ALL PASS
- [ ] 涉及安装包/组装：`node scripts/check-runtime.mjs` 通过

## 注意点 / Notes

<!-- 行为变化、迁移、已知取舍 -->
