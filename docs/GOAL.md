# Tradekit 项目目标

为 AI Agent 提供一个生产级的 Crypto DEX 交易框架。任何 AI Agent 都可以通过 MCP / CLI 方便、安全地完成 EVM 链上的 DEX 交易、行情查询、持仓管理等操作。

---

## 当前状态 (v1.1.1)

Phase 1/2/3 全部实现完毕。生产级使用中。

**Phase 1 — 基础设施** ✅
- 配置文件系统：`~/.tradekit/config.json` + Zod schema 校验 + `tradekit config show/get/set/push/drop/validate/path`
- SQLite 持久化层：`node:sqlite`（无原生编译）+ 自动迁移；5 张表（trades、audit_log、portfolio_snapshots、sync_bookmarks、schema_version）
- 多账户管理：BIP-39 HD 助记词 + 单私钥 keystore 双模式；`tradekit account create-mnemonic/import-mnemonic/list/add/use`
- 多链支持：Ethereum / Base / Arbitrum / Optimism / BNB / Polygon；每链 4 个 RPC failover（viem `fallback`）
- MCP 工具设计规范：47 个 MCP 工具，全部含结构化错误码（28 个稳定 code）、`next_actions` 字段、`recommendedActions[]` 结构化分发列表、`severity` 字段、`elapsedMs` 计时；单位在每个工具描述中明确

**Phase 2 — 核心交易能力** ✅
- DEX 聚合器集成：KyberSwap / OpenOcean（免费）+ 0x / 1inch（需 API key）；`mode: first|best` 可选并行竞价；自动 fallback；模拟失败时自动切换聚合器
- 交易 simulation：所有写操作支持 `simulate=true`（`eth_call` + `estimateGas`）；返回余额变化、gas、滑点、revert 原因；`trade preview` / `preflight` 为执行前 verdict 工具
- Agent 安全护栏：每日 / 单笔 USD 上限 + token 白/黑名单 + 合约白名单 + 滑点上限 + gas budget（% / native cap per chain）+ per-account 限频（iter633）；全部 audit 入库

**Phase 3 — 数据展示与可视化** ✅
- 持仓与 PnL 追踪：加权平均成本基础 + 已实现/未实现 PnL + per-chain gas 累计；多窗口（1d/7d/30d）+ strategy-scoped + 数据新鲜度告警（iter741）
- 链上数据查询：任意地址多链持仓 + DexScreener / GeckoTerminal trending；on-chain trade backfill（`trades sync` iter607）支持外部交易导入
- Web 模式：Express 5 + React 18 + Mantine 7 + Vite + TradingView Lightweight Charts + OKX K 线；与 CLI/MCP 共享配置与数据库

**运维能力**（Phase 4 — 隐式衍生）✅
- 操作员仪表盘：`tradekit health` 一键聚合 portfolio + 7d PnL + 交易质量 + 待处理待赎回 + 结构化 `recommendedActions[]`
- 卡 tx 恢复：`tradekit pending` 诊断 + `tx speedup` / `tx cancel`（同 nonce 替换）
- Cron 友好监控：`--summary`（单行 digest）+ `--strict`（actionable bad state 退出 1）+ `--watch N`（JSONL 流）跨 6 个命令（health / doctor / verify / reconcile / trades sync / pending），统一格式 `<badge>  tradekit <command> · <fields...> · <timestamp> (<elapsed>)`
- 通用性能可观测性：`elapsedMs` 字段贯穿所有 20+ 个 MCP 工具（除常数读 chains / accounts list / strategies_list / address list 外）；agent 可一行计算每个工具的延迟分布
- 加密备份：`backup export/restore`（CLI-only，故意不暴露给 MCP 以保护 agent 安全边界）
- 测试覆盖：1376+ 单元测试 + bash 烟雾集成测试 + 3 个不变量回归守卫（iter589/877/878）

**Phase 115 — edge 进 promote 就绪检查：晋升真钱前先看"边际优势稳不稳"，而非只看"总账没亏"（profit-factor edge in promote-check — readiness now assesses robustness of edge, not just positive total P&L）** ✅
- **把 v114 的 edge 信号接进信任管道的前向闸**：promote-check（v49，纸面→真钱就绪度）检查运行天数/成交数/回撤/friction + "总 P&L > 0"。但**总 P&L 可能靠运气**（一笔大赢主导）——一个 profit factor 勉强 > 1、靠一两笔幸运交易的策略，能通过 promote-check（总账正、成交够）被晋升上真钱。就绪检查不看"边际优势稳不稳"
- 为什么是 v114 的关键延伸：promote 是产品最重要的闸（真钱起点）。"总账没亏"远弱于"有稳健 edge"。profit factor < 1.2（足够多平仓时）立刻暴露"看着不亏、实则脆弱"的策略——正是晋升前最该知道的。且复用 v114 的 edge 计算（gatherStrategyComparison paper 模式，单一源、零 RPC、确定性）
- 实现（复用 v114 + v49 caution 模型）：PromoteCheckReport 加 `edge`（closes/winRate/profitFactor/payoffRatio/expectancy，纸面已平仓 round-trip）。verdict 加 caution：profitFactor < 1.2 且 closes ≥ 5（样本足够）→ "weak edge" caution（advisory，同其他质量旗标——不是硬 floor，运营商可有 thesis 仍晋升；--require-ready 仍只 gate 运行/成交硬 floor）。render 加 edge 行；MCP playbook_promote_check 描述同步
- 测试覆盖：+4——弱 PF（1.125<1.2）足够平仓→caution + edge 填充 / 全赢无亏→PF null 不误报 / 弱 PF 但平仓太少→不 caution（样本不足）/ 仅买入未平仓→edge null；3596 测试全绿（+4，既有"clean→ready"测试不受影响：仅买入→edge null）
- 向后兼容：纯加法——edge 字段 + 一条 caution；仅买入/无平仓的既有测试 edge=null 不触发；复用 v114 计算不改排名；caution 不阻断（硬 floor 仍是运行/成交）

**Phase 114 — 策略"有没有 edge"的量化：profit factor / payoff / 期望值（trading-edge metrics — profit factor, payoff ratio, avg win/loss, expectancy answer "does this strategy actually have an edge?"）** ✅
- **补上"胜率高 ≠ 赚钱"的盲区**：strategyCompare 报已实现 P&L + 胜率，但**胜率单独看会骗人**——一个 70% 胜率、却"小赢大亏"的策略整体是亏的。框架缺的是判断 edge 的标准交易指标：**profit factor**（毛盈/毛亏，>1 才有利可图、量级=安全垫）、**payoff ratio**（avg win / avg loss 的盈亏比）、avg win/avg loss、expectancy（每笔期望 $）。这些才回答"这策略到底有没有 edge、该不该加仓"
- 为什么是有效性支柱最重要的一块：交易产品的核心是帮 agent/运营商判断策略是否真有边际优势。胜率 + 总 P&L 不够——一段时间的总 P&L 可能被一两笔运气主导。profit factor < 1 立刻暴露"胜率好看但在流血"的策略，是资金分配（v83 的初衷）真正需要的信号。且全部可从既有已平仓数据算出，无需新记录
- 实现（扩展 v83 的累加器，复用同源 reducer，零新记录）：Acc 加 grossWin/grossLoss（平仓时按盈亏累加）；StrategyPerformance 加 avgWinUsd/avgLossUsd/profitFactor/payoffRatio。profitFactor 无亏损时为 null（∞ 不误导）、payoff 需同时有盈有亏。render 加 edge 行（profit factor · payoff（avg win/avg loss）· expectancy/trade）；MCP strategy_compare 描述同步
- 测试覆盖：+3——混合盈亏算出 PF 3.5/payoff 1.75 / **75% 胜率但 PF 0.5（暴露流血）** / 无亏损→PF+payoff null / 未平仓→全 null；3592 测试全绿（+3）
- 向后兼容：纯加法——4 个新指标字段；复用 v83 累加器 + 共享 cost-basis reducer（与所有 P&L 面一致）；不改排名/已有字段

**Phase 113 — 安全网可靠性上 Web：运营商在主监控界面看到"护栏到底能不能生效"（safety-net reliability on the dashboard — engine liveness + notification delivery where the web operator watches）** ✅
- **把"护栏能否真正生效"的信号搬到 web 操作面**：web Safety 页显示配置 posture（配了哪些护栏）+ headroom（还剩多少额度）。但护栏只有在**引擎能触发止损 + 告警能送达运营商**时才真正保护你——v103 引擎存活只在 cron digest、v106 通知投递健康只在 doctor。主要用 web 监控的运营商看不到"引擎死了→止损静默失效"或"告警通道死了→盲飞"。posture 显示"hardened"而安全网实际断了
- 为什么重要：自主交易里运营商保持掌控的关键，是知道安全网真的在运转。把可靠性信号搬到运营商主盯的界面（v86/87/102 确立的"关键信号上滞后 web 界面"模式），让"我的护栏现在能生效吗"一眼可判。这直接服务"运营商掌控自主交易"
- 实现（复用 doctor 导出的 check，单一源）：`/api/safety` 扩展返回 `reliability: CheckResult[]`——调用 doctor 已导出的 `checkEngineLiveness`（v103 同源）+ `checkNotificationDelivery`（v106 同源），两者快速无 RPC。Safety.tsx 新增"Safety net operational?"卡片：逐 check badge（ok/warn/FAIL）+ message +（非 ok 时）hint。web 和 doctor 用同一判定、不分叉
- 测试覆盖：webAutomation.test.ts /api/safety 扩展断言（reliability 含 engine liveness + notification delivery、severity ∈ ok/warn/fail）；3589 后端测试全绿；webui `tsc -b && vite build` 干净（801 模块）
- 向后兼容：纯加法——/api/safety 仅增 reliability 字段（既有 posture/headroom 不变）；SafetyResp.reliability optional（旧 server 缺省时前端不渲染该卡）；复用 doctor checks 不改判定逻辑

**Phase 112 — logger.close() 保证 flush：消除测试套件里的计时竞态 flake（awaitable logger flush — kill the fixed-setTimeout race that made the suite intermittently red）** ✅
- **修复侵蚀"全绿"信号的 flaky 测试**：每次迭代我都靠"3589 全绿"来验证正确性工作。但 logger.test.ts 偶发失败（"fileLevel gates which levels reach the disk"）——`logger.close()` 是 fire-and-forget（`logStream.end()`），测试用固定 `setTimeout(50ms)` 等异步 flush 再读文件；并行满载下 50ms 不够，readFileSync 在 warn-keep/error-keep 落盘前就读了→失败。一个偶发红是真实负债：它侵蚀对测试套件的信任，还可能掩盖真实失败（开发者看到红以为是 flake 而忽略真 break）
- 为什么重要：测试套件是保护所有正确性投资（v104-v111 整条 value_usd 弧）的根基。一个不可信的"全绿"让每次迭代的验证打折。修掉 flake 的根因比任何新 feature 都更保护已有工作
- 实现（顺带改善生产）：`close()` 从 `void` 改为 `void | Promise<void>`——返回一个在流 `'finish'`（即已 flush 到 OS）时 resolve 的 Promise（`s.end(() => resolve())`），无流时立即返回；idempotent（二次 close 是 no-op）。不 await 的调用者（如 web.ts 关停）行为不变（Promise 被忽略、end 照常）；想要 flush 保证的（测试、tail 日志的关停）可 await。logger.test.ts 的 3 处 `close(); await setTimeout(50)` 换成 `await close()`——确定性、零竞态
- 生产收益：任何"关闭 logger 后读/依赖日志文件"的路径现在确定（如关停时 tail server.log）
- 测试覆盖：现有 15 个 logger 测试不变（行为相同、只是等待方式确定化）；logger 单跑 5×、全套跑 2× 全绿确认 flake 消除；3589 测试全绿
- 向后兼容：纯改进——接口拓宽为 `void | Promise<void>`（void 调用点全兼容）；createSilentLogger 委托 createLogger 无单独实现；不改日志写入逻辑

**Phase 111 — MTM walker 走真实交易也用 value_usd：gains/税务/promote/持仓与 pnl.ts 一致（toMtmRows feeds the MTM walker trade-time USD — gains/tax, promote, open_positions stop disagreeing with pnl.ts on non-stablecoin quotes）** ✅
- **修复 v107 留下的姊妹 bug（两个已实现口径分叉）**：v107 修了 pnl.ts 的 aggregateTrades 用 value_usd。但 gains.ts（税务）、promote-check、promote-outcome、open_positions 走的是另一条路——共享 MTM walker（computePaperPnlMtm），经 `toMtmRows` 把真实交易喂进去。toMtmRows 一直传**原始 quote_amount（报价代币单位）**。walker 的成本/已实现按 quote 计、但 MTM 现值按 USD（fetchPrice）算——只有 quote≈USD（稳定币）时才自洽。WETH 报价时，walker 路径的成本基础失真，且与 pnl.ts（v107 已修）**给出不同的已实现数字**
- 为什么重要：两个已实现/税务口径对同一笔非稳定币报价交易给出不同答案，是最该消灭的 coherence bug（同 v85/v100）。gains.ts 是报税数据。让所有走真实交易的 walker 消费者（税务/promote/持仓）与 pnl.ts 用同一个交易时刻精确美元，全部自洽
- 实现（外科手术、仅改适配器、不碰 walker/paper 路径）：toMtmRows（real→walker 适配器）把 quote_amount 设为 value_usd（有则用、否则回退原 quote_amount）。walker 的 cost=quoteAmt、sellPrice=quoteAmt/baseAmt 全部不用 `price` 字段，所以喂 USD 即让整条链 USD 自洽；fetchPrice(base) 本就 USD。稳定币/legacy 行回退（value_usd≈quote_amount，零变化）。paper 路径不经 toMtmRows，完全不动
- 测试覆盖：+4——value_usd 存在→quote_amount 用它（USD 非 0.5 WETH）/ 无 value_usd→回退原值 / 非正非有限→回退 / 非 success 行丢弃；3589 测试全绿（+4，logger.test 偶发 flake 隔离复跑通过、与本改动无关）
- 向后兼容：纯改进——仅 toMtmRows 适配器改动；稳定币+legacy 行为不变；walker 与 paper 路径零改动；与 v107 合体让所有已实现口径自洽

**Phase 110 — 持仓审阅合并保护状态：一次调用回答"赚没赚 + 有没有保护"（open positions gains per-position protection status — "how's it doing AND is it protected?" in one call）** ✅
- **补上持仓管理驾驶舱的缺口**：自主 agent 审阅持仓时，open_positions 给每个持仓的成本基础/未实现盈亏/税务期限/价格 context，却**不含保护状态**——"这个 +50% 的赢家有没有挂止损？离触发还有多远？"得另调 position_protection（v76，且是聚合报告、不带逐仓盈亏）。两个工具交叉对照才能回答"赚没赚 + 有没有保护"。一个裸奔的赢家在持仓审阅里看不出来
- 为什么重要：持仓管理是 agent 核心循环的一环。把保护状态并进持仓视图，让"该不该给这个仓加止损 / 这个赢家已保护、让它跑"成为一眼可判的决策，而非跨工具拼接。surfaces 一个 UNPROTECTED 的大赢家——既是有效性（管理）也是安全（暴露下行）
- 实现（复用 v76 matcher，零分歧）：OpenPositionEntry 加 `protection`（opt-in via withProtection）：status（protected/partial/unprotected）+ protectedAmount/unprotectedAmount + stops[]（覆盖该仓的 trailing/stop-loss 卖单）+ **downsideToStopPct**（当前价高于最高固定止损 floor 的缓冲 %，price_below 止损才有；trailing 用 trailPct 表达 giveback）。直接复用 v76 的 `computeProtection`（持仓 × 活跃保护性卖单匹配）——持仓审阅和保护审计不会分叉。real 用真实订单、paper 用 paper 订单；最佳努力（失败不破坏审阅）
- 新分析：downsideToStopPct——固定止损的"锁定下限"缓冲，是别处都没算的逐仓量化（"+50% 但止损在当前价下方 10%，跌破才触发"）
- 接入：CLI `--protection`、MCP open_positions `withProtection`（注入式 protOrdersImpl seam 供测试）；render 加 protection 行（🛡 protected / ⚠ partial / 🔴 UNPROTECTED + 止损描述 + 缓冲%）
- 测试覆盖：+5——trailing 覆盖→protected 无固定 floor / price_below→protected 带 10% 缓冲 / 无订单→UNPROTECTED / 别的 token 的订单不算 / withProtection off→无字段；3585 测试全绿（+5）
- 向后兼容：纯加法——protection opt-in（默认不加载订单）；复用 v76 computeProtection；不改持仓/盈亏计算

**Phase 109 — 策略对比/止损熔断用 value_usd：非稳定币报价策略不再"零亏损"地逃过熔断（strategy comparison + loss breaker use value_usd — a non-stablecoin-quoted strategy can no longer read $0 realized and dodge the v84 breaker）** ✅
- **修复一个有安全后果的 value_usd 缺口**：strategyCompare（"stablecoin-$1 模型"）此前对**非稳定币报价的交易直接跳过**（无法无 RPC 定价）→ 该策略 realizedUsd 恒为 \$0。但它喂着 v84 **止损熔断**（安全强制）、v99 headroom、v88 digest——于是一个 WETH 报价、正在亏钱的策略，熔断**永远不触发**（看到 \$0 亏损）、headroom 显示满额、digest 不报 bleeding。安全护栏对这类策略静默失效
- 为什么重要：止损熔断是按策略的真金白银自动护栏。它对一整类策略（非稳定币报价）失灵，是 v104/v107 同类的 value_usd 缺口——但这次直接削弱了**强制执行**。v104 刚把 value_usd（交易时刻精确美元，无 RPC、已持久化）备好，正好让 strategyCompare 既精确又仍然零 RPC
- 实现（外科手术，复用 value_usd + 同源 reducer）：computeStrategyComparison 的 tradeUsd 改为：有 value_usd→用它（非稳定币报价策略现在能被定价了，之前被跳过）；否则稳定币→\$1×amount（原模型）；否则非稳定币无 value_usd→仍 unpriced（回退不变）。StrategyTradeLite + toLite 加 value_usd 字段，real 模式经 recentTrades→toLite 自动带上（paper 无该列→回退，本就假定价）
- 测试覆盖：+3——WETH 报价策略经 value_usd 定价（realized −\$200、进 bleeding，之前 unpriced=\$0）/ 非稳定币无 value_usd 仍 unpriced（回退不变）/ value_usd 优先于 stablecoin-\$1 假设；3580 测试全绿（+3）
- 向后兼容：纯改进——既有"排除非稳定币报价"测试仍通过（那些行无 value_usd）；real 模式自动获益；paper 模式回退不变；不改 reducer/熔断逻辑

**Phase 108 — value_usd 覆盖到回填/导入路径：所有交易来源的 P&L/税务/预算一致精确（backfill the trade-time USD value on imported / `trades sync` rows — close the value_usd story across ALL trade sources）** ✅
- **补上 value_usd 弧的最后一块：导入/回填的交易**：v104 给实盘交易加了 value_usd，v107 让 P&L/税务用它（消除非稳定币报价的现价失真）。但 `trade import` / `trades sync`（链上回填外部/手动交易）建的行**没有 value_usd**——于是导入的历史交易在 P&L/税务/预算里仍走旧的现价近似。对**税务**尤其要命：运营商导入历史用来报税，非稳定币报价的成本基础按今天的价算就是错的
- 为什么重要：税务/P&L 是报税、决策依赖的最核心数字，必须对所有交易来源一致。`trades sync` 全程经 importTradeFromTx（一个修复同时覆盖 import + sync 两条回填路径）。这是 v104→v107 弧的收尾——让"交易时刻精确美元"覆盖 live + import + sync 全部来源，而非只有 live
- 实现（复用历史定价 + 同源 stablecoin 注册表，最佳努力）：importTradeFromTx 在 insert 前调 `importValueUsd(row, profile, logger)`——稳定币报价→\$1×amount（零网络）；非稳定币→该报价代币在区块日期的**历史价**（getHistoricalPrice，按 coin+date 缓存）；native 报价经 profile.weth 定价；失败/无 coinId→null（优雅回退到 v107 的现价近似，与之前完全一致，绝不让导入失败）。复用 v85 的 isStablecoin
- 测试覆盖：+5——稳定币→amount 零网络 / 非稳定币→amount×历史价 / native 经 WETH 定价 / 不可定价→null 回退 / airdrop 零额→null（无成本基础）；3577 测试全绿（+5）；getHistoricalPrice 以 vi.mock 注入保持离线确定性
- 向后兼容：纯改进——value_usd 失败即 null（与 pre-v108 完全相同的回退）；importTradeFromTx 本就异步+做 RPC，多一个缓存的历史价查询；不改 classify 逻辑

**Phase 107 — 已实现 P&L / 税务成本基础用"交易时刻美元"：消除非稳定币报价的现价失真（realized P&L + tax cost basis use trade-time USD via v104 value_usd — kill the current-price distortion on non-stablecoin quotes）** ✅
- **用 v104 的 value_usd 闭合一个被注释承认的 P&L 近似**：pnl.ts 一直把每笔的 USD 算成 `quote_amount × 报价代币的「当前」USD 价`（注释明说"没有历史报价价时这是最好的近似"）。对稳定币报价近似精确；但对 WETH 报价交易——成本基础被**按今天的 ETH 价重估**：WETH \$2000 时买入、现在 \$3000，成本基础凭空涨 50%，已实现/未实现 P&L 全失真。v104 刚加的 `value_usd`（交易时刻精确美元）正好提供历史价，能把近似变精确
- 为什么重要：P&L 和税务成本基础是 agent/运营商做决策、报税依赖的最核心数字。对非稳定币报价交易（WETH 计价）系统性失真，是 v104 同类（按报价代币单位错算 USD）的延伸——只是这次是"现价 vs 历史价"而非"代币单位 vs 美元"。把最重要的数字对所有报价类型做对
- 实现（外科手术式，复用 v104 数据 + v82 共享 reducer）：aggregateTrades（pnl.ts）+ enrichTradesForExport（tradeExport.ts，税务）的 `tradeUsd` 改为 `value_usd ?? (qUsd != null ? quoteAmt × qUsd : null)`——有交易时刻值就用（精确），legacy 行回退旧近似。附带修复：有 value_usd 但无实时报价价的行**不再被跳过**（之前 qUsd==null 直接 continue，丢失该笔 P&L）。两处同源修复，税务与 P&L 不会分叉
- 测试覆盖：+4——pnl（value_usd 驱动 realized=400 而非近似的 0 / 有 value_usd 无实时价仍计入 / 无 value_usd 回退 quoteAmt×qUsd）+ tradeExport（WETH 计价 lot 用 value_usd 算 cost_basis+proceeds+realized）；3572 测试全绿（+4）
- 向后兼容：纯改进——稳定币报价 value_usd≈quote_amount 行为不变；legacy 行（无 value_usd）回退旧近似；paper MTM walker 不动（paper_trades 无 value_usd 列、且本就用假定价）

**Phase 106 — 通知投递健康：静默失效的告警通道不再让运营商"盲飞"（notification-delivery health — a silently-dead alert channel is caught proactively, not discovered during an incident）** ✅
- **补上"告警通道死了也没人知道"的信任盲区**：运营商靠 notifications.channels（webhook/Slack/Discord/Telegram）接收 digest、安全告警、agent 审批待办。`notify()` 每次投递都知道每个通道成功/失败，但**从不持久化**——一个 setup 时能用、之后 URL 轮换/吊销而失效的通道，会**永远静默失败**。运营商停止收到任何告警却毫不知情，恰恰在出事、最需要告警时盲飞。只有手动跑 `notify test` 才会发现
- 为什么重要：自主交易的整个安全网（断路器、引擎存活、偏离检测…）最终都靠"告警真的送达运营商"。通道静默失效=安全网的最后一跳断了。这是 v103（引擎存活）同类的可靠性盲区——运营商依赖、静默损坏、必须主动暴露。被动追踪（无需手动 test）在运营商下次 check-in 时就报"你的告警两天没送出去了"
- 实现（被动追踪 + pull-based 暴露）：迁移 v66 加 `notification_health` 表（每通道一行：last_success_at / last_failure_at / consecutive_failures / last_error）。db `recordNotificationDelivery`（成功重置连败streak+清错误、失败累加）+ `listNotificationHealth`。`notify()` 对每个**实际尝试**的投递（跳过的 dedup/severity/quiet-hours 不算）best-effort 记录（DB 故障绝不阻断投递、无 data dir 的测试保持 hermetic）。doctor `checkNotificationDelivery`：任一通道连败≥3 → **fail**（"你的告警可能没送达"+last error+`notify test` 提示）。用 pull-based 的 doctor 暴露——正因为 push 通道本身可能就是坏的那个
- 测试覆盖：+6——db（失败累加streak / 成功重置+清错误 / 每通道独立 upsert）+ doctor（无记录→ok / streak<3→ok / streak≥3→fail 点名通道+提示）；3568 测试全绿（+6）；doctor 已烟测
- 向后兼容：纯加法——新表 + 新 db helper + 新 doctor check；notify() 投递路径只多一个 best-effort 持久化（try/catch 包裹，永不阻断）；无 data dir 的调用点静默 no-op

**Phase 105.1 — 让风险定仓可执行：一条命令完成"按风险定仓 + 入场即挂止损"（make risk sizing actionable — emit a ready-to-run protected entry, the disciplined path in one call）** ✅
- **把 v105 从"建议数字"变成"可执行的纪律入场"**：v105 算出该买多少（advisory），但 agent 还得手动把数字穿进 buy、还得记得用同一个止损距离挂保护单——两步、易错（数字穿错、忘挂止损）。本期用 v98 的 detect→respond 模式，让 `risk_size` 直接产出一条**现成的 buy**（带算好的 quoteAmount + 把止损距离作为 protectTrailPct 挂上），把"按风险定仓→执行→保护"合成一次原子操作
- 为什么重要：自主 agent 里，让正确的事成为容易的事（同 v93 一键加固的哲学）。两步之间的缝隙正是出错处——算了风险尺寸却 fat-finger 金额、或忘了挂止损裸奔。一条 recommendedActions 消除这整类错误：尺寸来自风险预算（被安全天花板夹住）、止损就是定仓假设的那个距离——realized 风险=预算
- 实现（report/MCP/CLI 层，不碰关键交易路径）：gatherRiskSize 加 `quotePriceUsd`（finalUsd→quoteAmount 转换）+ `recommendedActions: NextAction[]`——direction=buy 且有 quote 价时产出 `{tool:'buy', params:{base, quote, quoteAmount, protectTrailPct(=trail 止损距离时), strategy}}`；sell / 无 quote 价 → 空 + caveat。MCP risk_size 解析并定价 quote 代币（默认 USDC≈$1）；CLI 渲染成 `trade buy --base … --quoteAmount … --protect-trail …`（翻译成 CLI flag 名）+ 用 isStablecoin（v85）对稳定币 quote 默认 \$1 价、保持离线
- 关键正确性细节：amount 走 finalUsd（被夹住的尺寸，非原始推荐）——ceiling 夹到 \$500 时 buy 就是 \$500 不是 \$1000；MCP 工具 param 名（quoteAmount/protectTrailPct）vs CLI flag 名（--quoteAmount/--protect-trail）各自正确翻译；protectTrailPct 确认在 buy 工具 schema 内
- 测试覆盖：+6——产出带 quoteAmount+protectTrailPct 的 buy / 非稳定币 quote 价换算 / stop-loss 源不预挂 trail / 无 quote 价→空+caveat / sell 不产出 / **夹住的尺寸进 amount（\$500 非 \$1000）**；3562 测试全绿（+6）；CLI 已烟测（输出可直接运行的 entry 命令）
- 向后兼容：纯加法——新增 report 字段 + MCP/CLI flag；不改 buy/executeTrade 关键路径（next-action 只是建议，agent 自行执行）

**Phase 105 — 按风险定仓：止损会亏多少决定买多少（risk-based position sizing — size by risk budget ÷ stop distance, clamped by the safety ceiling）** ✅
- **补上"该买多少"这个交易核心原语（有效性支柱，非又一个安全护栏）**：v70 的 `trade_sizing` 回答"安全策略允许我最多买多少"（硬上限）。但缺了纪律交易每笔都要问的正交问题——"为了让止损命中时只亏掉我的风险预算，我应该买多少？"。`recommendedUsd = riskUsd ÷ (止损距离%)`（风险 \$50、止损 5% → \$1000：\$1000 跌 5% 正好亏 \$50）。这是把仓位大小和风险挂钩的纪律，是自主 agent **不爆仓**的基石——框架之前只给安全天花板，不给风险适配的尺寸
- 为什么是最重要的：交易产品在安全之外，最重要的是帮 agent 有纪律地活下来。无纪律定仓（每笔风险无界）是爆仓的头号原因。这个原语和已有件无缝组合——agent 用 v80 入场即挂的追踪止损（trail %），风险定仓说"挂 5% 追踪止损、想冒 \$50 风险 → 买 \$1000"；再由 v70 天花板夹住（绝不超出策略允许）
- 实现（纯函数 + 复用 v70 天花板，advisory 层）：新 `riskSizing.ts`——纯 `recommendedRiskSize({riskUsd, stopDistancePct})`；`gatherRiskSize` 解析风险预算（--risk-usd 绝对值，或 --risk-pct × --portfolio-usd）+ 止损距离（--stop-pct 止损 / --trail-pct 追踪），算 recommended，调 `gatherTradeSizing` 取安全天花板，`finalUsd = min(recommended, 天花板)`，报告 boundBy（风险预算 vs 哪条安全约束）+ effectiveRiskUsd（天花板夹住时实际风险 < 预算）。风险层是 advisory——只收窄推荐尺寸、绝不放宽 maxTradeUsd 的"政策允许"含义
- 接入：CLI `safety size-by-risk`、MCP `risk_size`（含 price→baseAmount 转换，复用 trade_sizing 的解析/定价路径）；MCP_TOOLS 不变量已注册
- 测试覆盖：+13——纯公式（风险÷止损、更紧止损更大仓、非正→null）/ 预算解析（绝对 vs %×组合）/ 止损源（stop-loss vs trail）/ price→baseAmount / **天花板夹紧**（per-tx 夹到 \$500、实际风险降到 \$25、给出 caveat；宽天花板不夹；daily-remaining 当 binding）/ 错误（无风险源 / risk-pct 缺 portfolio / 无止损）；3556 测试全绿（+13）；CLI 已烟测
- 向后兼容：纯加法——新模块/CLI 子命令/MCP 工具；不改 v70 sizing 逻辑（天花板含义不变）；advisory 不影响任何强制路径

**Phase 104 — USD 预算按"美元"计而非"报价代币单位"：修复每日上限/策略预算对非稳定币报价交易的静默错算（USD budgets sum DOLLARS, not raw quote-token units — fix the daily-cap/strategy-budget undercount for non-stablecoin quotes）** ✅
- **审计发现的安全护栏正确性 bug（非加 feature，是修错）**：整个 USD 预算层（每日 USD 上限 `dailyUsdVolume` + 策略预算 `usdSpentUnderStrategy`）历史上把 `quote_amount`（报价**代币**数量）直接当美元累加——**仅当报价是稳定币时才对**。一笔 WETH 报价的交易（quote_amount=0.5 WETH，约 \$1500）只算 \$0.50 进每日上限——把第二基础的安全护栏**静默低估约 1000×**。而单笔上限（per-tx）用的是 `estimatedUsd`（quote_amount × 报价代币 USD 价，**正确**）——两者不一致，每日的那个是错的。一个用 WETH 报价交易的 agent 能把每日 USD 限额超出几个数量级
- 为什么是最重要的：自主交易的护栏必须真的按美元约束住。这是 v85（稳定币集合分叉）/v100（护栏计数漏项）同一类静默错算 bug，但发生在**强制执行层**（不只是显示）——比任何新 feature 都重要，因为它让运营商以为有的 USD 上限保护实际是漏的
- 实现（持久化真实 USD 值 + 同源求和）：迁移 v65 给 `trades` 加 `value_usd REAL` 列；交易记录时存入执行时算好的 `estimatedUsd`（quote_amount × 报价 USD 价）。`dailyUsdVolume` + `usdSpentUnderStrategy` 改为 `value_usd ?? quote_amount`——有真实 USD 值就用，legacy/不可定价行回退 quote_amount（稳定币装机正确，且是 legacy 行唯一可用数）。per-tx 用 estimatedUsd、daily 用持久化的同一个 estimatedUsd→现在二者一致
- 连带修复显示层一致性：digest 的 trades `usdVolume`（也在累加 quote_amount）同样改用 value_usd 回退——否则会出现"digest 显示成交额 \$X、上限却按 \$Y 计"的新不一致。value_usd 也进了 TRADE_COLUMNS（CSV/JSON 导出 + 编译期穷尽守卫保证 TradeRow↔导出列同步）
- 测试覆盖：+5——dailyUsdVolume 用 value_usd（WETH 交易计 \$1500 非 0.5）/ legacy 回退 quote_amount / 混合行 / usdSpentUnderStrategy 同样 / digest usdVolume 用 value_usd；3543 测试全绿（+5）；迁移经测试套件（fresh DB）验证
- 向后兼容：纯加法——`value_usd` 列 nullable；legacy 行（null）回退 quote_amount（与旧行为一致，稳定币装机零变化）；import/transfer 路径暂不填 value_usd→回退（已知小限制，可后续增强）；不改 per-tx 逻辑（本就正确）

**Phase 103 — 引擎存活进 digest：引擎死了、保护性止损静默失效，心跳必须报警（engine liveness in the digest — a dead engine means trailing stops are silently inert）** ✅
- **补上"心跳显示健康、引擎实际已死"的盲区**：引擎守护进程负责触发每一个定时单/DCA/再平衡，以及每一个保护性追踪止损。引擎一旦宕掉，这些全部静默失效——尤其**一个静默失效的追踪止损 = 一个无保护的持仓在一路下跌、却没人知道**。doctor 能查到（"有活动 primitive 但引擎状态过期"），但只在运营商手动跑时；cron digest（运营商真正盯的主心跳、带三档 verdict）**没有引擎存活信号**。digest 报"healthy"而引擎已死、止损全失效——正是 v55/v57 修过的那类危险盲区（"心跳说健康，钱包却敞着"）
- 为什么是最重要的：自主交易里最吓人的静默失败之一——你以为有追踪止损保护持仓，但触发它的引擎是死的，持仓一路裸奔到底。运营商必须主动知道。这是可靠性支柱（相对安全支柱被反复打磨，可靠性被低估了），且 digest 报假"healthy"比没有 digest 更糟
- 关键洞察——区分 PROTECTIVE vs 其他：引擎死 + 有保护性止损（追踪止损/price_below 卖单，下行退出）→ **CRITICAL**（持仓裸奔）；引擎死 + 仅普通 primitive（DCA/限价）→ attention（漏单，非裸奔）；无活动 primitive → 静默（引擎本就可选）。这个区分让信号直接回答"我的持仓现在真的有保护吗"，比 doctor 的扁平 warn 更精准
- 实现（复用 doctor 同源，零分歧）：`gatherEngine()` 复用 `readEngineStatus()` + 活动 primitive 计数（与 doctor.checkEngineLiveness 同源，6h 过期阈值一致，杜绝第二套"引擎算不算死"的定义），但返回结构化数据并额外隔离 protectiveOrders（side=sell 且 trigger=trailing/price_below）。STANDING 信号（同 posture，在 gatherWindow 算、prior 对比里为 null）；best-effort→null。classifyVerdict 升级；text+slack 仅在引擎死且有 primitive 依赖时渲染
- 测试覆盖：+7——classifyVerdict（保护性止损→critical / 仅普通→attention / 无 primitive→healthy / 引擎活→不升级）+ 端到端（无 primitive 不拖累 verdict / 活的追踪止损卖单→critical 计入 protective / price_above 买单→attention 非 protective）；3538 测试全绿（+7）；CLI JSON 已烟测、MCP 描述同步
- 向后兼容：纯加法——`engine` 字段 optional；text/slack 仅故障时渲染；复用 readEngineStatus（无新状态源）；engine.js 静态引入无循环（engine→digestPush 是动态 import）；不改引擎/doctor 逻辑

**Phase 102 — 审批队列上 Web：运营商在主监控界面就能审阅 agent 提案（trade-approval queue on the dashboard — review proposals where the operator already watches）** ✅
- **把人在回路控制接到运营商真正盯着的界面**：v47 审批门（agent 提案/人决定）是自主交易最关键的人在回路控制。但 Web 上只有 Overview 的一个**计数横幅**（"N 笔交易待批"）——要真正看 agent 想干什么（交易内容、preview、v101 的 WHY-gated 理由），运营商必须切到 CLI。`/api/intents` 连 preview/request/approval_reasons 都不返回，光有计数。Web 是运营商的主监控面，"看都看不到要批什么"是真实摩擦
- 为什么是最重要的：审批队列是阻塞 agent、等待人决策的地方——延迟决策=agent 卡住。把提案审阅放到运营商已经在盯的界面（而非强制切 CLF），缩短决策延迟，直接服务"人保持对自主交易的控制"。这是 v86/87 确立的"把关键信号搬上滞后的 Web 界面"模式，这次搬的是最关键的控制面
- 关键安全边界：**审阅在 Web、决定在 CLI**。approve/reject 故意保持 CLI-only（prompt-injection 的 agent——或认证更弱的 Web 会话——绝不能批准 agent 自己的花费，同 backup/panic 边界）。Web 页只读：展示提案全貌 + 一键复制 CLI approve/reject 命令，运营商在终端执行
- 实现：后端 `/api/intents` 补全审阅上下文——解析 preview_json（价格/数量/聚合器/符号）、request（base/quote）、v101 `approval_reasons_json`（为何 gated）、approveCmd/rejectCmd（精确 CLI 命令）；安全解析（坏 blob 降级 null/[]，绝不 500 整个队列）。前端新 `Intents.tsx`（"Approval queue" tab）：pending 卡片显示 buy/sell+pair+~USD+到期倒计时、⚠ gated 理由、preview、agent reason、复制 approve/reject 命令按钮；下方"Recent decisions"表。Overview 横幅改为指向新 tab
- 测试覆盖：webAutomation.test.ts +2（审阅上下文：preview/base/quote/approvalReasons/CLI 命令齐全；坏 blob 不 500、降级 null/[]）；3531 后端测试全绿（+2）；webui `tsc -b && vite build` 干净通过（801 模块）
- 向后兼容：纯加法——`/api/intents` 仅增字段（既有计数/列表不变）；新只读页；不改审批 enforce/CLI 决策路径；安全边界不变（approve 仍 CLI-only）

**Phase 101 — 风险感知审批门：把"该让人看的交易"路由给人，而非只看金额（risk-aware approval gate — route trades to the human by NOVELTY, not just size）** ✅
- **修复审批门的"风险盲区"**：v47 人在回路审批门只看一个维度——USD 金额（`thresholdUsd` 之上才需人批）。但这是**风险盲的**：一笔 \$20 买入一个全新未知代币（prompt-injection 抽资的经典手法——给攻击者代币的池子打钱）轻松溜过阈值，而一笔 \$500 买你天天交易的 USDC 却要人批。金额≠风险，门却只认金额
- 为什么是最重要的：审批门是自主交易最关键的人在回路控制——它决定**哪些交易该惊动人**。产品投了大量精力做风险检测（preflight/honeypot/allowlist），但这些信号从不影响"谁来决定这笔交易"。让门按风险（而非仅金额）路由，意味着人只为真正该看的交易被打扰——新代币——而例行安全交易无论金额自动执行。这直接服务"安全自主交易"，且把已有的风险信号接进了控制平面
- 实现（结构化决策 + 单一新触发，纯函数）：`safety.tradeApproval` 加 `requireForNewToken`（默认 false，向后兼容）。`needsApproval(gate, signals)` 从返回 boolean 改为返回 `{required, reasons[]}`——SIZE 维度（阈值，含 unpriceable 保守 gate）+ NOVELTY 维度（仅 BUY：本账户在该链从未成功成交过的 base 代币，size-blind）。novelty 检测复用新 DB 原语 `hasPriorTokenFill`（success-only、双向、链隔离）。触发理由 `reasons[]` 贯穿：持久化（新增 `approval_reasons_json` 列，migration v64）、通知（人看到"为什么"是新代币还是金额）、MCP 结果 note + intents_list `approvalReasons`、CLI `intents show` 的 `gated by:` 行
- 为什么不是硬 allowlist：硬代币 allowlist 是"禁止"，这是"先问人"——更软的中间地带：agent 仍可交易新代币，但人先看一眼。适合没开 allowlist 的运营商
- 测试覆盖：+11——needsApproval（金额/novelty/SELL 不触发 novelty/双触发理由累积）、hasPriorTokenFill（never/success/failed-不算/链隔离/SELL 也算）、intent 持久化往返（approval_reasons_json）；3529 测试全绿（+11）；config schema + CLI 已烟测
- 向后兼容：纯加法——`requireForNewToken` 默认 false（纯金额行为不变）；needsApproval 结构化返回（仅一个内部调用点）；新 DB 列 nullable（pre-v101 intent 为 null）；migration 纯加列

**Phase 100 — digest 安全事件全覆盖：每一次护栏拦截都进运营商心跳（comprehensive guardrail-block accounting — no real-money safety event stays invisible in the digest）** ✅
- **补上 digest 安全统计的静默漏洞**：cron digest 的安全段（运营商的主心跳）从一个硬编码 switch 里只数 5 个护栏码（drawdown / 策略预算 / 持仓 / honeypot / gas）。但护栏码这些迭代加了一堆——v84 止损熔断、AMOUNT_EXCEEDS_LIMIT（单笔/每日 USD 上限，**最基础的护栏**）、SLIPPAGE_TOO_HIGH、QUOTE_DEVIATION_EXCEEDED、POSITION_CAP_EXCEEDED、CONTRACT_BLOCKED——**全都没被数进去**。一笔被单笔上限拦下、或止损熔断拦下的真金白银安全事件，在 digest 里只会落进泛泛的"top errors"，不被识别为安全事件、不进 verdict。switch 在护栏码增长时静默落后了（和 v85 稳定币集合分叉同一类问题）
- 为什么是最重要的：digest 是运营商对自主 agent 的主要可观测窗口。一个护栏触发=真钱被一道配置的安全策略拦下，这正是 digest 安全段存在的意义。最基础的护栏（单笔 USD 上限）和最新的（止损熔断 v84，刚在 v99 补了 headroom 预警）在心跳里**不可见**，是个真实的覆盖漏洞——v99 让"逼近"可见，本期让"已触发"可见
- 实现（单一事实源 + 回归守卫，复用 v85/v71 合一哲学）：errors.ts 新增 `GUARDRAIL_BLOCK_CODES` 单一注册表（12 个护栏码——明确区分于 v89-92 的 agent-lockdown 安全码，那是另一类）。digest 安全段对全部护栏码计数，分桶：amountLimitBlocks（单笔/每日上限）、strategyLossBlocks（v84 止损熔断）、executionCapBlocks（滑点+报价偏离）、positionLimitBlocks（持仓上限+敞口上限合并）、otherGuardrailBlocks（合约 allow/deny + safeguard 兜底，保证完整）。全部喂进 verdict 的 safetyBlockTotal，止损熔断+单笔上限在理由里点名
- 关键守卫：digest.test.ts 的 **回归守卫**遍历 `GUARDRAIL_BLOCK_CODES` 每个码、各塞一条 audit 行、断言 digest 的桶总和恰好+1——任何未来新增护栏码若没接进 digest 会立刻测试失败，杜绝再次静默落后（同 v85 的 src 扫描守卫）
- 测试覆盖：digest.test.ts +5（verdict：单笔上限→attention 点名 / 止损熔断→attention 点名；gatherSafety：单笔+止损计数 / 持仓+敞口合并、滑点+报价偏离合并；**回归守卫**：每个护栏码恰好进一个桶）；3518 测试全绿（+5）；CLI text+slack 渲染补齐、MCP digest_summary 描述同步、JSON 已烟测
- 向后兼容：纯加法——4 个新计数字段；既有 5 桶语义不变（positionLimitBlocks 仅扩容纳入 POSITION_CAP_EXCEEDED）；单一注册表供未来复用；不改护栏 enforce 逻辑

**Phase 99 — 止损熔断也有提前预警：唯一的"静默悬崖"补上 headroom（strategy loss-breaker headroom — the last safety limit with no early warning gets one）** ✅
- **补上唯一一个没有提前预警的安全限额**：safetyHeadroom（v53）的整个存在意义就是"让自主 agent 知道自己离每条红线还有多远，从而提前 size 动作"——它追踪每日 USD、单笔、策略预算、回撤熔断、限频、持仓上限，全都有 `approaching`（≥80%）预警。唯独 v84 的**策略已实现止损熔断**（maxStrategyLossUsd）不在其中：一个策略一路"正常"，直到某笔 buy 突然被 STRATEGY_LOSS_BREAKER_TRIPPED 拦下——**静默二元悬崖**，与产品"提前预警"的哲学相悖
- 为什么是最重要的：止损熔断是真金白银的最后一道自动护栏。其他所有限额都能"看见它逼近"，唯独这一道不能，意味着 agent 无法在被拦之前主动停手——它会一直撞墙、被拒、重试，而不是"还剩 \$80 就触发，我这个策略先别买了"。把它接进 headroom，让最该提前看见的安全信号（正在亏损、逼近熔断）变得可预见，是 headroom 模块覆盖度的收尾，也直接服务"安全自主交易"
- 实现（复用熔断同源 realized P&L，零分歧）：`gatherSafetyHeadroom` 在 `maxStrategyLossUsd` 配置时，对每个**正在亏损**的策略（realizedUsd<0；盈利的满 headroom、不出条目避免噪声）发一条 HeadroomEntry——used=已实现亏损、limit=cap、util=loss/cap、status=tripped（realized≤−cap）否则 classify（80% approaching）。realized 来源**直接复用熔断 enforce 的 `gatherStrategyComparison`**（注入式 seam 供测试），headroom 永远不会和真实闸门给出不同数字。real 模式（对齐 live gate）
- 自动下游收益：headroom 的 `binding`（最紧约束）喂给 cron digest 的 posture 行（gatherPosture）+ `safety headroom` CLI + MCP `safety_headroom`——一处接入，三处提前预警。逼近熔断的策略现在会成为 digest 的 binding 约束浮到运营商眼前
- 测试覆盖：safetyHeadroom.test.ts +5（approaching 带剩余额度 / 过 cap→tripped 且文案含 buys blocked / 盈利或持平策略无条目只有亏损的出 / 未配置无条目 / 逼近的止损熔断能成为 binding 约束）；3513 测试全绿（+5）；CLI 已烟测；MCP 描述同步
- 向后兼容：纯加法——仅在 maxStrategyLossUsd 配置且策略亏损时新增条目；注入式 seam 保持测试纯净；复用既有 realized 源（零阈值漂移）；不改熔断 enforce 逻辑

**Phase 98 — detect→respond：偏离的已晋升策略给出结构化的"该怎么办"（promote-outcome recommendedActions — close the trust pipeline's final gap from detection to the protective response）** ✅
- **检测到了，然后呢？**：信任管道的检测端已经很完整——v50 promote-outcome 判定 diverged/underperforming，v95 让它进 cron digest 主动暴露。但检测到"这个已晋升策略在实盘亏钱/低于纸面承诺"之后，报告只给 `verdict` + `reasons[]`，**没有任何结构化的响应指引**。运营商凭直觉知道"该 demote 或砍掉"，但 **agent 经 MCP 拿到 `verdict: "diverged"` 却不知道下一步调什么工具**——这正是产品到处都有 `recommendedActions[]`（每个 MCP 工具都带 next_actions）的原因，唯独最危险结局的检测器没有
- 为什么是最重要的：托管真钱的 agent，最危险的不是看不见问题，而是**看见了却不知道怎么安全响应**。"diverged = 实盘正在亏钱"的正确响应是立刻 demote 回 paper——停掉真钱交易、同时保留策略状态（HWM/计数器）以便观察或修复后重新晋升。把这个响应**结构化、内联进检测结果**，让 agent 不止知道"出事了"，而是知道"调 playbook_promote {to:'paper', yes:true} 止血"。这收尾了信任管道的最后一环：paper→promote-check→promote→live→outcome→**respond**
- 实现（复用全局 `recommendedActions: NextAction[]` 标准，按 verdict 映射）：`PromoteOutcomeReport` 加 `recommendedActions`，纯函数 `recommendedActionsFor(verdict, id, name)` 映射——**diverged** → demote NOW，`{id, to:'paper', yes:true}`（活跃亏损，止血动作零摩擦预填 yes）；**underperforming** → 建议 demote，`{id, to:'paper'}`**故意不预填 yes**（可恢复还是砍掉是运营商判断，强制有意识确认）；on_track / insufficient_data → 无动作。CLI render 把 agent 工具调用翻译成运营商命令形式（`tradekit playbook promote <id> --to paper [--yes]`）；MCP `playbook_outcome` 直接返回整个报告，agent 自动拿到
- 测试覆盖：promoteOutcome.test.ts +4（diverged→demote 预填 yes + render 含 --yes / underperforming→demote 不预填 yes + render 不含 --yes / on_track→空 / insufficient_data→空）；3508 测试全绿（+4）；CLI 路径已烟测
- 向后兼容：纯加法——`recommendedActions` 新字段；render 只在非空时多印一个 Recommended 块；复用既有 NextAction 类型 + demote 动作（playbook_promote to=paper，早已存在）；不改 verdict 判定逻辑；digest 的 v95 promote section 只读 verdict/reasons，不受影响

**Phase 97 — readiness 闸到达 agent 侧：MCP promote 也问"策略证明过自己了吗？"（the readiness gate reaches the agent — MCP playbook_promote gains the same third gate）** ✅
- **补上 v96 的 MCP 半边——agent 也会晋升真钱**：v96 给 CLI promote 接上了第三道就绪闸，但 `playbook_promote` **同样暴露在 MCP 上**（agent 可调）。MCP 工具跑了 v36 资金闸（requireFunded）+ v52 安全闸（requireSafe），却**完全跳过 v96 就绪检查**——agent 经 MCP 可以把一个只跑了 1 天、1 笔成交、零业绩的纸面策略零摩擦晋升上真钱。CLI 有质量闸、MCP 没有：v96 在 agent 侧是半残的
- 为什么是 v96 的一部分而非新功能：产品最危险的动作是"让 agent 开始用真钱"，而 promote **正是 agent 自己能调的 MCP 工具**。只给运营商（CLI）装质量闸、却让 agent（更需要被 gate 的一方）经 MCP 绕过，等于护栏装在了没人闯的门上。要让 v96 真正成立，readiness 必须到达 agent 实际走的那条路径——这是让 v96 完整，不是第 N 个 feature（同 v92 让 v91 真正生效的逻辑）
- 实现（三道闸对称，复用 v96 引擎）：MCP `playbook_promote` 加 `requireReady` 参数（同 requireFunded/requireSafe 形态：optional、默认 advisory、"strongly recommended for agent-driven promotes"）。`to===real && !skipPreflight` 时跑 `gatherPromoteCheck` 并把 `readiness` 报告**始终**挂进结果（agent 可 inspect），`requireReady===true` 时 verdict===not_ready 抛 `PROMOTE_NOT_READY`。gather 失败（RPC）降级 advisory，真正的 not_ready block 穿透。`skipPreflight` 现在统一关全部三道（funding/safety/readiness）
- 测试覆盖：strategy-tools.test.ts +1（promote 暴露 requireReady 参数 + 描述含 PROMOTE_NOT_READY/readiness）；行为由 promoteCheck.test.ts 的纯 `promoteReadinessBlocker` 测试覆盖（同 requireSafe 的测试惯例——full handler 走 RPC 不在此驱动）；3504 测试全绿（+1）
- 向后兼容：纯加法——`requireReady` optional 默认 advisory（同另两道闸）；`readiness` 结果字段纯加；复用 v96 的 `gatherPromoteCheck`/`promoteReadinessBlocker`（零阈值漂移）；不改既有 funding/safety 闸

**Phase 96 — promote 第三道闸：晋升真钱前先问"策略本身证明过自己了吗？"（the readiness gate — wire promote-check INTO promote, so the most important question can't be forgotten）** ✅
- **把信任管道里最该问的问题接进唯一会真金白银的动作**：`playbook promote <id>`（纸面→真钱的那一刻）跑了两道 preflight——v36 资金（钱包付得起吗？`--require-funded`）+ v52 安全（钱包有护栏吗？`--require-safe`）。但它**从不查 promoteCheck**（v49，"这个纸面策略证明过自己了吗？"）——这个策略质量闸是一个**完全独立的命令**，运营商得自己记得去跑。代码注释自己都写着"promote-check 是 promote 决策的策略质量那一半（promote 本身只跑资金 preflight 那一半）"。结果：一个只跑了 1 天、2 笔成交、40% 纸面回撤的策略，可以零摩擦地被晋升上真钱，因为 promote 根本不看它的就绪度
- 为什么是最重要的：整个产品最危险的动作就是"让 agent 开始用真钱交易"。今天三个问题里有两个被 gate 了（付得起 / 有护栏），唯独最重要的第三个——"这策略到底行不行？"——被留给运营商的记忆。把就绪度从"独立命令、advisory"变成"和另两道闸同一条 preflight 轨道上的 gate"，让最关键的判断不再可能被遗忘。这是 v49 就绪检查的收尾：detect（检查就绪度）→ **enforce**（接进 promote 动作）
- 实现（对称三道闸 + 复用 v49 引擎，零阈值重复）：新纯函数 `promoteReadinessBlocker(report)`——镜像 `safetyPromoteBlocker` / `preflightBlocker`，仅当 verdict===`not_ready`（硬证据底线：纸面运行天数 < 最小 / 成交数 < 最小）时返回 blocker，`caution` 级质量旗标（亏损 PnL / 深回撤 / friction 吃掉 edge）是运营商自己的判断、绝不硬停。promote 命令加第三道闸：`to===real && !--skip-preflight` 时跑 `gatherPromoteCheck` 并打印就绪 verdict+reasons（advisory），`--require-ready` 时 verdict===not_ready 抛 `PROMOTE_NOT_READY`。gather 失败（RPC 不可用）降级为 advisory-skip，但真正的就绪 block 必须穿透（catch 里 re-throw PROMOTE_NOT_READY）
- 新错误码 `PROMOTE_NOT_READY`（403 组——precondition/forbidden-state，同 SAFEGUARD_TRIGGERED）：与资金闸（INSUFFICIENT_BALANCE）、安全闸（SAFEGUARD_TRIGGERED）语义区分，agent/运营商可精确 branch
- 测试覆盖：promoteCheck.test.ts +3（not_ready→block 且列出证据底线失败 / ready→不 block / caution-only→不 block，质量旗标不是底线）+ errors.test.ts +1（PROMOTE_NOT_READY→403）；3503 测试全绿（+3）；usage + 干净错误路径已烟测
- 向后兼容：纯加法——三道闸全 advisory 默认（`--require-ready` 才硬停，同 `--require-funded`/`--require-safe`）；`--skip-preflight` 统一关全部三道；新错误码纯加；不改 promoteCheck 既有 verdict 逻辑

**Phase 95 — promote-outcome 进 cron digest：主动抓住"纸面漂亮、实盘悄悄亏钱"的已晋升策略（promote-outcome divergence in the digest — surface the trust pipeline's most dangerous outcome PROACTIVELY）** ✅
- **让信任管道最危险的信号变主动**：v49/v50 建了完整的纸面→实盘信任管道——promoteCheck（前向：这个纸面策略能上真钱吗？）+ promoteOutcome（后向：晋升后实盘兑现了纸面承诺吗？）。promoteOutcome 模块自己的注释说它抓的是"整个管道存在的意义就是防止的那个最危险结局：纸面看着很棒、实盘悄悄亏钱"。但它**只能按需查**（CLI/MCP），运营商得记得去跑。cron digest 是运营商的主动心跳；v88 把"原始亏损策略"放进了 digest，但一个策略可以**实盘正收益**（v88 不报警）却只兑现了纸面承诺的 30%、或滑点是纸面的 2 倍——这个 divergence 信号正是 digest 缺的
- 为什么是最重要的：把真钱托付给自主 agent，最危险的不是单笔爆炸，而是**一个已晋升策略在"机械上成功"的同时持续低于预期地漏钱**——运营商不主动查就发现不了，等发现真金白银已经流走。把这个信号接进每 15 分钟的心跳，让管道最重要的判断从"按需"变"主动"。这收尾了 detect→journal→correlate→validate→**proactive surfacing** 这条可观测性弧
- 实现（复用 v50 verdict 引擎，零阈值重复）：`gatherPromoteOutcomes(config, now)` 枚举所有 `status=deployed` 的 playbook，对每个调用**同一个** `gatherPromoteOutcome`（v50）——digest 永远不会和 `playbook promote-outcome` 给出不同判断。verdict 是确定性 + 离线的（只看已实现 PnL + 执行质量 + cadence，从不依赖 MTM），所以注入 `markPriceFn: async () => null` 保持 digest 的无 RPC 本性。只收集 `underperforming`/`diverged`（on_track/insufficient_data 无可操作项，略过）。最佳努力：单个 playbook 失败不拖垮 digest，整个扫描失败降级为 null
- verdict 升级：`diverged`（实盘不赚钱、对着一个证明该投真钱的纸面基线）= 管道最危险结局 → **critical**（运营商应暂停/砍掉）；`underperforming`（edge 缩水 / 执行明显更差）→ **attention**。在 `classifyVerdict` 里统一升级（单一 verdict 真相源，不 ad-hoc），digest 文本 + slack + MCP `digest_summary` 的 `promote` 字段都带；prior-window 对比里 promote=null（标准 STANDING 信号约定，同 posture）
- 架构：promote 是 STANDING（非窗口）信号，所以在 `gatherDigest`（异步）层算、不在 `gatherWindow`（同步）里——`gatherDigest` 因此变 async，连带 `gatherIncidentReport` + 各 4/2 个调用点 await（全在 async 上下文，无 ripple 阻力）
- 测试覆盖：digest.test.ts +7——classifyVerdict 4（diverged→critical / underperforming→attention / diverged 压过 underperforming 且两条理由都出 / 无 flagged 不升级）+ 端到端 3（无 deployed playbook→promote=null / 纸面赚钱实盘亏→diverged+critical / on_track→section 在但 flagged 空、不升级）；3500 测试全绿（+7）
- 向后兼容：纯加法——`promote` 字段 optional；digest 文本/slack 只在 flagged 非空时渲染（on-track 静默）；复用既有 verdict 引擎（零阈值漂移）；async 化 ripple 全在已 async 的调用点

**Phase 94 — 逐信号校准：每个预交易告警真的预测更差的成交吗？（per-signal calibration — does each advisory flag earn its keep, or fire as noise?）** ✅
- **让护栏诚实面对自己**：preflight 这些月累积了一堆 warn/critical 告警码（market_timing_caution / concentration_high / drawdown_approaching / mev_exposed…），每个都让 agent 更谨慎。但**从没人验证过它们到底准不准**——某个告警一响，随后的成交真的更差了吗？还是它只是噪声、徒增"caution"verdict、教 agent 把真信号也一起忽略？v75 校准只看 verdict 层（go vs caution 整体），看不到单个信号
- 为什么是最重要的：信号可信度是整个 preflight 决策系统的根。一个常响却不预测任何坏处的告警，比没有更糟——它制造警报疲劳，稀释真正重要的告警。把"我们累积的每个建议信号"对着**实际成交结果**验证，是让 agent 的谨慎有的放矢、而非机械堆砌护栏。这正好收尾 detect→journal→correlate→**validate** 这条可观测性弧（v74 记录、v75 关联 verdict、v94 关联到逐信号）
- 实现（复用 v74 journal 的 reasons_json + v75 关联基建，纯函数）：`aggregateSignalOutcomes(matches)`——对每个告警码，算其携带交易的成交滑点中位数 vs **全体已成交基线**中位数；`vsBaselineBps = 信号中位数 − 基线`；`predictive`：filled≥3 且 vsBaseline≥+5bps → true（确实预测更差），<5bps → false（不分离，疑似噪声），样本不足 → null。按 vsBaselineBps 降序排（最该信任的在前）。`parseSignalCodes` 从 reasons_json 抽 warn/critical 码；`PreflightLite.codes` 承载
- CLI `trade preflight calibration` 新增"Per-signal（这个告警预测更差成交吗？）"块：逐码显示 filled 数、±bps vs 基线、✓ predictive / ✗ not separating (noise?) / — too few；MCP `preflight_calibration` 工具返回新增 `bySignal[]`（agent 可自省哪些信号值得信、哪些该剪枝）
- 测试覆盖：`preflightCalibration.test.ts` +4——信号滑点>基线→predictive / ≈基线→not separating / 样本不足→null / 忽略未匹配 run + 按预测力降序排；3493 测试全绿（+4）
- 向后兼容：纯加法——新纯函数、CLI 多一个渲染块（空 journal 时不显示）、MCP 响应多一字段；不改既有 verdict 校准逻辑

**Phase 93 — 一键加固（safety harden — make the safe path the easy path）** ✅
- **让"安全"成为容易的默认，而非加新护栏**：整套护栏（断路器/集中度/转账白名单/无限授权块/USD 限额…）全是 opt-in——粗心的运营商会让 agent 全敞口跑。`safety review` 检测缺口+给逐条修复命令，但运营商得跑 ~8 条、还得自己定值。本期一步补齐：结构性护栏给安全默认值、scale-specific 的 USD 限额从 flag 取（或标为待补）
- 为什么是最重要的：托管真钱给自主 agent，最大的真实风险或许是**运营商根本没开护栏**。我建了所有护栏（v70-v92），现在让它们一键打开。降低运营商失误=直接服务"安全自主交易"这一最重要的东西。这是整个安全弧的收尾（detect→action：review 检测，harden 行动）
- 实现（纯计划 + 仅补缺口 + CLI-only apply）：纯函数 `buildHardeningPlan(config, {perTradeUsd, dailyUsd, maxStrategyLossUsd})` → { changes（带安全默认+理由）, stillNeeded（缺 scale-specific 值的护栏，不瞎猜）, alreadyHardened（已配的不动） }。结构默认：drawdown breaker 20%、concentration 50%、transferAllowlistOnly、allowInfiniteApprovals=false。**只补缺口**——绝不覆盖运营商已设的值
- CLI `safety harden [--per-trade-usd --daily-usd --max-strategy-loss-usd --apply]`：默认 dry-run（显示计划+待补+已配），--apply 写入。**CLI-only**（写 safety.* 配置，运营商所有——与 v89 锁一致，agent 不能 harden）
- 测试覆盖：`safetyHarden.test.ts` 6——fresh 配置得结构默认 / USD 限额无 flag→stillNeeded、有 flag→changes / **只补缺口**（已配的 drawdown/concentration/allowlist/perTx 不动、入 alreadyHardened）/ 无限授权开着→建议关 / 已加固配置→零 changes / **推荐配置 schema-valid**（每个默认值 setConfigPath 后 configSchema.parse 不抛——防坏默认）；CLI 烟雾（dry-run 显示 4 changes+2 stillNeeded+1 already / --apply 写入、verify transferAllowlistOnly=true）
- 向后兼容：纯加法——新模块、新 CLI 子命令；dry-run 默认（--apply 才写）；只补缺口（零覆盖）；3489 测试全绿（+6）
- v1 限制：opt-in 默认值是有主张的（20%/50% 等——但只在缺口处建议，运营商 dry-run 审阅）；USD 限额 scale-specific 需 flag（不从组合估值自动推导——保持确定性无 RPC）；CLI-only（无 MCP harden——agent 经 safety review gaps 已能建议）

**Phase 92 — 堵住 approve 侧门（close the approve drain side-door — make the v91 fund-movement lock actually sound）** ✅
- **修复 v91 的旁路，使其真正生效（而非新主题）**：v91 锁住 transfer 到任意地址。但有个**旁路**：`approve(恶意 spender, max)` → 该合约用 transferFrom 直接抽走代币，完全绕过转账白名单。运营商开了 transferAllowlistOnly 以为"资金移动锁住了"，但 approve 仍开着（contractWhitelist 默认空=放行任意 spender）。前门锁了、侧门敞着——v91 的保护是虚的
- 为什么是 v91 的一部分而非新功能：半关的门比明知敞着更糟。要让 v91 真正成立，approve 必须用同一开关一起关。这是让 v91 实际生效，不是第 N 个安全功能
- 实现（同一开关 + 复用既有分类器）：`transferAllowlistOnly` 开启时，MCP `approve` 到**未知 spender**（非 iter681 `classifySpender` 判定的 curated router / contractWhitelist / address-book）→ 抛 `APPROVE_SPENDER_NOT_ALLOWED`。纯 gate `assertApproveSpenderAllowed`（镜像 v91 的 assertTransferAllowed）。revoke 不受限（移除敞口永远安全）。一个开关现在覆盖 transfer + approve = "agent 资金移动限于可信目的地/spender"
- 边界一致：CLI（运营商）不受限——批准任意 spender、CLI 策展白名单；MCP 受限。默认 off（transferAllowlistOnly 本就默认 off）→零行为变化
- 测试覆盖：`approvals.test.ts` +3（assertApproveSpenderAllowed 纯函数：未知 spender+on→抛带地址 / 已知→放行 / off→放行）；approve 工具描述 + safety review detail 更新（白名单现含 approve-spender）；新 ErrorCode `APPROVE_SPENDER_NOT_ALLOWED`（403）
- 向后兼容：纯加法——复用 v91 的 transferAllowlistOnly 开关（无新 config）；默认 off 零行为变化；3483 测试全绿（+3）
- 注入防御弧完整：config 改写（v89/v90）+ transfer 到任意地址（v91）+ approve 恶意 spender（v92）——agent 侧的盗窃/破坏面全封（外加既有 backup/panic/approve-own-trade 的 CLI-only 边界）
- v1 限制：approve gate 端到端 RPC-bound 未单测（纯 assert 已测，与 v91 同纪律）；与 v91 共用一个 opt-in 开关（语义自然扩展）；revoke 永远放行（降敞口）

**Phase 91 — 转账收款人白名单（transfer recipient allowlist — block agent fund-exfiltration to arbitrary addresses）** ✅
- **堵住最直接的盗窃向量**：v89/v90 锁了配置改写，但**最直接的盗窃**——`transfer` 把资金转出到任意地址——此前在 MCP 上无收款人限制、无审批门（交易安全栈管 swap 的滑点/限额，但 transfer 是把钱整个转走到任意收款人，不可逆，目的地不受任何护栏约束）。被注入的 agent 一次 `transfer @max 0xattacker` 即可清空钱包。地址簿此前只是**信息性**的（recipientIsKnown 标记），不拦截
- 为什么是最重要的：自主 agent 托管真钱，最坏情况是资金被转给攻击者（不可逆，比坏成交严重得多）。审批门（v47）只覆盖 buy/sell，transfer 漏掉了。这是 backup/panic/config-lock 同一信任边界的最后一块、也是危害最大的一块
- 实现（opt-in 收款人白名单 + 防自我授权）：新 config `safety.transferAllowlistOnly`（默认 false，在 safety.* 下→受 v89 锁、仅 CLI 可改）。开启时：(1) 纯 gate `assertTransferAllowed({allowlistOnly, recipientKnown, recipient})`——MCP transfer 收款人不在地址簿→抛 `TRANSFER_RECIPIENT_NOT_ALLOWED`（含 simulate，防 dry-run 探测）；(2) MCP `address` 工具的 add/remove→抛 `ADDRESS_BOOK_LOCKED`（地址簿成了信任锚，agent 不能自我授权攻击者）。地址簿=运营商经 CLI 策展的可信收款人白名单
- 边界一致：CLI（运营商）不受限——operator 转任意地址、CLI 策展白名单；MCP 受限；读（address list）+ recipientIsKnown 标记保持开放。默认 off→零行为变化，运营商显式 opt in
- 测试覆盖：`addressBook.test.ts` +3（assertTransferAllowed 纯函数：未知收款人+on→抛带地址 / 已知→放行 / off→放行）+ `admin-tools.test.ts` +2（address add/remove：off→放行、on→ADDRESS_BOOK_LOCKED + list 读放行）+ `safetyReview.test.ts` +2（未配→info gap "transfer to ANY address"、配了→active）；CLI 烟雾验证 safety review 两态；2 新 ErrorCode（403）
- 向后兼容：纯加法+opt-in——默认 off 零行为变化；config literal fixture 补 transferAllowlistOnly；3480 测试全绿（+7）
- v1 限制：opt-in（默认 off——不强加于未启用白名单的运营商）；按地址簿白名单（非审批队列——transfer 接入 approve-execute 较重，留作后续；白名单+CLI 已是强边界）；MCP-only gate（CLI/operator 不受限，正确职责分离）

**Phase 90 — 运营商所有的配置边界（operator-owned config boundary — extend the MCP write-lock to RPC / relay / alert config）** ✅
- **补完 v89 的注入防御边界，而非加 feature**：v89 锁住 safety.* 防 agent 削弱护栏。但注入威胁模型更广——agent 还能经 MCP `config set` 改写**基础设施**配置发起攻击：`chains.*.rpcs`（注入恶意 RPC → 假价格喂坏滑点检查/坏成交，或前跑签名 tx）、`mev.*`（把签名 tx 重定向到恶意 relay → 偷币）、`webhooks`/`notifications`（重定向/静音告警 → 蒙蔽运营商藏匿盗取）。这些直接使能盗窃或藏匿，是 v89 同一边界的剩余缺口
- 为什么是最重要的：自主（尤其被注入）agent 托管真钱，安全根基是它**不能重配自己的保护/基础设施/可见性**。v89 锁了护栏，本期锁住资金流（RPC/relay）和可见性（告警）——注入 agent 的配置改写攻击面被完整封住
- 实现（提取为可测策略 + 扩展）：把 v89 内联检查重构为 config.ts 的 `agentLockedConfigSection(path)`——运营商所有段列表（safety/chains/mev/webhooks/notifications）+ 每段理由（用于错误信息）。MCP `config` 写操作（set/push/drop）命中任一段 → 抛 `SAFETY_CONFIG_LOCKED`。`aggregator.*`（aggregator_tune 合法调路由，非盗窃向量）+ 操作键（activeChain/activeAccount/defaultSlippageBps）保持开放
- 边界不变：CLI 不受限（运营商有 shell、负责基础设施/风险策略）；读 + config_preflight dry-run 开放（agent 仍能分析+建议）；前缀匹配非子串（safetyNet/chainsExtra 不误锁）
- 测试覆盖：`config.test.ts` +4（纯策略：每个运营商所有段锁定（精确+嵌套）/ 操作+aggregator 开放 / 前缀非子串 / 错误理由文案）+ `admin-tools.test.ts` +8（真 MCP handler：set chains/chains.base.rpcs/mev/mev.privateRpcs/webhooks/notifications→SAFETY_CONFIG_LOCKED / push chains.rpcs 恶意 RPC→锁 / aggregator.mode→放行）；v89 的 safety 测试仍全过
- 向后兼容：纯加法+收紧——锁面从 safety.* 扩到 5 段（全是运营商 setup 配置，无合法 agent 写流程）；CLI 不变；3473 测试全绿（+12）
- v1 限制：锁段是固定列表（新增敏感段需更新策略——回归测试钉住覆盖）；硬块无 opt-out（安全默认）；SAFETY_CONFIG_LOCKED 错误码名沿用 v89（现覆盖>safety，但语义"安全/安保配置锁"成立，避免改名 churn）

**Phase 89 — 护栏自保护（safety config is operator-owned — an agent can't weaken its OWN guardrails over MCP）** ✅
- **堵住一个真实的安全完整性漏洞，而非加 feature**：整套安全栈保护**交易**，但**护栏配置本身**此前可被 agent 经 MCP `config set` 改写。攻击路径：被提示注入的 agent → `config set safety.maxSlippageBps 5000` / 关掉 drawdown breaker / 从黑名单 drop 一个币 / **关掉人工审批门 safety.tradeApproval** → 然后在松掉的护栏内自由交易。护栏只和 agent 的自律一样强——等于没有
- 为什么是最重要的：自主 agent（尤其被注入的）托管真钱，安全的根基是护栏**不可被被保护方自己削弱**。产品已有 backup/panic/审批 CLI-only 边界防注入 agent 导出密钥/拉总闸——但**护栏配置**这个最该保护的东西却敞着。这是和那些同类的信任边界，补上最后一块
- 实现（镜像 backup/panic 的 CLI-only 边界）：MCP `config` 工具的写操作（set/push/drop）若目标 `safety` 或 `safety.*` → 抛 `SAFETY_CONFIG_LOCKED`。覆盖所有护栏（limits/breakers/白黑名单/concentration/strategy-loss）**以及人工审批门**（safety.tradeApproval 就在 safety.* 下）。读（show/get）+ `config_preflight`（dry-run 分析）保持开放——agent 仍能**分析**并向运营商**建议**改动，只是不能**应用**
- 关键边界：**CLI 路径不变**（运营商有 shell、负责设护栏）——块只在 MCP handler。运营商设护栏、agent 在内操作，正确的职责分离（同 backup/panic）
- 测试覆盖：新 `admin-tools.test.ts` 9（真 MCP config handler）——set safety/safety.maxSlippageBps/drawdown.enabled/tradeApproval.enabled 全→SAFETY_CONFIG_LOCKED / push 白名单→锁 / drop 黑名单→锁 / 读 safety（get+show）放行 / 写非-safety 路径（defaultSlippageBps）放行 / 前缀匹配非子串（activeChain 不误锁）；CLI 烟雾验证 `config set safety.maxSlippageBps 300` 仍成功（人工路径开）；SAFETY_CONFIG_LOCKED 入 ErrorCode（403）
- 向后兼容：纯加法——MCP 写 safety.* 此前"能但危险"，现在拒（行为收紧但是安全修复，非破坏既有合法流程——无合法 agent 流程会改 safety 配置）；3461 测试全绿（+9）
- v1 限制：仅锁 `safety.*`（含审批门——最高危面）；mev/webhooks 等次级护栏未锁（v1 聚焦核心，可后续扩）；硬块无 opt-out（安全默认——要 agent 管护栏是 footgun）

**Phase 88 — 策略业绩进 digest（strategy performance in the cron digest — surface bleeders PROACTIVELY）** ✅
- **把有效性信号变主动，而非又一个 pull 面**：v83 比较、v84 熔断**检测/拦截**流血策略，但运营商得记得去查。digest 是 cron 主动简报通道——本期把策略业绩 roll-up 进 digest，运营商定时收到"策略 X 在流血"，不必 poll
- 为什么有价值：自主 agent 跑数周，运营商要的是**被告知**坏消息而非主动找。digest 是那个通道。一个机械上"正常"（每笔成交）却在亏钱的策略，此前在 digest 里完全不可见——本期补上，且让它**贡献 digest verdict**（流血→attention）
- **干净契合 digest**：策略比较是**确定性**的（DB-only、stablecoin-$1、无 RPC），完美契合 digest 的无-RPC 性质（不像风险需链上读）。复用 v83 `gatherStrategyComparison`
- 实现：(1) `StrategyDigestSection`（count/totalRealizedUsd/best/worst/bleeding）+ `gatherStrategyPerf({since})`（窗口内确定性 roll-up，无策略则 null）；(2) 接入 gatherWindow + DigestReport（可选字段）；(3) **classifyVerdict** 加策略维度——bleeding>0 → attention + 具名理由（"N strategies bleeding (worst: X −$Y)"）；(4) CLI digest 渲染 STRATEGIES 段 + bleeding 警告行
- 测试覆盖：`digest.test.ts` +4——gatherDigest 策略段（winner +600/loser −300→best=winner、bleeding=[loser]、verdict attention、理由含 bleeding）/ 无策略交易→段为 null / classifyVerdict 流血→attention 具名 / 无流血→healthy 不误触发；CLI 离线烟雾（momentum +$700 / dca-eth −$250 → digest 🟡attention + STRATEGIES 段 + bleeding 行）
- 向后兼容：纯加法——digest 新可选 section、classifyVerdict 新可选参数（既有调用/测试不变）；3452 测试全绿（+4）
- v1 限制：策略段 realized-only（与 v83 一致——非稳定币计价排除）；只在当前窗口（prior-window 比较里 strategy 省略，与 posture 同）；按 since 窗口（recentTrades 无 until——窗口内已实现，足够简报）

**Phase 87 — 策略对比上 Web（strategy comparison on the dashboard — capital-allocation parity for the web operator）** ✅
- **继续收 Web 落后差，补有效性支柱的关键视图（增强既有页而非加 tab）**：v86 把风险上了 Web；本期把 v83 策略业绩排名上 Web。既有 Strategy tab 只是**单策略深挖**（下拉选一个看详情）——用 Web 的运营商无法一眼看到"哪些策略赚钱/流血"做资本配置。本期在既有 Strategy 页**顶部加排名对比表**，不新增 tab（避免 tab 膨胀）
- 为什么有价值：资本配置是多策略 agent 的核心有效性决策。Web 运营商此前只能逐个钻取，看不到横向排名。补上 = 仪表盘有了"加码谁、砍掉谁"的一眼视图
- **干净可测**：策略对比是**确定性**的（DB-only、stablecoin-$1 模型、无 RPC）——所以 Web API 完全可单测（不像 risk 需 RPC 降级）。`GET /api/strategy-compare?mode=` 在可测的 `registerAutomationRoutes` 里 → `gatherStrategyComparison`
- 实现：(1) 路由 `/api/strategy-compare`（mode/days 参数）；(2) api.ts `getStrategyCompare`/`StrategyCompareResp`；(3) **增强既有 Strategy.tsx**——顶部加排名表（#、策略、realized $ 红绿、win rate、closes、trades、volume、bleeding 徽章），**行可点**→设为选中策略钻取下方详情（对比表兼作选择器）；随页面 mode（real/paper）刷新
- 测试覆盖：`webAutomation.test.ts` +1（seed paper winner(+600)/loser(-300) → `/api/strategy-compare?mode=paper` 按 realized 降序排名 + bleeding 含 loser + totalRealizedUsd——确定性全验证，无 RPC 降级）；webui `tsc -b` + `vite build` 全过
- 向后兼容：纯加法——新路由、api.ts 新方法、Strategy 页新增对比区（既有深挖不变）；3448 测试全绿（+1）
- v1 限制：对比 realized-only（与 v83 一致——非稳定币计价交易排除，脚注明示）；Web mode auto→real 映射（对比需 real/paper，auto 取 real）；行点击设选中 tag（轻量钻取，非独立路由）

**Phase 86 — 风险态势上 Web（risk posture on the dashboard — bring the most important operator signal to the laggard interface）** ✅
- **补齐三大界面里落后最多的那个，针对最重要的信号**：CLI/MCP/Web 三大一等界面，Web 自 v68（safety 页）以来落后了 ~17 个能力（concentration/protection/risk posture/strategy compare/calibration…全没上 Web）。用 Web 看盘的运营商，对**最重要的信号——风险**完全盲。本期把 v78 统一风险裁决搬上仪表盘
- 为什么是最重要的：安全做满后，运营商信任的核心是"现在安不安全"。这个答案（risk posture）此前只在 CLI `risk`。用 Web 的运营商日常看不到。把它放进仪表盘 = 最重要的信号到达最该看的地方
- 实现（复用 v68 可测模式）：(1) `registerAutomationRoutes` 加 `GET /api/risk` → `gatherRiskPosture`（v78），**每维度 best-effort**——需链上读的维度（concentration/protection）失败降级进 skipped，离线测试环境下路由仍返回有效裁决（headroom+mev 计算、RPC 维度优雅缺省）；(2) React `Risk.tsx` 镜像 v68 `Safety.tsx`（只读、防御性）：verdict 徽章（ok/elevated/critical 配色）+ summary + 排序 concerns（critical/elevated × source 标签 + 文案）+ checked/skipped 脚注；(3) App.tsx tab + api.ts `getRisk`/`RiskResp`
- 为何 `registerAutomationRoutes`：那是**可单元测试**的注册器（webAutomation.test 真起 app.listen 打真 HTTP）。API 完全可验证，不依赖 React 渲染
- 测试覆盖：`webAutomation.test.ts` +1（`/api/risk` 返回 verdict ∈ 三态 + concerns/checked/skipped 数组 + summary——离线环境验证 best-effort 降级仍出有效裁决）；webui `tsc -b` + `vite build` 全过（React 编译 + 打包验证）
- 向后兼容：纯加法——新路由、新 React tab、api.ts 新 getRisk/RiskResp；既有界面不变；3447 测试全绿（+1）
- v1 限制：Web 风险页与 CLI `risk` 同源（gatherRiskPosture）——但 Web 无 wallet 上下文时 concentration/protection 维度可能降级（skipped 脚注明示，CLI 全量）；只读（无操作按钮——配置/止损变更仍走 CLI 高权路径）；React 渲染本身无单测（靠 tsc+build+镜像久经考验的 Safety.tsx 降风险）

**Phase 85 — 稳定币注册表合一（one stablecoin registry — the surfaces can no longer disagree on what a dollar is）** ✅
- **修复一个 LIVE 的跨面不一致，硬化最重要的数字（而非加 feature）**：稳定币计价的 quote 按 $1 估值，是所有 P&L/税务/分类面确定性定价的基石。但**七个文件各有一份 `isStablecoin`，且集合彼此不同**——pnl/tradeExport/aggregatorStats/pairStats/importTrade 认 BUSD/USDP/TUSD，paperPnl 认 USDBC/LUSD/GUSD/USDS。后果：**同一笔 LUSD 计价交易在 paper 账本按 $1 计、在真实 PnL 和税务导出里却被当非稳定币跳过**；BUSD 计价的反之。和成本基准漂移（v71/v82）同类的跨面不一致——但这个是**当前就存在的活 bug**，不是潜在风险
- 为什么是最重要的：安全做满后，"可信、一致的数字"是产品根基。同一笔交易在不同面给出不同 PnL/税务结果，是最坏的信任 bug（每个面单独看自洽，跨面对不上）。这是 v71/v82 成本基准合一的同类收尾——这次是 quote 定价
- 实现（提取为唯一定义 + 取并集）：新 `stablecoins.ts` 是唯一的 `isStablecoin` + `STABLECOIN_SYMBOLS`——**七份旧集合的并集**（全是货真价实的 USD 稳定币：USDC/USDC.E/USDT/DAI/BUSD/FRAX/USDP/TUSD/USDBC/LUSD/GUSD/USDS），所以没有任何面丢失覆盖。七个文件（pnl/paperPnl/tradeExport/aggregatorStats/pairStats/strategyCompare/importTrade）全部删本地拷贝、改 import 共享定义
- 现状：稳定币识别从**七份分歧拷贝**收敛到**一处定义**——按构造不可能再分歧。importTrade 的"哪边是稳定币 quote"分类也共享同一集合，与 PnL 面一致
- 测试覆盖：新 `stablecoins.test.ts` 6——核心稳定币识别 / **并集里每个曾被部分面识别的符号现在全识别**（BUSD/USDP/TUSD/USDBC/LUSD/GUSD/USDS/USDC.E——明确钉住修复的分歧）/ 大小写不敏感（USDC.e）/ 拒绝非稳定币+空值 / 集合 ≥12 防意外缩水 / **回归守卫**：扫描 src，断言除 stablecoins.ts 外无文件再定义 isStablecoin/STABLE_SYMBOLS（防 copy-paste 重新引入分歧）；既有 8 个相关套件 261 case 全部不变通过（USDC 在所有旧集合里→行为对已测用例不变）
- 向后兼容：纯提取——零行为变化（已测用例全过）；修复未测稳定币（LUSD/BUSD 等）的跨面分歧；3446 测试全绿（+6，无回归）
- 影响面：稳定币识别现源自一处——pnl、gains、tradeExport（税务）、paperPnl（纸面）、aggregatorStats、pairStats、strategyCompare、importTrade（分类）全部同源

**Phase 84 — 策略止损熔断（per-strategy realized-loss circuit breaker — stop a strategy that bleeds while mechanically "succeeding"）** ✅
- **检测→行动：v83 找出流血策略，本期自动止血**：v83 按 realized P&L 排名、标出 bleeders，但**没有任何东西阻止**流血策略继续交易。既有熔断只管**操作性失败**（tx revert）和**组合回撤**（mark-to-market）——但一个策略可以**每笔都成功成交、却在已平仓交易上持续亏钱**，无人拦截。这是最阴险的资本流失：机械上"工作正常"，账上却在失血
- 为什么是最重要的：安全=不亏钱。一个"成功"但亏钱的策略是真实且无声的资本流失，此前**无任何护栏**。这是安全×有效性的交集——自主 agent 最该有的"别再挖坑"保护，也是 v83 的自然闭环（检测 bleeder → 自动止血）
- 实现（镜像 strategyBudget 全链路）：config `safety.maxStrategyLossUsd`（可选）；纯 enforcer `enforceStrategyLossBreaker({ strategyTag, maxLossUsd, realizedLookup })`——策略 realized P&L ≤ −限额时抛 `STRATEGY_LOSS_BREAKER_TRIPPED`。**买入挡、卖出放**（让策略平仓/恢复），tagged-only + opt-in（默认零成本）。realized 用 v83 确定性比较（stablecoin-$1，无 marks/RPC）
- 全链路一致（与 strategyBudget 同构）：(1) trade.ts step 5a-quater 实盘强制；(2) `projectTradeLimits` 加 `strategy_loss` check（复用同一 enforcer via runCheck）→ **preflight 提前显示**，无"preview GO 却执行 TRIPPED"惊吓（v54 原则）；(3) `safety review` 加 exposure 类护栏 + gap；(4) `STRATEGY_LOSS_BREAKER_TRIPPED` 入 ErrorCode（403）+ httpStatus
- 语义：买入挡（止血）、卖出永远放行（降敞口/恢复）——与 position cap 同款方向语义。区别于 strategyBudget（管毛花费，赢亏都算）和 drawdown breaker（组合 mark-to-market）：本期管**单策略已实现亏损**
- 测试覆盖：`strategyCompare.test.ts` +5（超限抛 STRATEGY_LOSS_BREAKER_TRIPPED 带金额 / 恰好 ≤−max 触发 / 限内放行 / 盈利放行 / 未配+无 tag+0 限额均 no-op 且不调 lookup）+ `safetyReview.test.ts` +2（未配→off+gap / 配了→active 带 $ 明细）；CLI 离线烟雾（safety review 两态 + 真实亏损策略 −$700 被 $500 限额 BLOCKED）
- 向后兼容：纯加法——新 config（可选）、新 enforcer、新 limit check、新护栏、新 error code；buy-only+tagged+opt-in（默认零成本/零行为变化）；3440 测试全绿（+7）
- v1 限制：realized-only（用 v83 确定性比较——非稳定币计价交易不计入亏损，与比较口径一致）；全局限额（每个策略各自适用同一阈值，非 per-tag 规则——v1 简化）；每笔 tagged buy 走一次该策略 realized walk（仅 opt-in 用户付此成本，与 drawdown breaker 的 per-trade RPC 同量级）

**Phase 83 — 策略业绩对比（strategy comparison — rank strategies for capital allocation, the core effectiveness decision）** ✅
- **转向被冷落的「有效性」支柱（连续 ~11 期在「安全」）**：安全做到极致后，agent 的本职是**赚钱**。多策略 agent 的核心有效性决策是**资本配置**：哪些策略赚钱（加码）、哪些流血（砍掉）。产品有 strategy_report（单策略深挖）+ pnl 里埋着的 byStrategy（仅 realized+count）——但**没有排名的横向对比**，缺了配置决策最需要的指标：realized P&L、**胜率**（一致性——2 笔运气 +$100 和 50 笔稳定 +$100 是完全不同的赌注）、交易数、成交量
- 为什么时机正好：v82 刚把成本基准合一，**这些数字现在可信**。本期直接复用 canonical reducer（applyBuy/applySell）——按构造与所有 P&L 面同源、不可能漂移
- 实现（纯 + 确定性，复用 v71/v82 共享 reducer）：纯函数 `computeStrategyComparison(rows)`——按 strategy 分组，组内按 (chain,token) 经共享 reducer 走 weighted-avg，累计 realized + 胜/负（卖出 realized 符号）+ volume + 成交数，按 realized 降序排名。**确定性**：用 stablecoin-$1 报价模型（同税务导出），无 marks、无 RPC——随时跑、同输入同结果。realized-only（已平仓的底线）；非稳定币计价的交易排除出 P&L（unpricedTrades，无法确定性定价）
- 指标：realized $、winRatePct（wins/(wins+losses)）、closes、tradeCount、volumeUsd、avgRealizedPerClose、lastTradeAt；汇总 best/worst/total + **bleeding[]**（负 realized→建议复查/砍掉）
- Surfaces：CLI `strategies compare [--paper --days N]`（排名表 + bleeding 警告）+ MCP `strategy_compare { mode, days }`。MCP_TOOLS 不变量加 `strategy_compare`。与 strategies_list（发现）、strategy_report（单策略深挖）互补
- 测试覆盖：`strategyCompare.test.ts` 8——按 realized 排名（赢家在前）/ 胜率从平仓算 / 非稳定币计价排除 / 未打标→(none) / 无平仓→胜率 null / 空→空报告 / 策略内按 (chain,token) 隔离持仓不串味 / 集成（临时 DB paper：排名+bleeding）；CLI 离线烟雾（momentum +$800 100% 胜率居首 / dca-eth −$150 标记 bleeding）
- 向后兼容：纯加法——新模块、新 CLI 子命令、新 MCP 工具；确定性只读（不碰执行/不加 RPC）；3433 测试全绿（+8）
- v1 限制：realized-only（未实现/gas 仍看 live `pnl`——确定性取舍）；非稳定币计价交易排除（无法确定性定 USD，已披露 unpricedTrades）；按 (chain,token) 组合级（与 P&L 面一致）

**Phase 82 — 成本基准合一收尾：真实 PnL + 税务导出（finish the cost-basis unification — the real-money & tax numbers join the shared reducer）** ✅
- **补 v71 的遗漏，硬化最重要的数字（真钱 PnL + 报税），而非加 feature**：v71 把成本基准合一到 `costBasis.ts`，宣称"数字不可能再分歧"——但只覆盖了 paper walker + netPosition。本期发现它**漏掉了两个最要命的真钱面**：`pnl.ts`（运营商看的**头条 PnL**）和 `tradeExport.ts`（运营商**用来报税**的已实现盈亏）各有一份**独立内联**的加权平均成本基准实现。同一算法第三、第四份拷贝——正是 v71 要消灭的漂移风险，却漏在影响最大的地方
- 为什么是最重要的：安全做到极致后，"信任的数字"是产品根基。头条 PnL 和**税务**数字来自与 paper/cap 不同的成本基准实现，可能彼此漂移——这是最坏的信任 bug（每个面单独看都自洽，报税数字却可能与 PnL 面不一致）。v71 的"不可能再分歧"承诺**实质不完整**
- 实现（提取，零行为变化）：`pnl.ts` 的内联 walk（买：amount/cost 累加；卖：avgCost/sold 归约）+ `tradeExport.ts` 的税务 walk，全部改为 reduce through v71 的 `applyBuy`/`applySell`。pnl 卖出用返回的 {avgCost, sold} 算 realizedForThisSale；tradeExport 用返回的 {sold, costRemoved} 算 cost_basis/proceeds/realized。两处 mutation 由 applySell 内部完成，移除手写归约
- 现状：成本基准实现从**四份独立拷贝**收敛到**一处定义**——`costBasis.ts` 被 paper walker（v71）、netPosition（v71）、**pnl.ts 真实 PnL（本期）**、**tradeExport.ts 税务导出（本期）** 全部共享。按构造不可能再分歧
- 测试覆盖：既有 pnl.test + tradeExport.test 137 case **全部不变通过**（证明零行为变化）；`costBasis.test.ts` +5 **跨实现一致性守卫**——同一组 fills 喂税务导出（enrichTradesForExport 汇总 realized_pnl_usd）和 MTM walker（汇总 realizedQuote），断言已实现盈亏一致（单笔盈利/两买加权/亏损/超卖/分数往返）。v71 的守卫只比净额+成本，本期加比 realized PnL
- 向后兼容：纯提取重构——零行为变化、零新 surface、零新 MCP 工具（is a hardening pass, not a feature pile-on）；3425 测试全绿（+5，无回归）
- 影响面：所有成本基准/已实现盈亏数字现在源自一处——pnl、gains、open_positions、position cap、sizing、**头条 PnL、税务 CSV** 数学上保证同源

**Phase 81 — 风险态势进主仪表盘（risk posture in the health dashboard — make the v78 verdict visible where the operator looks）** ✅
- **让最重要的信号到达运营商，而非加新检测器**：v78 把运行时风险合成为单一裁决，但只在 `risk` 命令里——运营商跑自主 agent 时**永不会被告知** book 转危，得记得去 poll。本期把统一风险裁决折进 `health`（运营商日常看的主仪表盘），可见性即价值
- 为什么是最重要的：安全检测做透了，但**检测到没人看见 = 没检测**。health 是 agent/运营商的"晨报"，是评估信任的地方。把"Risk: ELEVATED — WETH 占 80%"放进去，运营商一眼看到，不必记得跑 `risk`
- **关键：零额外抓取**——`composeHealthReport` 是纯合成器，已收到 portfolio（带 v72 concentrationRisk）+ headroom（v53）；MEV 是纯配置（v77）。所以 health 用**已有数据**经纯函数 `combineRiskPosture` 算出风险裁决，不多拉一次链。protection（v76 需持仓）是 health 不抓的唯一维度→放进 `notChecked`，标准 `risk` 命令补全
- 实现：health.ts 加 `HealthRiskSection`（verdict/criticalCount/elevatedCount/topConcern/concernCodes/notChecked）；composeHealthReport 从 concentration+headroom+MEV 合成（纯）；**不重复 action**——headroom 维度已由既有 limit_near_exhaustion 驱动，故只为 health 此前**缺失**的维度加 action：`concentration_high`（high，单 token 过度集中）+ `mev_exposed`（medium，建议）。CLI health 渲染 Risk 行（🟢/🟡/🔴 + topConcern）
- Surfaces：CLI `health`（SAFETY 区加 Risk 行）+ MCP `health`（返回 `risk` 段 + 新 next-action codes）。无新 MCP 工具（折进既有 health）——纯合成不piling
- 测试覆盖：`health.test.ts` +3——concentration warn→risk elevated + concentration_high action + protection 入 notChecked / ethereum 激活无 MEV 保护→mev_exposed concern+action / ok 集中度+base 链→risk ok 无 risk action；既有 78 case 不变
- 向后兼容：纯加法——health 新可选 `risk` 段、新 next-action codes；纯合成零额外抓取（不碰执行/不加 RPC）；3420 测试全绿（+3）
- v1 限制：health 的风险裁决省略 protection 维度（health 不抓持仓——`notChecked` 明示，`risk`/`risk_posture` 全量含之）；MEV 看 activeChain；与 SAFETY 区的 headroom 维度有意复用（一个是 binding 明细，一个是合成裁决）

**Phase 80 — 入场即保护（protect-on-entry — buy auto-attaches a trailing stop so a position is never born unprotected）** ✅
- **源头保护 > 事后修复**：v76 检测裸仓、v79 事后修复。本期更根本：**让 buy 在成交后自动挂保护性移动止损**——持仓诞生即受保护，自主 agent 永不积累无保护敞口。条件单早有 onFill 钩子（TP+SL bracket），但**即时 buy/sell 无任何 post-fill 钩子**——市价买入的 agent 无法在入场时自动保护
- 为什么是最重要的：安全 = 不亏钱。预防裸仓存在 > 事后扫描修复。"买入并保护"一步完成，agent 不会忘。完成保护三部曲：入场即保护（本期）→ 审计（v76）→ 事后修复（v79）
- 实现（caller 级，**不碰执行路径**）：纯/best-effort 辅助 `createEntryStop({ result, trailPct, config, account, chain })`——buy 成交后由**调用方**（MCP buy 工具 / CLI）在 executeTrade 返回 success 后调用，用 result.baseAmount（收到的 base 量）经**同一个** createOrderRow 建 trailing sell。只保护成功的 BUY（sell 降敞口→skip；失败→skip；无量→skip）。止损建单失败**不影响**已成功的交易（报告不抛）
- 关键：**零执行路径改动**——v79 的教训延续，在 executeTrade 之外组合，不动关键路径。幂等友好：MCP 路径仅在 **非 replayed** 的新成功上挂（replay 的止损在原始运行已建）
- Surfaces：MCP `buy { protectTrailPct }`（返回 `autoProtect` { created, orderId, trailPct, amount }）+ CLI `trade buy --protect [--protect-trail N]`（🛡 行）。sell 无此参数（降敞口无需保护）
- 测试覆盖：`protect.test.ts` +3——createEntryStop 成功 BUY 建 trailing 覆盖收到量 / SELL 跳过（降敞口）/ 失败交易跳过；既有 8 case 不变
- 向后兼容：纯加法——buy 新可选参数、新辅助；caller 级组合（executeTrade 不变）；3417 测试全绿（+3）
- v1 限制：仅 buy（sell 降敞口）；trail 默认 15%；保护收到的 base 量（既有持仓的保护仍靠 v79 protect / 单独）；MCP 仅非 replayed 新成功挂止损（避免重复）；止损用该链 USDC 作 quote（与买入 quote 一致）

**Phase 79 — 一键保护（protect action — turn the unprotected-position audit into a one-call FIX）** ✅
- **检测→行动：连续 9 期只读检测/合成后的第一个行动能力**：v72-v78 把风险讲透了，但全是只读。自主 agent 用 v76 发现"WBTC $64k 无下行退出"后，还得手动拼一个 order_create（side/token/amount/trail）。本期闭合回路：`protect` 审计 book，对每个无保护（或部分保护）持仓**自动建移动止损**，size 精确等于裸露量，跳过已保护的。对自主 agent，检测无 easy-fix 只有一半价值
- 为什么是最重要的：安全 = 不亏钱，但**检测到风险却不能修复**对自主 agent 几乎无用——它需要的是"看到裸仓 → 一句话保护它"。这是产品从"告诉你风险"转向"帮你修复"的能力转变，长检测期后正当其时
- 实现（纯选择 + 复用既有创建路径）：纯函数 `selectPositionsToProtect(report, {token?})`——从 v76 审计选出 unprotected/partial 持仓 + 要覆盖的量（partial 只补**裸露余量**，不重复已有止损；token 过滤）。`protectPositions` 做 IO：gatherPositionProtection（v76）→ 对每个目标用**同一个** `createOrderRow`（order_create 的校验路径：白名单/额度/滑点 + audit）建 trailing sell（base_amount=裸露量、trailPct 默认 15=崩盘保护要留空间非紧贴止损、quote=该链 USDC、无 expiry=长效、native→ETH）
- 安全 + 健壮：**跨调用幂等**（已保护持仓被跳过→不重复建单）；逐持仓失败（如 token 黑名单）进 failed[] **不中断批量**；`simulate` 出计划不建单（写操作前预览）；CLI 要求 --all 或 --token（拒绝瞎猜范围）；走既有创建路径=零新信任面
- Surfaces：CLI `protect (--all | --token) [--trail --simulate --paper]` + MCP `protect_positions { all|token, trailPct, simulate, mode }`。MCP_TOOLS 不变量加 `protect_positions`。与 v76 配对：position_protection（detect）→ protect_positions（fix）
- 测试覆盖：`protect.test.ts` 8——纯 selectPositionsToProtect 4（选 unprotected 全额 / 跳过 protected / partial 只补余量 / token 过滤 symbol+addr）+ 集成 4（临时 DB + paper 持仓：建 trailing sell 覆盖全额 trail 正确 / 二次运行幂等不重复 / simulate 出计划不建单 / 无持仓 nothing-to-do）；CLI 离线烟雾（无范围→错误 / simulate 计划 / 真实建单 #1）
- 向后兼容：纯加法——新模块、新 CLI 命令、新 MCP 工具；建单走既有校验路径；3414 测试全绿（+8）
- v1 限制：固定额覆盖裸露量（快照——持仓后续增长需重跑 protect；用 fixed 而非 "max" 避免与已有止损在 partial 上重复计数）；quote 默认该链 USDC（标准报价）；trail 默认 15% 可调；保护=移动止损（trailing），价跌触发卖出

**Phase 78 — 统一风险态势（unified risk posture — one "is my book in danger RIGHT NOW?" verdict, synthesis not piling）** ✅
- **合成而非再加检测面**：v53/v72/v76/v77 各加了一个运行时风险信号——敞口余量、组合集中度、裸仓价值、MEV 暴露——但分散在不同命令里。运营商（或 agent 自己）**没有一个地方**说"你的风险是 critical/elevated/ok"并排序原因。连续多期加检测器后，最该做的是**把它们合成一个答案**，而非再加第 N 个检测器
- 为什么是最重要的：自主 agent 托管真钱，运营商最需要的是"现在安不安全"的**单一可分支信号**——监控 cron 可以在 `risk=critical` 时告警/page，agent 可以在自己的 book 转危时**自动停手**。此前要轮询 headroom + concentration + protection + mev 四个命令各自判断；现在一次调用得到一个裁决
- 实现（纯合成，零新分析）：纯函数 `combineRiskPosture({ headroom, concentration, protection, mev })` → { verdict (ok/elevated/critical), concerns[]（worst-first，{severity, code, message, source}）, checked[], skipped[], summary }。映射：任一限额 tripped/exhausted（不能交易的状态，含 drawdown 熔断）→ critical；集中度 warn / 裸仓 >50% book / 限额 approaching / MEV exposed → elevated（warn）；否则 ok。每个组件来自**既有 gatherer**（headroom v53 / portfolio.concentrationRisk v72 / positionProtection v76 / assessMevExposure v77）
- `gatherRiskPosture` 做 IO：headroom（DB 便宜）+ concentration（aggregatePortfolio，链上）+ protection（open positions + orders）+ mev（纯配置）。**每个 best-effort**——某组件 RPC 失败降级进 `skipped[]`（不伪造、不拖垮整体裁决）
- 与 health 区分：health 是宽的运维仪表盘（portfolio+pnl+trades+approvals）；risk 是**聚焦的危险裁决**——单一可分支 verdict，给监控/halt 用
- Surfaces：CLI `risk [--strict --strict-elevated]`（verdict 徽章 + 排序 concerns + checked/skipped；--strict 在 critical 退 1 供 cron page 门，--strict-elevated 在 elevated 也退 1）+ MCP `risk_posture`。MCP_TOOLS 不变量加 `risk_posture`
- 测试覆盖：`riskPosture.test.ts` 9——无问题→ok / tripped→critical / exhausted→critical / approaching+集中度+mev→elevated 三 concern / 裸仓 >50%→elevated 带 60% 文案 / 裸仓低于阈值→无 concern / critical 排在 warn 前（不论输入序）/ 记录 checked 维度 / 全空→ok 诚实 summary；CLI 离线烟雾（fresh→🟢OK 4 维 / ethereum 激活→🟡ELEVATED mev concern / --strict 对 elevated 退 0）
- 向后兼容：纯加法——新模块、新 CLI 命令、新 MCP 工具；纯合成只读（不碰执行）；3406 测试全绿（+9）
- v1 限制：concentration 用链上 holdings、protection 用 trade-derived 持仓（两个口径，已注释）；裸仓"critical"未设（保留 critical 给 tripped/exhausted 这类不能交易状态，裸仓是 posture 选择→elevated）；重维度需链上读，失败降级 skipped

**Phase 77 — MEV 暴露进决策点（MEV/sandwich exposure surfaced at the pre-trade decision — stop the silent 0.5-3%/trade leak）** ✅
- **换轴：执行路径的钱漏，而非又一个仓位/组合检测面**：连续多期在仓位/组合风险检测。本期转向一个真实且持续的**钱漏**：MEV/三明治攻击。在公共内存池链（尤其 Ethereum 主网）上，裸提交的交易会被 MEV bot 夹击套利，典型损失每笔 0.5-3%、illiquid 对更高。tradekit **早有** MEV 保护（mev.ts 私有中继传输 Flashbots/MEV Blocker），但保护状态**只在 safety review 的滑点脚注里提了一句**，**preflight/preview 完全不提**——agent 在主网无保护下单时拿到的是"GO"，毫无即将漏给夹击 bot 的提示
- 为什么是最重要的：安全 = 不因可预防的错误亏钱。MEV 是**每笔交易**的隐形复利损失。over-concentration/over-sizing/裸仓是组合级爆仓源；MEV 是**执行级**的持续失血。把它放进 agent 的下单决策点（preflight 裁决），让坏的执行路径在下单前就被看见
- **关键优势：纯函数、零成本**：MEV 暴露评估是**纯配置逻辑**（链 + config，无 RPC）——不像 concentration/portfolio 需要拉链上数据。所以放进 preview/preflight 是**免费的**，比 v69 timing（需拉序列）更轻
- 实现：(1) 纯函数 `assessMevExposure(chain, mevConfig)` → { protected, sandwichRisk (high/medium/low), exposed, advisory }，复用既有 `resolveMevSubmit`（保护是否激活）+ 文档化的每链三明治风险（ethereum=high、bnb/polygon=medium、base/arbitrum/optimism 单 sequencer=low、未知=low 不过度告警）；exposed = 高/中风险链 且 无保护；(2) `tradePreview` 加 `mevExposure` 字段（纯、免费）；(3) preflight combiner 加 `mev_exposed` reason（warn→caution；建议非阻断——是成本非安全违规，部分运营商接受）；(4) `safetyReview` 加 MEV 保护一等护栏（配了私有中继→active；没配→info gap "Ethereum 等公共内存池链可被夹击 0.5-3%/笔"）
- Surfaces：CLI `trade preflight`（reason 自动渲染）+ `trade preview`（🛡protected/🟡EXPOSED + advisory 行）+ `safety review`（护栏 + gap）+ MCP `preview_trade`（返回 mevExposure）/`preflight_trade`（mev_exposed code）描述更新
- 测试覆盖：`mev.test.ts` +6（主网无保护→exposed high / 主网有中继→protected 不 exposed / bnb-polygon medium→exposed / 单-sequencer L2 low→不 exposed / 未知链默认 low 不过度告警 / 同链保护清除暴露）+ `preflight.test.ts` +3（exposed→caution+mev_exposed / protected→go 无 reason / 缺省→无 reason）+ `safetyReview.test.ts` +1（未配→off+info gap "sandwich"）
- 向后兼容：纯加法——新纯函数、preview 新字段、新 reason code、新护栏；全部只读纯逻辑（不碰执行/写路径）；3397 测试全绿（+10）
- v1 限制：链风险是文档化静态分级（L2 sequencer 现状=low，未来若开放内存池需调）；mev_exposed 是建议非阻断（成本非安全违规）；保护"激活"= 配了该链私有中继（不验证中继实际可达——doctor 的 probeMevRpc 管那个）

**Phase 76 — 持仓保护审计（position protection audit — which holdings have NO downside exit, and how much is at risk?）** ✅
- **补一个真实的风控能力缺口，换个支柱发力（连续 3 期在 preflight，刻意离开）**：自主 agent 不断累积现货持仓。一个**没有保护性退出**（移动止损 / 止损单）的持仓在暴跌中完全裸露——单个无保护的大仓就能击穿整个 book。tradekit 早已分别追踪**开仓持仓**（v65）和**条件单**（trailing / price_below / price_above），但**没有任何地方交叉引用二者**：agent 可以持 $5k 某币、零自动下行退出，而无任何 surface 指出
- 为什么是最重要的：安全 = 不因可预防的错误亏钱。preflight 把关**入场**，但**已持有的仓位**的下行保护此前是盲区。over-concentration（v72）、over-sizing（v70）之后，"裸奔持仓"是第三类爆仓源——且最隐蔽（仓位一旦建立就脱离了 pre-trade 把关）
- 实现（纯 join + 注入 IO）：纯函数 `computeProtection(positions, orders)`——对每个持仓，找同 (chain, token) 的 active SELL 单中**下行保护型**（trailing 移动止损 / price_below 止损），按 base_amount 累加覆盖量（动态 sentinel 解析："max"→全仓、"N%"→该比例、定额→其值，封顶持仓量），算出 unprotected 余量 + 价值敞口。**take-profit（price_above sell）单独计数**——那是**上行**退出，非暴跌保护。status: protected/partial/unprotected
- `gatherPositionProtection` 做 IO：gatherOpenPositions（v65 walker，live marks）× listOrders(active, sell) → computeProtection。按敞口降序（最危险在前）
- Surfaces：CLI `positions --protection [--strict]`（per-position 表：held/protected/unprotected/at-risk$/stops + 🟢protected/🟡partial/🔴UNPROTECTED 徽章；--strict 在任一未保护时退 1，供 cron 风控门）+ MCP `position_protection`。MCP_TOOLS 不变量加 `position_protection`
- 测试覆盖：`positionProtection.test.ts` 10——无单→unprotected 全额敞口 / "max" trailing→protected / price_below 止损→protected / 定额覆盖半仓→partial / "N%" sentinel 按比例 / **take-profit 不算保护**（单独计数）/ 跨 token-chain 不误配 / 超额覆盖封顶持仓 / 无价持仓→null 敞口仍分类 / 按敞口降序 + 汇总；CLI 离线烟雾（seed WETH+trailing→🟢、WBTC 无单→🔴 $64k 敞口，汇总「1 of 2」）
- 向后兼容：纯加法——新模块、`positions` 加 `--protection` 旗、新 MCP 工具；只读；3387 测试全绿（+10）
- v1 限制：下行保护 = trailing + price_below（price_above 是 TP，单独列）；动态单 "N%" 按持仓量近似（实际 % 按 fire 时 spendable，已注释）；覆盖按 base_amount 求和（未建模多单重叠的同一批，封顶持仓量足够保守）；按 (chain, token) 组合级（与 open_positions 一致）

**Phase 75 — preflight 校准（preflight calibration — close the decision→outcome loop: were the verdicts actually predictive?）** ✅
- **闭合 v74 的问责回路，而非加新面**：v74 让 agent 的**决策**可见（每次 go/caution/no_go），但只回答"决定了什么"。运营商更深的信任问题是"**判断对不对**"——preflight 裁决到底有没有预测力，还是噪音？本期把每次记录的裁决关联到其后发生的交易，按 verdict 报告实际结果（成交率、已实现滑点、失败数）
- 为什么是最重要的：托管真钱给自主 agent，安全（已封顶）+ 问责（v74 决策可见）之后，第一位是**判断质量的验证**。"go 单干净成交（20bps、0% 失败）、caution 单更差（70bps、50% 失败）→ 裁决有预测力"——这是判断 agent 是否真的擅长此事的直接证据，也是 calibration/learning 回路此前缺失的一环
- 实现（只读、不碰执行/写路径）：纯关联核心 `correlatePreflightToTrades(runs, trades, windowMs)`——每个 preflight run 贪心认领其后同 key（chain/account/pair/direction）窗口内最近的一笔交易，一单只被一个 run 认领；按 verdict 聚合 { runs, matched, filled, failed, pending, medianSlippageBps }。`summarizeCalibration` 给出"caution 比 go 滑点差 Xbps → 有预测力 / 滑点未被 verdict 区分 / 数据不足"的白话判读。`gatherPreflightCalibration` 做 DB 读 + 关联
- 关联方式诚实标注：决策与交易**无硬链接**，按邻近度（同 pair/dir、决策后窗口内最近一笔、一单一认领）启发式匹配——明确说明是**聚合读**而非逐单真相（偶发错配在聚合中互相抵消）。这避免了改 trade 写路径的风险，且对既有 agent 流程零行为要求
- Surfaces：CLI `trade preflight calibration [--days --window --strategy]`（per-verdict 表 + 白话判读 + 启发式说明）+ MCP `preflight_calibration`。MCP_TOOLS 不变量加 `preflight_calibration`
- 测试覆盖：`preflightCalibration.test.ts` 9——关联核心 6（匹配最近后续同 key 单 / 窗口外+决策前不匹配 / 跨 pair-dir-chain 不匹配 / 一单一认领两 run 不共享 / per-verdict fill+fail+中位滑点聚合 / verdict 排序 go→caution→no_go）+ summarize 3（caution 更差→predictive / 未区分→noted / 数据不足→优雅）；CLI 离线烟雾（seed go×2 干净 + caution×2 差/失败 → 渲染表 + "predictive" 判读）
- 向后兼容：纯加法——新模块、新 CLI 子命令、新 MCP 工具；只读（不改 trade/preflight 写路径）；3377 测试全绿（+9）
- v1 限制：启发式邻近关联（非硬链接——未来 trade.preflight_id 可精确闭环）；结果用执行质量（成交/滑点/失败），非持仓 P&L（后者需平仓、噪音大）；caution 样本通常小（守规 agent 少在 caution 后下单）→ 数据稀疏时 summarize 优雅降级

**Phase 74 — preflight 决策日志（preflight decision journal — make the agent's risk JUDGMENT visible, including the trades it refused）** ✅
- **补问责支柱的最大缺口，而非又一个 pre-trade 面**：连续多期把 pre-trade 安全/决策做到极致（preflight 裁决含 timing/concentration/drawdown/sizing），但这些丰富分析**执行后全部蒸发**——trade 行只有自由文本 note。更关键：**caution/no_go 的 preflight 完全不留痕**。今天运营商只看得到"发生了的交易"，永远看不到"agent 明智避开的交易"。agent 可能在正确地拒绝坏单（恰是托管真钱最该有的风控判断力），而这份判断力**零记录**
- 为什么是最重要的：托管真钱给自主 agent，安全（已封顶）之后第一位是**问责**——运营商必须能审计 agent 的决策行为。"agent 跑了 50 次 preflight，10 次 no_go（正确拒绝）、15 caution、25 go"是 agent 风控纪律的直接证据，此前不存在。这是信任自主 agent 的核心依据
- 实现（安全：不碰执行路径）：(1) 新表 `preflight_runs`（v63 迁移）——append-only，存 verdict + reasons + pair + est_usd + critical/warn 计数；(2) `runPreflight` 单一咽喉处 best-effort 持久化每次运行（journal 写失败绝不破坏调用方等待的裁决；`skipJournal` 供内部 re-check 跳过）；(3) `insertPreflightRun`/`listPreflightRuns`（按 verdict/strategy/since/limit 过滤）/`preflightVerdictBreakdown`（go/caution/no_go 计数）
- 关键洞察：日志的价值不在"为什么这笔交易发生"，而在**"agent 的完整决策行为——含它没做的交易"**。no_go 是 agent 拒绝的坏单，是 invisible-today 的好判断。这是唯一暴露这份判断力的面
- Surfaces：CLI `trade preflight history [--days --verdict --strategy --limit]`（verdict breakdown「X% flagged caution/no-go」+ 逐条 time/dir/pair/verdict/est$/top-finding）+ MCP `preflight_history`（breakdown + runs，含解析后的 reasons[]）。MCP_TOOLS 不变量加 `preflight_history`
- 测试覆盖：`preflightJournal.test.ts` 6——round-trip newest-first + reasons 解析 / 按 verdict 过滤（专门暴露 refused 单）/ since+strategy+limit 过滤 / breakdown 计数 / breakdown 限定窗口+策略 / 空日志全零；CLI 离线烟雾验证（seed 2 条→渲染 breakdown「50% flagged」+ 表格 + --verdict 过滤）
- 向后兼容：纯加法——新表/迁移、runPreflight 末尾 best-effort 持久化（不改裁决逻辑、不碰 trade 执行）、新 CLI 子命令、新 MCP 工具；3368 测试全绿（+6）
- v1 限制：journal 与 trade 行无硬链接（按 timestamp/pair 关联——足够审计，未来可加 trade.preflight_id 闭环 decision→outcome）；只记 preflight 运行（agent 不跑 preflight 直接下单则不入日志——鼓励 preflight 先行）；append-only 无自动清理（与 audit_log 一致，量级低）

**Phase 73 — preflight 感知组合级闸门（portfolio-aware preflight — close the "preview says GO, execution TRIPS" gap for the portfolio gates）** ✅
- **补一个真实的"假 GO"风险，而非加新面**：v54 把 preflight 做成"下单前会不会被拒"的完整裁决，明确目标是"agent 不会拿到 GO 然后执行时吃 SAFEGUARD_TRIGGERED"。但 v54 的限额投影是 config/DB 级（便宜），**看不到需要组合估值的两个闸门**：drawdown 熔断器（硬 gate，执行时 throw DRAWDOWN_CIRCUIT_BREAKER_TRIPPED）和 v72 集中度。结果：agent preflight 得到 GO → 下单却被 drawdown 熔断器拦下。这正是 v54 要消灭的"假 GO"，偏偏漏在它唯一覆盖不到的闸门上
- 为什么是最重要的：preflight 是 agent 的下单决策点。一个不反映**所有**可能拒绝的闸门的裁决会误导 agent。把组合级闸门投影进 preflight = 裁决变得诚实完整。这是 v54 使命的自然补全，不是新功能
- 实现（投影而非执行，复用既有纯函数）：(1) 纯函数 `projectPortfolioGates(holdings, drawdownState, config, trade)` → { drawdown: {blocks, approaching, drawdownPct, thresholdPct}|null, concentration: ConcentrationRisk|null }——drawdown 走**只读** `evaluateDrawdown`（不 mutate，区别于执行时的 enforce），concentration 走 v72 `assessConcentrationRisk`，对**投影后**的 book 评估（买入：base +buyUsd、quote −buyUsd，总额守恒 → 百分比精确）；(2) `combinePreflightVerdict` 接 `portfolio` 输入：drawdown would-trip → critical(no_go)、approaching(≥80% 阈值) → warn(caution)、集中度超限 → warn(caution)；(3) `runPreflight` best-effort 拉一次 holdings（仅当 drawdown 或集中度任一已配）+ 读 drawdown 状态，投影后喂 combiner
- 闸门语义一致：drawdown 是硬 gate（执行时真 throw）→ preflight 给 no_go（对位真实拒绝）；集中度是 v72 风险旗（非硬 gate）→ caution（建议）。preflight PROJECTS（只读），trade ENFORCES（mutate）——与 preview 投影 limits、trade 执行 limits 的既有分工同构
- 诚实降级：holdings 拉取失败 → check_skipped reason（不崩、不阻断裁决）；未配任何闸门 → 自动跳过拉取（零成本）；`--skip-portfolio`/`skipPortfolio` 显式跳过（多链拉取较重）；卖出不投影集中度（不抬升占比）
- Surfaces：CLI `trade preflight` reasons 自动渲染组合闸门 + `--skip-portfolio`/`--strategy` 旗 + MCP `preflight_trade` 加 `skipPortfolio` 参数、返回 `portfolioGate`、描述更新新 code（drawdown_would_trip/approaching/ok、concentration_high/ok）
- 测试覆盖：`preflight.test.ts` +10——combiner 组合闸门 6（would-trip→no_go/approaching→caution/within-band→go/集中度超限→caution/would-trip 压过 OK 信号仍 no_go/拉取错误→check_skipped）+ `projectPortfolioGates` 纯函数 4（peak vs current 投影 drawdown trip / 买入推 base 过限→warn 点名 / 卖出不投影 / 未配→双 null）
- 向后兼容：纯加法——新 reason code、新 source "portfolio"、新可选 req 旗、新报告字段；combiner 新增 portfolio 参数可选；3362 测试全绿（+10）
- v1 限制：preflight 多一次多链 holdings 拉取（best-effort、可跳、仅闸门已配时）；drawdown 投影用当前估值（与执行时同源，但 preflight 与 execution 间组合若剧变需重跑——本就是 pre-trade 快照）；集中度投影按 swap 守恒总额近似（base+/quote−）

**Phase 72 — 组合集中度护栏（portfolio concentration guardrail — the cross-strategy blind spot per-strategy caps miss）** ✅
- **补一个真正缺失的安全护栏，而非又一个观测面**：集中度数学（top1/top3/top5）早已存在于 portfolio/health，但只是**观测指标**——没有任何护栏在组合危险地押注单一 token 时告警。仓位上限是 per-(strategy,token) 的**绝对额**，结构性地漏掉了**跨策略聚合**：多个策略可以各自守在自己的 cap 内，而整个 book 却漂移到 90% 压在一个高波动 token 上。这是自主 agent 的经典爆仓方式，此前无护栏
- 为什么是最重要的：安全 = 不因可预防的错误亏钱。over-concentration 是和 over-sizing（v70）并列的爆仓源。v70 防单笔过大，本期防组合过于集中。两者都把"安全态势"从被动观测变成主动护栏
- 实现（把已有的原始数字变成可执行的护栏裁决）：(1) 新 config `safety.maxConcentrationPct`（1-100，可选）——单一 token 占比超此则 flag；(2) 纯函数 `assessConcentrationRisk(tokens, threshold)` → { thresholdPct, verdict (ok/warn/unconfigured), largestPct/Symbol, breaches[] {symbol, pct, overByPct}, summary }——复用 portfolio 已算的 percentOfPortfolio，零额外计算；(3) portfolio report 加 `concentrationRisk` 字段（verdict=warn 时把顶层 severity 翻成 warn）；(4) `safety review` 加 exposure 类护栏条目（配了→active；没配→info gap，明示"跨策略盲区"）
- **review/portfolio 分工**与既有安全栈一致：`safety review` 只读 config（配没配——离线），`portfolio` 出实际裁决（需估值——它本就在估值）。不做硬性 pre-trade gate（集中度需组合估值，太贵）——是运营商/agent 看得到的风险旗，与 drawdown breaker 的定位一致
- Surfaces：CLI `portfolio` 渲染集中度裁决行（warn→⚠ 点名超标 token / ok→🟢 在限内）+ `safety review` 护栏与 gap + MCP `portfolio` 返回 concentrationRisk（描述更新）+ config 用法文档
- 测试覆盖：`portfolio.test.ts` +5（70/20/10 book 超 50% 限→warn 点名 WETH+overBy / 80% 限内→ok / 无阈值→unconfigured 仍报最大持仓 / 多个超标按权重降序 / 空 book 优雅降级）；`safetyReview.test.ts` +2（未配→info gap "cross-strategy blind spot" / 配了→active 无 gap）；既有 health/portfolioSnapshots fixture 补 concentrationRisk 字段
- 向后兼容：纯加法——新 config 字段可选（默认 unconfigured，行为不变）、portfolio report 新字段、新护栏；CLI 离线烟雾验证两态渲染正确；3352 测试全绿（+7）
- v1 限制：非硬性 pre-trade gate（观测+裁决，靠 agent/运营商响应）；集中度按 priced 持仓算（unpriced 不计入，与 top1/3/5 一致）；阈值是单 token 占比（非 HHI 等组合多样性指数——单 token 主导是最常见的具体风险）

**Phase 71 — 成本基准引擎合一（one shared cost-basis reducer — the numbers can no longer disagree）** ✅
- **不加 feature，消除最重要数字的结构性漂移风险**：产品最重要的东西是 agent 和运营商**信任的数字**。"strategy Y 持有多少 token X、成本基准多少"此前有**两套独立实现**的加权平均算法——MTM walker（`computePaperPnlMtm`，喂 pnl/gains/open_positions）和 `netPosition`（positionCaps，喂仓位上限 enforcer + v70 sizing）。两边各写一遍同样的算术，各自用注释承诺"与对方一致"
- 为什么这是最重要的：注释承诺是**结构性技术债**。任一边修个边界（over-sell 截断、成本下限、epsilon）而另一边没改，position cap enforcer 就会按 open_positions **从未显示过**的数字行事——**最坏的信任 bug**，因为每个面单独看都自洽。连续 6 期都在加决策面（context/timing/sizing），是时候回头加固它们共同依赖的地基
- 实现（提取而非重写）：新纯模块 `costBasis.ts` 是这套算术的**唯一定义**——`applyBuy`（amount/cost 双增）+ `applySell`（按加权平均实现 realize：sold 截断至持仓、溢出为 untracked、成本 floored 至 0，返回 avgCost/sold/untracked/costRemoved 供 caller 算已实现盈亏+持有期）+ 共享 `FLAT_EPSILON`。walker 的买/卖分支与 netPosition 全部改为 reduce through 这两个函数——**两边按构造不可能再分歧**，不再靠注释
- walker 重构保持行为不变：买分支保留 acquiredAtMs 加权混合（读 pre-buy amount）后调 applyBuy；卖分支前置调 applySell 拿 avgCost/sold/untracked（卖分支后续不再读 acc.amount/cost——验证过），移除末尾手动 mutation。netPosition 保留 token 过滤+输入校验，算术全委托
- 测试覆盖：新 `costBasis.test.ts` 12 case——(1) reducer 单测 5（买累加 / 卖按加权平均双减 / over-sell 截断+untracked+成本归零 / 平仓卖纯 no-op 全 untracked / FLAT_EPSILON 阈值）；(2) **跨引擎一致性守卫** 7 个场景（单买 / 两买加权 / 部分卖留存 / 往返归平 / 超卖 / 买光再买 / 分数额）——同一组 fills 喂 walker 和 netPosition，断言净额+成本基准一致。这是两个面一直只用注释承诺的不变量，现在**被测试**且重构后**按构造成立**
- 向后兼容：纯提取重构——零行为变化（paperPnl/positionCaps/gains/openPositions/tradeSizing 既有 72 测试全部不变通过）；FLAT_EPSILON 原为 paperPnl 私有未导出，移入共享模块；3345 测试全绿（+12，无回归）
- 影响面：所有成本基准/持仓数字现在源自一处定义——pnl、gains、open_positions、position cap enforcer、v70 sizing 在数学上保证同源同步

**Phase 70 — 最大可交易额求解（max admissible trade size — "how much CAN I safely trade right now, and which limit binds?"）** ✅
- **把安全态势变成可执行的单一数字，而非加新观测面**：超额下单是自主 agent **爆仓的头号方式**之一。v54 `projectTradeLimits` 回答正向问题"这个 size 行不行"，v53 `safety_headroom` 报告"每个限额还剩多少"——但 agent **每笔交易都要面对**的问题是反向的："给定我的护栏和当前消耗，单笔最多能花多少才不会被拒？"。此前 agent 得读 headroom、手动对所有 USD 限额取 min、再换算——易错。本期直接求解这个上限并指出**绑定约束**
- 为什么是最重要的：这是把"安全"从被动观测变成**主动的、防爆仓的下单纪律**。agent 不再猜或二分试探自己的限额；一次调用得到"现在最多买 $X TOKEN，再多就撞上 <哪个限额>"
- **是 enforcer 的精确反函数，零分叉**：复用**同一套**消耗查询（`dailyUsdVolume`、`usdSpentUnderStrategy`、`netPosition`）——sizing 给的上限与执行时真正 gate 交易的数字完全一致。`budgetConstraints` 是 `evaluateRule` 的逐窗口反函数（perFire 静态天花板；lifetime/daily = cap − 已花，floored）
- 折入 maxTradeUsd 的 USD 约束：per-tx 上限、daily 剩余、匹配策略预算的最紧窗口（传 `--strategy`/`strategy`）、**买入时**净敞口 position cap 的 cost 余量（传 `--token`；base-amount 维度在有价时换算 USD 折入，无价则降级为 caveat）、可选钱包余额。取 min → 绑定约束。**诚实降级**：缺 strategy/token/price、卖出跳过 position cap、限额耗尽→$0、无任何 USD 限额→null（policy 不设限）——每种都有 caveat，数字永不被悄悄过度信任；且**始终建议**对选定 size 跑 preflight
- 实现：新模块 `tradeSizing.ts`——纯函数 `selectBindingConstraint`（取最小 cap）+ `budgetConstraints`（预算反函数）+ `gatherTradeSizing`（注入式查询 seam，确定性、默认无网络）。Surfaces：CLI `safety sizing [--direction --token --strategy --price ...]`（离线；--price 换算 token 量）+ MCP `trade_sizing`（best-effort 拉实时价换算）
- 测试覆盖：`tradeSizing.test.ts` 17 case（selectBindingConstraint 空→null/取最小/排序；budgetConstraints perFire 静态+lifetime/daily floored；gather: per-tx 单独绑定 / daily 更紧时绑定 / 无 USD 限额→null unbounded / 策略预算最紧窗口折入 / 非匹配 tag 不折入 / 配了预算但无 tag→caveat / 买入 cost cap 绑定 / 卖出跳过 cap / base cap 无价→caveat / base cap 有价→换算折入 / 钱包余额绑定 / 价→base 量换算 / 始终 preflight caveat / 耗尽→$0+caveat）
- 向后兼容：纯加法——新模块、新 CLI 子命令、新 MCP 工具；`trade_sizing` 入 MCP_TOOLS 不变量（iter877）；3333 测试全绿（+17）
- v1 限制：position cap 仅约束买入（卖出降敞口）；base-amount cap 需价格换算（无价→caveat 不折入）；钱包余额 CLI 需显式 --wallet-usd / MCP v1 不拉链上余额（policy 限额是独有价值，余额 agent 可另查）；sizing 覆盖 USD 花费限额，token 安全/滑点/精确 admissibility 仍由 preflight 把关（已在 caveat 明示）

**Phase 69 — 入场/退出时机进 pre-trade 决策门（market timing in the preflight verdict — "is now a good time?", not just "will it execute?"）** ✅
- **把已有能力合流进最关键的决策时刻，而非加新 surface**：v64 给了 price_context（区间位置/趋势），但它是**独立**的一次调用——agent 要在交易前自己记得调、自己综合。`preview_trade`/`preflight_trade` 是 agent 下单前的**单一决策面**（执行 gauntlet：滑点、限额、token、失败模式），却**只回答"能不能干净成交"，不回答"现在是不是好时机"**。agent 完全可能拿到一个 go，然后买在 30 天高点 / 接飞刀
- 为什么这是最重要的：agent 拿真钱交易，**亏钱的两大来源是 (a) 被坑（已重投：安全栈）和 (b) 时机差（买顶/卖底/接飞刀）**。(b) 此前在决策门里完全缺位。把时机读数放进 preflight 的 go/caution/no_go 裁决 → agent 分支 `report.verdict` 时**自动**把坏时机纳入考量，不必记得单独调 price_context、也不会漏判
- **方向感知是真正的 feature（非薄包装）**：同一个区间位置对 buy/sell **意义相反**。近期高点 = 买入"追顶"（caution）/ 卖出"在高位出货"（favorable）；近期低点 = 买入"有利入场区"（favorable）/ 卖出"锁死弱价"（caution）；窗口内陡跌 = 买入"接飞刀"（caution）；陡涨 = 卖出"顺势出货"（favorable）。纯函数 `assessTradeTiming(ctx, direction)` 把原始区间数据翻译成与 agent 即将做的动作对齐的决策信号
- 实现：(1) `priceContext.ts` 加纯函数 `assessTradeTiming` + 文档常量 `STEEP_TREND_PCT=15`（飞刀/强势阈值）、`ELEVATED_VOL_PCT=12`（波动率提示，不单独驱动裁决）；(2) `tradePreview.ts` 加 `marketContext` 字段——与既有 6 路并行读**并发**拉取（base token，native→weth；v66 缓存吸收重复；best-effort，无映射/失败则缺省，绝不阻塞 preview）；(3) **`preflight.ts` 把它接进裁决门**：新 reason code `market_timing_caution`（warn→裁决降为 caution，但**只是建议，永不阻断**）/ `market_timing_ok`（info）；(4) CLI preview 渲染时机行 + MCP 两个工具描述更新
- 测试覆盖：`priceContext.test.ts` +8（buy 近高→caution / sell 近高→favorable / buy 近低陡跌→飞刀 caution 压过 / buy 近低缓跌→favorable / sell 近低→caution / sell 陡涨→顺势 favorable / mid-range 平→neutral 无 notes / flat null 位置不崩）；`preflight.test.ts` +5（caution→裁决 caution + reason 形状/severity/source / favorable→仍 go info / neutral→go / 无 context→无 market_timing reason / caution 不压过 critical 仍 no_go）
- 向后兼容：纯加法——`marketContext` 仅在 base 有 CoinGecko 映射时出现；新 reason code 加法（agent 分支既有 code 不受影响）；MCP_TOOLS 不变量不动（只改描述未加工具）；3316 测试全绿（+13）
- v1 限制：时机是**建议非护栏**（caution 降级到 caution，永不 no_go——区间位置不是安全问题，强行阻断会挡住合理的逆势/止损交易）；时机看 base token（native 经 weth）；窗口默认 7d（entry/exit 时机够用，可配）；无 CoinGecko 映射的 token 无时机读数（优雅缺省）；`previewTrade` 编排仍 RPC-bound 不做端到端单测（沿用 iter608 纪律——纯逻辑 assessTradeTiming+裁决接线全测，glue 镜像既有 limits/failurePattern best-effort 模式）

**Phase 68 — 安全态势上 Web（safety posture & headroom on the dashboard — close the last interface gap）** ✅
- **补齐唯一缺位的一等界面，而非加新能力**：tradekit 三大界面是 CLI / MCP / Web。安全是这个产品**最重要的东西**（agent 拿真钱交易，运营商的信任全系于护栏）。v51 `safety review`（配置审计：哪些护栏开着/哪里裸奔）+ v53 `safety headroom`（运行时余量：还剩多少、谁是约束瓶颈）此前只在 CLI/MCP——Web 仪表盘**完全看不到安全态势**。运营商盯着 dashboard 时，恰恰看不到最该看的东西
- 缺口：Web 有 Execution/PnL/Approvals 等 13 个 tab，唯独没有"这套配置安不安全 / 限额还剩多少"。运营商要么切到终端跑 `safety review`，要么裸奔。Web 是运营商日常盯盘的地方——安全态势就该在那
- 实现（一个 payload 合并两个既有只读视图，零新计算）：在**可测的** `registerAutomationRoutes` 注册器里加 `GET /api/safety` → `{ ok, posture: reviewSafety(config), headroom: gatherSafetyHeadroom({config}) }`。确定性、无 RPC（只读 config + trades/drawdown 表）。React `Safety.tsx` 镜像 `Execution.tsx`（只读、防御性 null 处理）：verdict 徽章（hardened/moderate/exposed 配色）+ 计数卡（active 护栏/critical 缺口/警告/约束瓶颈利用率）+ 缺口表（severity 配色 + 修复命令）+ 运行时余量表（利用率/状态配色）+ 护栏清单
- 为何走 `registerAutomationRoutes` 而非 web.ts 内联：那个注册器是**可单元测试**的（`webAutomation.test.ts` 真起 `app.listen` 打真 HTTP），web.ts 的内联分析路由在一个大函数里测不到。把 API 放进注册器 → API 完全可验证（不依赖 React 渲染）
- 测试覆盖：`webAutomation.test.ts` +1（`/api/safety` 返回 posture（verdict ∈ 三态、totalGuardrails>0、guardrails/gaps 数组）+ headroom（entries 数组、counts 有 ok/tripped 键））；webui `tsc -b` + `vite build` 全过（React 编译 + 打包验证）
- 向后兼容：纯加法——新路由、新 React tab、api.ts 新 `getSafety`/`SafetyResp`；既有界面不变；3303 测试全绿（+1）
- v1 限制：Web 视图只读（改护栏仍走 CLI `config` / `safety` 命令——故意，配置变更是高权操作不放 Web）；headroom 取 default account（与 CLI 默认一致）；React 渲染本身无单元测试（靠 tsc + build 防编译错 + 镜像久经考验的 Execution.tsx 形状降风险）

**Phase 67 — 退出决策合流（price context into open positions — one-read exit view）** ✅
- **连贯收尾，非新增 surface**：v64 price context（入场时机）、v65 open positions（退出：PnL+持有期+税务 term）、v66 序列缓存。v65 的退出视图缺了 v64 提供的那一项——**当前价在近期区间的哪个位置**（近高=好平仓点，近低=也许持有），这对退出时机是决定性的。v66 刚把"每仓位拉一次序列"变得可负担（缓存+去重），合流时机正好
- agent 退出决策需要三样：盈亏（有）、税务影响（term，有）、**现在价格好不好**（区间位置——此前不在 open_positions）。补上第三样 → open_positions 成为**一次调用的完整退出决策面**，agent 不必再额外为每个仓位调 price_context、也不会漏判
- 实现：`gatherOpenPositions` 新增 opt-in `withContext`（+ `contextDays` 默认 7 + `seriesFetchImpl` 测试 seam）。开启时并行为每个仓位调 `gatherPriceContext`（native 经 profile.weth 解析 CoinGecko id；无映射→null 优雅降级），attach 紧凑子集 { windowDays, low, high, rangePositionPct, changePctWindow, summary } 到 `OpenPositionEntry.priceContext`。**并行 + v66 缓存/去重** 吸收重复 token，反复 review 便宜
- 默认关：default open_positions 不拉序列（保持便宜）；agent/运营商要完整退出上下文时 opt in
- Surfaces：CLI `positions --context [--days N]` + MCP `open_positions { withContext, contextDays }`，渲染加每仓位 "price ctx: +X% over Nd · Y% of range" 行
- 测试覆盖：`openPositions.test.ts` +2（withContext 给映射 token（WETH）attach context（区间位置/趋势/summary）、给无映射 token（WBTC）置 null；关闭时 priceContext 为 undefined）+ `beforeEach(__clearSeriesCache)` 隔离 v66 模块级缓存
- 向后兼容：纯加法——`priceContext` 字段仅在 withContext 时出现；默认行为不变；3302 测试全绿
- v1 限制：冷缓存下 N 仓位 = N 次 CoinGecko 调用（故默认关、并行、靠 v66 缓存摊薄）；native 仓位经 weth 取上下文（与 price context CLI 同款）；无 CoinGecko 映射的 token 无上下文（优雅 null）

**Phase 66 — 价格序列缓存（fetchPriceSeries TTL + in-flight cache — rate-limit resilience for the hot price path）** ✅
- **硬化我最近功能依赖的核心热路径**，而非加新 feature：现价层早有 60s 缓存（iter132），但 **序列拉取（fetchPriceSeries / CoinGecko market_chart）一直无缓存**。v64 price_context、v65 持仓 mark、所有 backtest 都直打 CoinGecko，而免费档 ~10-30 req/min 限流很硬——agent 连续 screen 几个 token、或运营商迭代 backtest，就吃 429
- 与 v38（批量化价格抓取减少 CoinGecko 调用）同一动机：减少对限流外部 API 的负载。这是"针对最重要的东西优化"——所有价格决策依赖的层
- 实现（镜像现价层的缓存形状）：按 `(coinId, days)` 键的 TTL 缓存 + in-flight 去重（并发同键调用共享一次拉取）+ 容量上限 + 复用 `priceCacheShared.evictIfOverCap`。TTL **5 分钟**（比现价的 60s 长——日/小时级 candle 序列窗口内几乎不动，entry/exit 上下文非 HFT，几分钟"当前点"陈旧换不被限流是值得的，已注释说明）
- 只缓存**成功**序列；抛错（API 限流/故障）**不**缓存→下次重试；null（无 coinId 映射）在拉取前就返回（无需缓存）。`nowMs` 注入 seam 测 TTL 过期、`__clearSeriesCache` 测试隔离
- 测试覆盖：`backtest.test.ts` +5（TTL 内第二次命中缓存仅一次拉取 / TTL 过期重拉 / 按 (coinId,days) 键不同窗口 miss / 并发同键合并为一次拉取 / 抛错不缓存下次重试）+ 给既有 fetchPriceSeries describe 加 `beforeEach(__clearSeriesCache)` 隔离（模块级缓存会让相邻 case 串味——修了 1 个因此暴露的 case）
- 向后兼容：纯加法——fetchPriceSeries 签名加可选 `nowMs`（4th，测试 seam，调用方不传）；行为对调用方透明（命中返回同样的序列）；3300 测试全绿
- v1 限制：5min TTL 意味着 price_context 的"当前价"最多 5 分钟陈旧（对入/出场上下文可接受，非 HFT）；缓存进程内（重启清零，与现价层一致）；序列随时间推移会"漂移"（缓存的是 5min 前结束的窗口）但对 7d/30d 窗口可忽略

**Phase 65 — 持仓复盘 / 退出时机（open-position review — cost basis, unrealized, holding period + projected tax term）** ✅
- **退出决策的对位**：v64 price context 给**入场**时机，v60 给**已实现**收益的持有期+短/长期；本期补上 **OPEN 持仓** 的持有期+若现在卖的税务 term——退出时机。三者凑齐：入场（v64）、持有中（v65）、平仓后（v60）
- 缺口：agent 持有仓位，要决定**何时退出**（止盈/止损/等长期税率），需要每个仓位的：成本基准、当前价值、未实现盈亏（绝对+%）、持有多久、**若现在卖是短期还是长期**、距离长期还差几天。此前无任何 surface 给这个——"WETH 已持 340 天，再 25 天转长期税率，等等" 这种具体退出决策无从下手
- 复用既有：成本基准走 **同一个** cost-basis walker（`computePaperPnlMtm`，real 经 v50 的 `toMtmRows`）——数字与所有 P&L surface 一致。v60 已在 walker 的 `PosAcc.acquiredAtMs` 追踪加权平均取得日；本期把它暴露到 OPEN 持仓输出（`PaperPositionEntry.acquiredAt`，纯加法）
- 新模块 `openPositions.ts`：`gatherOpenPositions(mode, ...)` → 每个 OPEN 持仓 { costBasis, value, unrealized(+%), acquiredAt, holdingDays, projectedTerm（short/long/untracked if sold now）, daysToLongTerm } + 汇总 { totalCostBasis/Value/Unrealized, unpricedCount, approachingLongTerm（短期且距长期 ≤30d 的计数）}。strategy tag 在 walk 前剥离 → 持仓是**组合级**（每 (chain,token) 合并你所有该 token 的买入），传 strategy 则按策略 scope
- 确定性 + 可验证：mark fetcher 注入（测试用确定价；生产用 defaultPaperPriceFetcher live）；compute 对种子 paper 成交确定
- Surfaces：CLI `positions [--paper] [--strategy]` + MCP `open_positions`。与既有区分：holdings=余额，pnl=已实现+整体未实现，portfolio=多账户聚合，`positions`=**逐仓退出上下文**（持有期+税务 term）
- 测试覆盖：`openPositions.test.ts` 7 case（>365d→long 无 days-to-long + 未实现+%；<365d→short + days-to-long；approaching 窗口计数；多次买入加权平均取得日混合；全平仓排除；无 mark 价 unpriced 不崩、成本/持有期仍精确；组合汇总）
- MCP_TOOLS 不变量：`open_positions` 加入 iter589/iter877 set
- 向后兼容：纯加法——`PaperPositionEntry.acquiredAt` 新字段现有消费者忽略；新模块/CLI/MCP；3295 测试全绿、零回归
- v1 限制：持有期/term 沿用 v60 的加权平均取得日近似（非 lot-based FIFO，已披露）；real 模式只看 success 成交的 tracked 仓位（deposit-seeded 的 untracked 部分不计入——与成本基准模型一致）；mark 价取当下 spot（未实现是快照，非历史）

**Phase 64 — 价格上下文（price context — "where does the price sit, which way is it going?"）** ✅
- **转向最少被服务的支柱：行情/发现（market data）**——agent 决策漏斗的前端"该不该/何时交易"。前面大量迭代在 safety/reliability/accounting；这次服务 agent 的核心市场决策
- 缺口：agent 有**现价**（check_price）和**发现**（trending 按 volume/liquidity），但没有**价格上下文**——当前价在近期区间的哪个位置、趋势方向、波动多大。"在 7d 高点附近买" vs "在 7d 低点附近买"是天差地别的决策，而 agent 此前无从判断。仅有的历史序列 `fetchPriceSeries` 埋在 backtest 里、只给回测用
- 新模块 `priceContext.ts`：纯函数 `computePriceContext(points, windowDays)` → { current, low, high, rangePositionPct（0=低 100=高）, changePctWindow, changePct24h, rangeWidthPct, volatilityPct（period-return 标准差）, summary（一句话）} + `gatherPriceContext` 复用 `fetchPriceSeries`（CoinGecko market_chart，**注入式 fetch** 作测试 seam）。确定性：compute 纯函数可单测；唯一 IO 是序列拉取
- 诚实降级：CoinGecko 无映射的 token → 返回 null（"无价格历史"建议），不是错误
- Surfaces：CLI `price context <token> [--days N]` + MCP `price_context`。与既有区分：`price`=现价+原始历史 blob，`trending`=发现，`price_context`=**何时**（区间位置/趋势/波动），entry-timing 信号
- 实测（live CoinGecko）：`price context ETH` → "$1,676 · +3.9% over 7d · 69% of range (mid-range) · 24h +0.4%"，区间 $1,608→$1,706，波动 0.60%，169 样本——正是 agent 定时入场需要的上下文
- 测试覆盖：`priceContext.test.ts` 9 case（computePriceContext：上涨近高点 / 回落近低点 / 区间中部 / 平坦序列→null 位置+0 波动 / 24h 变化有无 / 波动=return 标准差 / 单点降级；gatherPriceContext：映射 token 注入 fetch 端到端 / 无映射→null 且不调 fetch）
- MCP_TOOLS 不变量：`price_context` 加入 iter589/iter877 set
- 向后兼容：纯加法——新模块、新 CLI 子命令、新 MCP 工具；复用 fetchPriceSeries 无改动
- v1 限制：依赖 CoinGecko id 映射（无映射 token 无上下文——与 backtest 同款约束）；窗口用日级 market_chart（CoinGecko 对 >90d 自动降到日粒度，对 entry-timing 够用）；波动是 period-return 标准差非年化（清晰的"多choppy"量度，非风险定价）

**Phase 63 — 测试隔离修复：测试套件不再读写真实配置（test-isolation: stop the suite touching the operator's real ~/.tradekit）** ✅
- **修复一个真实、已证实的危害**：v62 的调试暴露出测试套件在**写我的真实 `~/.tradekit/config.json`**（我的真实 config 里被写进了 `scheduleCircuitBreaker`/`rebalanceCircuitBreaker`——测试干的）。对一个"生产级"框架，测试污染运营商的真实配置文件是不可接受的，且会破坏真实部署、让那些测试非确定（依赖真实 config 内容）、并埋雷（任何 schema 变更都可能经真实 config 炸测试）
- 根因：`constants.ts` 的 `DATA_DIR = env.TRADEKIT_DATA_DIR || ~/.tradekit` 在**首次 import 时解析一次**。多数测试在模块顶部、import db/config **之前**设好临时目录——但 `doctor.test.ts` 第 9 行有个**静态** `import { checkEnv } from "./doctor.js"`，它**被提升到第 14 行的 env 赋值之上**（ESM import hoisting），且 doctor.js 间接 import constants → DATA_DIR 在临时目录设好前就解析成了真实 home。注释甚至写着"在 dynamic db import 之前设置"——但漏看了这个静态 import 会 hoist
- 系统性防护（覆盖整类 bug，不止 doctor.test）：新增 `vitest.setup.ts` + `vitest.config.ts setupFiles`。setupFile 在**任何测试模块（含其 hoisted import）求值之前**运行——当 env 未设时把 `TRADEKIT_DATA_DIR` 设成临时目录，把危险的 (未设→home) 变成 (未设→temp)。不覆盖自设临时目录的文件（它们的顶部赋值在此之后、其 dynamic import 之前生效，per-file 隔离保留）——这是一道"地板"，只挡住真实 home
- 根因修复（demonstrated offender）：`doctor.test.ts` 的静态 `checkEnv` import 改为 env 赋值**之后**的 top-level `await import`（用它自己的临时目录，干净隔离）
- 永久回归守卫：新 `dataDirIsolation.test.ts`——故意不设自己的 env + 静态 import constants（正是出事的模式），断言 `DATA_DIR !== ~/.tradekit`。谁移除 floor，这个测试立刻失败，把整类"测试碰真实配置"的 bug 暴露出来
- 实证验证：快照真实 config 的 mtime → 单独跑 doctor.test（原始 offender）→ mtime **未变**（✓ 真实配置 untouched）。审计了另外 4 个有同款静态-import 模式的文件（addressBook/activitySync/metrics/wallet）——floor 一并覆盖
- 全套绿：125 files / 3279 tests，零回归、零未捕获异常
- v1 限制：未清理我真实 config 里已被写入的 scheduleCircuitBreaker/rebalanceCircuitBreaker 两个 key（它们现在是合法的默认值、无害；刻意不动用户的真实文件）；floor 用 `||=` 语义（仅在未设时兜底），自设临时目录的文件不受影响

**Phase 62 — 再平衡失败熔断 + 共享熔断器（circuit-breaker generalized to rebalances）** ✅
- 完成 v61 显式留的对称跟进：**rebalance plans 和 schedules 一样在 cron 上永久 fire**——一个持续失败的再平衡计划（每 tick 的修正交易都 revert）同样无限烧 gas，同样无自动暂停。把熔断器扩到这另一个"永久 fire"原语
- **抽出共享 helper `circuitBreaker.ts` 的 `tripCircuitBreakerIfNeeded`**：schedules 和 rebalance 都走它（注入 pause fn + breaker config），机制/消息/dedup 形状不会发散。这让本迭代是真正的"提炼复用"而非复制粘贴——v61 schedules.ts 的内联闭包重构为调用共享 helper（行为不变，v61 的 4 个测试验证）
- Rebalance 侧镜像 schedule 的全套：v62 migration `rebalance_plans.consecutive_failures`；`recordRebalanceError` 自增并返回 streak；`recordRebalanceRun`（成功/skip）+ `resumeRebalancePlan`（运营商重启）归零；tick 两个终态失败站点都接 `maybeCircuitBreak`（pause via `dbPauseRebalancePlan` + critical 通知 `rebalance.circuit_broken` + fire 标 circuitBroken）
- **配置：保持 `engine.scheduleCircuitBreaker`（v61）+ 新增 `engine.rebalanceCircuitBreaker`**，两个独立 knob——而非合并成一个。**关键决策修正**：我最初想合并成 `failureCircuitBreaker`（更优雅），但意识到 schema 是 `.strict()` 的——**重命名 v61 已发布的 key 是破坏性变更**：任何带旧 `scheduleCircuitBreaker` 的 config（包括 v61 写入的）会被 strict 拒绝。所以回退到保留旧 key + 加平行 key，向后兼容。两个 knob 也允许 schedule（高频 DCA）与 rebalance（低频）独立调阈值
- 测试覆盖：`circuitBreaker.test.ts` 7 case（disabled/undefined/阈值下不触发、达到/超过阈值 pause+true、pause no-op race→false、rebalance kind）+ `rebalanceTick.test.ts` +4（streak 递增、成功归零、阈值自动暂停+circuitBroken 标、disabled 不暂停、resume 清零）；v61 schedule 测试零改动通过（重构正确性证明）
- 向后兼容：纯加法——migration 加列、新 config key 默认关、`recordRebalanceError` 返回值新增（既有 void 调用无碍）；v61 的 scheduleCircuitBreaker **逐字节保留**；3277 测试全绿、零回归、零未捕获异常
- v1 限制：仍未覆盖 **orders**（fill revert 重试——但 orders 主要是 cheap RPC 检查直到触发，gas-bleed 风险低于 cron 永久 fire 的 schedule/rebalance，优先级低）；两个 breaker knob 独立而非统一（strict schema 下保留 v61 key 的代价，可接受）

**Phase 61 — 计划失败熔断（schedule failure circuit-breaker — stop a broken schedule bleeding gas forever）** ✅
- **转向引擎自主可靠性**（无人值守 agent 最关键的运行时安全）。真实money-loss向量，后端逻辑确定性可验证
- 缺口：一个**持续失败**的 schedule（每次 fire 都 revert——坏配置、死池、永远过不了 honeypot 探测的 token）会永远 fire-and-fail：v32 `fireRetry` 只做有界 backoff（3 次后下个 cron slot 顶上，又失败……），`strategyAlerts failure_streak` 只**通知**，**没有任何东西自动暂停**它。代码注释（recordScheduleError）甚至明说"想要 halt-on-error 的运营商可以从通知回调手动暂停"——确认了这个缺口。结果：unattended agent 上一个坏 schedule 每个 cron 窗口烧一次 revert 的 gas，运营商只能靠 pull（digest/health）发现
- 新增 opt-in `engine.scheduleCircuitBreaker { enabled=false, maxConsecutiveFailures=5 }`：连续 N 次**终态** fire 失败后，引擎**自动暂停**该 schedule + 通知（critical, `schedule.circuit_broken`）。运营商排查后 `schedule resume`（清零 streak 重新启用）。默认关 → 现有部署保持"每次 occurrence 独立 fire"的 DCA 语义，逐字节不变
- 实现：
  - v61 migration：schedules 加 `consecutive_failures INTEGER DEFAULT 0`（纯加法）
  - `recordScheduleError` 自增 streak 并**返回新计数**；`recordScheduleFire`（成功）归零；`resumeSchedule`（运营商重启）归零——"连续终态失败、成功/重启即重置"语义，与 strategyAlerts failure_streak 对齐
  - schedule tick 两个终态失败站点（钱包加载失败 + 交易执行失败）都接 `maybeCircuitBreak(schedule, failCount, code)` 闭包：enabled && count ≥ 阈值 → `dbPauseSchedule` + critical 通知 + fire 标 `circuitBroken`。transient retry 路径**不**计入 streak（occurrence 未终结）
- 与既有机制互补：`fireRetry`=瞬时失败有界重试；`scheduleCircuitBreaker`=持续失败永久熔断；`strategyAlerts`=通知（不暂停）；`drawdownCircuitBreaker`=组合亏损暂停全部交易（非 per-primitive 失败）。四者不同层、不重叠
- 测试覆盖：`scheduleTick.test.ts` +4（streak 在终态失败递增、成功归零 / 阈值触发自动暂停 + circuitBroken fire 标 + 暂停前两次仍 active / 默认关时连 5 次失败仍 active（streak 仍追踪）/ 运营商 pause→resume 清零 streak）
- 向后兼容：纯加法——migration 加列、config 默认关、recordScheduleError 返回值新增（既有 void 调用忽略无碍）；3266 测试全绿、零回归
- v1 限制：只覆盖 **schedules**（最清晰的"永远 fire"gas-bleed 风险——cron 每窗口都烧）；**rebalances**（同样 cron 永久 fire）+ **orders**（fill revert 重试）是对称跟进；streak 计入所有终态失败（含 WALLET_NOT_FOUND 这类不烧 gas 的配置错——一个怎么都 fire 不了的 schedule 也该自动暂停 + 告警，语义正确）；阈值全局非 per-schedule（未来可 per-schedule 覆盖）

**Phase 60 — 持有期 + 短/长期税务分类（holding period & short/long-term tax split）** ✅
- **转向从未碰过的生产级关键支柱：会计/税务记录**（真金白银 + 合规依赖正确的已实现收益报告）。确定性、纯离线 → 本 loop 完全可验证
- 缺口：`gains` 报告是**扁平的**（per-realization 记录 + 一个总额），既无 per-token 汇总，也无**持有期/短期 vs 长期分类**——而短/长期是报税最重要的区分（税率天差地别）
- 给成本基准 walker 加了**加权平均取得日**追踪（`computePaperPnlMtm`，喂着 paper pnl / strategy report / promote check+outcome / gains 多个消费者——故**纯加法**，blast radius 限制在新字段，不碰 amount/cost/realized 数学）：
  - `PosAcc.acquiredAtMs`：当前持仓的加权平均取得时刻，每次买入按数量混合、持仓归零时重置。与加权平均成本基准模型同构——一个混合成本/单位，就有一个混合取得日（这是该模型能给的**有原则的持有期估计**，非 lot-based FIFO/specific-lot）
  - `RealizationRecord` 新增 `acquiredAt` / `holdingDays` / `term`（'short' ≤365d / 'long' >365d / 'untracked' 无追踪基准）；卖出时按 `LONG_TERM_DAYS=365`（持有**超过**一年为长期）分类
- `GainsReport` 新增：`byTerm`（short/long/untracked 的 gain+proceeds+cost 子合计——头条税务分割）+ `byToken`（per-(chain,token) 汇总，按 gain 降序——报税人读的"按资产"小计而非扁平列表）
- Surfaces：CLI `export gains` 的 CSV 加 `acquired_at`/`holding_days`/`term` 三列 + stderr 摘要显示短/长期分割 + 按资产汇总 + 持有期估计免责声明；MCP `gains_report` 自动随附 byTerm/byToken（纯加法）
- 诚实披露：持有期是**加权平均估计**非 lot-based——明确写进 CSV 摘要 + MCP 描述 + 类型注释（该模型每仓位一个混合基准，故持有期也是混合的）
- 测试覆盖：`gains.test.ts` +7（walker：>365d→long + acquiredAt + holdingDays / ≤365d→short / 多次买入按量混合取得日 / 持仓归零后重置取得时钟 / 无基准卖出→untracked；gatherRealizedGains：byTerm 短长分割 + byToken 按资产汇总）；修了既有 CSV fixture（补 3 个新字段）
- 向后兼容：纯加法——RealizationRecord 新字段现有消费者忽略；walker 的混合数学只影响新 acquiredAtMs 字段，amount/cost/realized 逐字节不变（3262 测试全绿、零回归即证明）
- v1 限制：持有期是加权平均估计非 lot-based（IRS 默认特定识别/FIFO；此模型给的是该法下的合理近似，已披露"非税务建议"）；长期阈值固定 365d（未来可配 holdingPeriodDays）；untracked 卖出（超卖无基准）单列不计入 short/long

**Phase 59 — Logger 无文件模式 + 测试套件归零（quality, not breadth）** ✅
- **刻意不加 feature**：连续 8 个 feature 迭代后，最有价值的不是第 9 个 feature，而是消除整个代码库里我每次跑全套都看到的、唯一客观可测的缺陷——全套测试每次都报的 **9 个未捕获异常**（`promoteCheck.test.ts` 的 `server.log` ENOENT race）。生产级框架的测试套件每次跑都漏 9 个 uncaught exception，是会侵蚀信任、掩盖新错误、可能让严格 CI 失败的真实瑕疵
- 根因是真正的 **logger 正确性缺口**（不是测试小问题）：`createLogger` **无条件**打开 `createWriteStream(SERVER_LOG_PATH)`，没有任何方式拿到一个不碰文件的 logger。后果：每个为满足 price-fetcher 签名而在 gather 函数里创建的**临时 silent logger** 都开一个真实文件句柄——在测试里与临时 data dir 清理 race（那 9 个错误），生产里是"对已删文件的异步写"这一类潜在健壮性 bug，且只读/一次性工作也在污染 server.log
- 真正的能力补全（非 hack）：logger 新增 `fileLevel?: LogLevel`（与 `stderrLevel` 对称，默认 `"debug"` = 一直以来的"全捕获"行为，**逐字节向后兼容**）。`fileLevel: "silent"` → **根本不开 stream**，无句柄可漏、无 IO 成本；`write()` 按 fileMin 逐级 gate 文件写入。新增 `createSilentLogger()` 便捷构造器 = 完全不落盘不落 stderr 的瞬时 logger
- 应用到 5 个临时 logger 站点（promoteCheck / promoteOutcome / strategy-tools ×2 / cli strategy）——它们创建 silent logger 纯粹为传给 price fetcher，本就不该开共享日志文件 → 全改 `createSilentLogger()`
- 结果：**全套从 9 errors → 0 errors**（123 files / 3256 tests 全绿且零未捕获异常——9 次迭代以来第一次完全干净）
- 测试覆盖：`logger.test.ts` +5（默认 createLogger 开并写文件 / createSilentLogger 完全不落盘不开文件 / `fileLevel:"silent"` 等价 / `fileLevel:"warn"` 逐级 gate 落盘 / silent logger 仍能 recordTrade/recordAudit——文件日志与 DB 记录正交）
- 向后兼容：纯加法——`fileLevel` 默认 `"debug"` 保留全部既有行为；既有 createLogger 调用者零改动
- v1 限制：只把 5 个**临时**站点改成 silent；CLI/MCP/engine 的主 logger **仍**写 server.log（运营商要完整操作 trail，故意不改默认）；只读 CLI 是否该落盘留作未来策略决定（本迭代不改行为，只补能力 + 修瑕疵）

**Phase 58 — 聚合器路由调优（aggregator tuning — close the execution-quality learning loop）** ✅
- **转向产品的字面核心**：交易执行质量（路由 → 成交质量 → 每笔交易省下的真实滑点钱），不是又一个观察面板。这是连续 8 个迭代后第一次碰执行本身
- 开着的学习闭环：`aggregatorStats`（iter623）**描述**每个聚合器的成交质量，`deriveRecommendation` **点名**单个最佳，`health` 的 `aggregator_underperformer` **提醒**运营商重排 `config.aggregator.preferred`——但把这份"已实现成交"数据变成**实际路由配置**（完整排序 + 一键应用）的那块一直缺失。运营商得手动改
- 新增 `deriveAggregatorTuning()`（纯函数，aggregatorStats.ts）：按已实现成交质量把聚合器排成最优 `preferred` 顺序
  - **可靠性优先排序**：失败成交浪费 gas **且**错过交易——严格比几个 bps 滑点更糟。先按成功率分桶（TUNE_SUCCESS_BAND=2% 带，避免噪音重排路由），桶内按中位已实现滑点 tiebreak
  - 只有 ≥ TUNE_MIN_TRADES（10）笔的聚合器才按实绩排名；其余按当前/默认顺序垫后（无证据→无意见）
  - **mode 推荐**：eligible 聚合器的滑点跨度 ≥ TUNE_MODE_SPREAD_BPS（15bps）且当前在 "first" → 推荐 "best"（逐笔竞价取最便宜成交，胜过押注固定顺序）
  - 复用既有导出的 `resolveAggregatorOrder`（preferred + 默认尾部 dedup）算 current/recommended 完整解析顺序
- **零 RPC**：`computeAggregatorStats` 优先用 STORED `realized_slippage_bps`（iter641），所以 tune 传 `analyses=[]`，纯读 trades 表算中位滑点——快且离线
- Surfaces：CLI `aggregator tune [--since] [--apply] [--json]`（排名 + 推荐顺序 + mode 建议；`--apply` 写 config.aggregator.preferred，CLI-only 配置变更，与所有 config set 一致）+ MCP `aggregator_tune`（只读返回推荐；agent 想应用就调 config 工具——保留配置写入的审慎边界）
- 与既有的分工：`aggregator stats` 描述性（每聚合器质量），`aggregator tune` 规定性（最优顺序 + 动作）。主要惠及 mode="first"；"best" 模式顺序意义小（反正全竞价），故 tune 在跨度大时主动推 first→best
- 测试覆盖：`aggregatorStats.test.ts` +6（可靠性优先：高成功率压低滑点 / 同桶内低滑点 tiebreak / 低于交易门槛不按实绩排 + insufficient / 跨度大推 best / 窄跨度或已 best 不推 / 数据已匹配则 changed=false）
- MCP_TOOLS 不变量：`aggregator_tune` 加入 iter589/iter877 set
- 向后兼容：纯加法——无 schema migration、无现有行为改动；tune 默认 dry-run（只 --apply 才写配置）
- v1 限制：排名用历史已实现滑点（过去不保证未来，但 30d 窗口对稳定路由够用）；mode 应用仍需运营商手动 `config set aggregator.mode`（--apply 只写 preferred 顺序——改 mode 是更大决定，留给显式确认）；只覆盖有 stored realized_slippage_bps 的成交（legacy 行无 → 该行不计入中位，与 aggregator stats 同款）

**Phase 57 — 安全态势进 cron digest（standing posture in the digest verdict）** ✅
- 对称完成 v55 在交互式 `health` 做的事——把**标准安全态势**接进 `digest`，即 **cron 监控面**。这是无人值守自主 agent 最关键的监控路径（`--summary` 单行 + `--strict` 退出码 + `--watch` JSONL 流）：运营商不盯着看，靠 cron digest + alert
- 缺口：digest 已有 `SafetyEventsSection`（统计窗口内**发生**了什么——drawdown 触发、budget block、honeypot block）+ verdict（healthy/attention/critical），但 verdict 对**当下站立的危险**完全盲——配置 EXPOSED（safety 关掉 / 根本没有 USD 上限）或运行时逼近某个会停掉交易的限额。一个 cron digest 可以报 "healthy" 而钱包大开
- 这是 coherence（接通既有 v51/v53）而非新护栏。**不新增工具**——digest_summary MCP 返回完整报告，`posture` 字段自动随附
- digest.ts 新增 `PostureSection`（站立态势，区别于"窗口内事件"的 SafetyEventsSection）：v51 配置 verdict（hardened/moderate/exposed）+ critical/warn gap 数 + 最严重 gap 一行 + v53 binding（最紧运行时限额）。在 digest 内**用原语就地组合**（reviewSafety + gatherSafetyHeadroom），不依赖 health 模块（避免 digest→health 耦合）。best-effort：失败 → null，digest 永不因态势而崩
- `classifyVerdict` 新增 posture 贡献，**精心避免双计**：
  - 配置 EXPOSED → attention（这是其他窗口信号完全没覆盖的新信号——cron 运营商以前永远看不到"钱包配置大开"）
  - binding 限额 approaching/exhausted → attention，**但跳过 drawdown**（已由 drawdownCurrentlyTripped 作 critical 覆盖），避免重复 reason
- posture 是"当下"概念非窗口范围——comparison 的 prior 窗口 posture=null
- CLI digest 文本新增 Posture 行（verdict 徽章 + 最严重 gap + 非 ok 的 binding）；verdict reasons 自动把 EXPOSED/near-limit 信号带进 `--summary` 和 markdown 渲染
- 测试覆盖：`digest.test.ts` +6（classifyVerdict：EXPOSED→attention / moderate 不抬升 / binding approaching→attention / tripped drawdown binding **不**双计；gatherDigest 集成：EXPOSED 配置把零活动窗口抬到 attention + healthy 需非 exposed 配置）；修了 2 个既有测试（digestPush 的 cfg() helper + zero-state——它们假设默认配置 healthy，但默认无 USD 上限=exposed，给它们加 perTxUsdLimit 恢复"健康窗口"本意——这本身证明了规则在正确工作）
- 向后兼容：纯加法——`posture` 字段 + classifyVerdict 的 posture 参数都 optional；既有 classifyVerdict 调用者/测试零改动。无 schema migration、无新工具
- v1 限制：posture 用 active account/chain 的 headroom（与 v55 health 同款）；binding 的 drawdown 维度故意让给既有 drawdown 信号；EXPOSED→attention（非 critical）——它是站立配置问题非活动事故，运营商按真钱与否自行加权（可用 `--strict` + minVerdict 把 attention 变成 cron 退出码 1）

**Phase 56 — 临时再平衡预览（ad-hoc rebalance preview — "if I targeted this, what's my drift + corrective trades RIGHT NOW?"）** ✅
- **刻意离开安全主题**（v50–v55 连续 6 个安全/信任迭代）转向另一条核心腿：**持仓管理（position management）**。诚实自检——再在安全栈上加东西就是指令警告的"疯狂加量"
- 真实缺口：drift + 交易计划的纯函数（`computeDrift` + `planRebalanceTrades`）此前**只在引擎 tick 内、针对已部署 plan**运行。一个运营商/agent 想问"我该不该再平衡、平衡到什么比例？"必须先建一个 plan row + `rebalance run --dry-run` 才能**看到**答案。没有一次性的"给定目标配比，我现在的 drift 是多少、需要哪些交易"的分析入口
- 新增 `gatherRebalancePreview()` + `renderRebalancePreview()`（在 rebalance.ts 内，复用私有 `defaultFetchPortfolio` / `defaultFetchPaperPortfolio`）：把同一套**纯原语**组合到一份一次性报告——只读、无 plan row、无引擎、无 keystore
  - `validateTargets`（同样的 ≥2 目标 / 和=100% 规则）→ `computeDrift(snapshot, targets)` → `planRebalanceTrades(drift, {quoteToken, minTradeUsd})`
  - 报告：`totalUsd / maxDriftPct / wouldFire（对可选 driftThresholdPct）/ drift[]（每目标 current%→target% + drift + USD delta）/ steps[]（修正交易，卖在前）/ skipped[]（低于 minTradeUsd 的腿）/ totalTradeUsd`
  - 确定性 given snapshot：唯一 IO 是组合 fetch（可注入 seam）；与引擎 tick 用**完全相同**的 drift/计划数学——预览即真实行为
- Surfaces：CLI `rebalance preview --targets '[...]' [--quote-token] [--min-trade-usd] [--drift-threshold] [--paper] [--json]` + MCP `rebalance_preview`（只读，agent 在 `rebalance_create` 之前**决策**用，或给一次性手动再平衡定量）
- 与已部署 plan 的分工：`rebalance create` 部署一个引擎周期性纠偏的计划；`rebalance preview` 是当下一次性"如果……会怎样"分析，不留痕
- 测试覆盖：`rebalance.test.ts` +5 case（注入 snapshot seam，纯确定性——drift+卖出超配腿 / wouldFire 对阈值 / minTradeUsd 推入 skipped / paper 标志 + 和≠100 抛 INVALID_PARAMS / 渲染含 would-fire 上下文）
- MCP_TOOLS 不变量：`rebalance_preview` 加入 iter589/iter877 set
- 向后兼容：纯加法——无 schema migration、无现有行为改动、无引擎触动；纯读现有 holdings/paper book
- v1 限制：quote anchor 默认 "USDC"（与 create 一致，可 --quote-token 覆盖）；preview 取当下快照不预测多步（连续纠偏的收敛留给部署 plan 的 tick 反馈）；价格用 holdings 的 USD（oracle 缺失 → hasUnpriced 标记，drift 为部分视图，与引擎 soft-skip 同款诚实降级）

**Phase 55 — 安全态势进主仪表盘（safety posture + headroom in `health`）** ✅
- 不是新工具，是**让既有投资落到运营商真正看的地方**：v51 safety_review（配置态势）和 v53 safety_headroom（运行时余量）是独立命令——运营商得**记得去跑**。但运营商的主交互是 `tradekit health`（一键仪表盘）和 cron `digest`。`health` 的 SECURITY 段**只讲 allowances**，对两个最危险状态——配置 EXPOSED（safety 关掉 / 没有任何 USD 上限 → agent 交易无界）和运行时逼近限额（日限额快花完 / 预算/仓位 cap 逼近 / drawdown 熔断已触发）——**完全盲**。本迭代把它们接进主仪表盘
- 这是"针对最重要的东西优化"而非"加量"：没有新增 MCP 工具，只丰富既有 `health` 表面
- `health.ts` 新增 `HealthSafetySection`：v51 态势 verdict（hardened/moderate/exposed）+ critical/warn gap 数 + 最严重 gap 一行 + v53 binding（最紧的运行时限额：label/scope/utilization/status）
- `composeHealthReport` 保持纯 compose 契约：`reviewSafety`（纯读 config）在 compose 内跑；`gatherSafetyHeadroom`（读 DB）由 CLI/MCP 层算好传入——与 portfolio/pnl 同款编排模式。新增 `safety_failed` 错误码，headroom 失败降级为只剩 config-posture 半边，不破仪表盘
- `deriveNextActions` 两条新规则（接进运营商真正会扫的 recommendedActions 流）：
  - **safety_exposed**（critical）：态势 verdict===exposed → "Wallet safety posture is EXPOSED: <最严重 gap>"，command `tradekit safety review`
  - **limit_near_exhaustion**：binding 非 ok → 严重度随状态（tripped→critical[交易已停]、exhausted→high、approaching→medium），command `tradekit safety headroom`
- CLI `health` 文本新增 SAFETY 段（posture 徽章 + binding limit），新 actions 自动进 NEXT ACTIONS（已按严重度排序）；MCP `health` 报告加 `safety` 字段（纯加法）
- 测试覆盖：`health.test.ts` +7（buildSafetySection：exposed 态势 + 折入 binding + hardened 无 binding；deriveNextActions：safety_exposed critical / hardened 不触发 / binding 严重度映射 tripped→critical exhausted→high approaching→medium / ok binding 不触发）。现有 87 个 health 测试零改动通过——纯加法的根本证明
- 向后兼容：纯加法——无 schema migration、无新 MCP 工具、`safety` 字段仅在传入 config 时出现；不传则 `health` 行为与升级前逐字节一致
- v1 限制：headroom 用 active account/chain（`health` 可多账户 scope，但 daily-USD/rate-limit 是 per account+chain——仪表盘取默认 scope，深查用 `safety headroom --account`）；digest cron 一行**未**接入本迭代（health 是主仪表盘，先做它；digest 集成留作对称跟进）；态势是配置静态审计，不查"刚才那笔会不会过"（那是 v54 admissibility 的职责）

**Phase 54 — 交易前限额投影（pre-trade limit projection — "will this trade actually be ADMITTED, or bounce off a limit?"）** ✅
- 修复**最重要的交易决策工具**的"沉默不完整"：`trade preview` / `preview_trade` 只跑**廉价子集**（`enforcePreflightSafety` = slippage 上限 + token 白/黑名单，iter405 拆分）。**状态相关**的执行护栏——per-tx / daily USD 上限、contract whitelist、per-strategy 预算、净敞口 position cap、交易限频、gas 预算——只在**执行时**才触发。结果：agent 读到 `safety.passes=true`，调 buy，却吃一个它**无法预见**的 `SAFEGUARD_TRIGGERED` / `STRATEGY_BUDGET_EXCEEDED` / `POSITION_CAP_EXCEEDED` 拒绝
- 新模块 `tradeAdmissibility.ts`（~200 行）：`projectTradeLimits()` 为一笔**预期交易**投影完整的执行护栏。**关键设计——零偏差**：它在 try/catch 里跑**真正的抛错 enforcer**（`enforceSafety` / `enforceRateLimit` / `enforceStrategyBudget` / `enforcePositionCap` / `enforceGasBudget`），而**不是**重新推导阈值——所以投影**永远不可能**与执行实际行为不一致。一个"会撒谎的 preview"比没有 preview 更糟；复用执行代码让撒谎不可能
- 返回 `{ admissible, checks[], blocking[] }`：每个护栏的 pass/fail + 失败时的结构化 ToolError code（AMOUNT_EXCEEDS_LIMIT / SAFEGUARD_TRIGGERED / STRATEGY_BUDGET_EXCEEDED / POSITION_CAP_EXCEEDED / GAS_BUDGET_EXCEEDED）+ agent 在执行时会看到的**原文 message**
- 集成（纯加法，全部 best-effort 不阻断 preview）：
  - `previewTrade`：新增可选 `strategy` 参数 + 新 `limits` 字段（用真 enforcer 投影；买单的 base 收到量来自 amountOut，gas 来自 metrics）。`safety` 字段语义**完全不变**——`limits` 是补充的完整图景
  - `preview_trade` MCP：新 `strategy` 参数 + 描述说明 `limits.admissible=false` 即"buy/sell 会在执行时被拒"
  - `preflight_trade` 复合 verdict：preview 已带 `limits` → 组合器新增 `limit_would_reject`（critical → **no_go**）。agent 分支于 verdict 即可自动拒绝会被护栏弹回的交易
  - CLI `trade preview [--strategy]`：渲染 `Limit projection: 🟢 ADMISSIBLE / 🔴 WOULD REJECT` + 每条 blocking；`--strict` 现在也在 `limits.admissible===false` 时退出 1（pipeline gate 完整）
- 与 v53 headroom 的分工：headroom 答"还剩多少空间"（当前状态快照），admissibility 答"这笔**具体**交易过不过"（含交易量的前向投影 + 零偏差执行语义）
- 测试覆盖：`tradeAdmissibility.test.ts` 12 case（真 enforcer + seeded DB——per-tx/daily AMOUNT_EXCEEDS_LIMIT / 限频 SAFEGUARD_TRIGGERED + ready / 预算 STRATEGY_BUDGET_EXCEEDED + 无 tag 跳过 / position cap POSITION_CAP_EXCEEDED + sell 跳过 / gas GAS_BUDGET_EXCEEDED / 全过 admissible / 多限同时失败全进 blocking）+ `preflight.test.ts` +2（limit_would_reject → no_go / admissible 不加 reason）
- 向后兼容：纯加法——无 schema migration；`safety` 字段语义不变；`limits` 仅在投影成功时出现；不传 `strategy` 则只投影非 tag 限额（core/rate/gas）。现有 preview/preflight 调用者零行为变化
- v1 限制：`limits` 投影 token-safety honeypot 探测**不**在内（那是 preflight 的独立 source，已是 no_go）；position cap 用 real 成交（paper=false）；core_safety 会**重跑** slippage+token（与 preview.safety 冗余但无害——`limits.admissible` 因此是单一的"会不会过"完整布尔）；投影是当下状态的前向投影，不预测"连发 N 笔后第 N 笔"（agent 拿 headroom 自己推）

**Phase 53 — 运行时安全余量（safety headroom — "how much room is left, and what's my binding constraint right now?"）** ✅
- 安全投资的**第三种用法**，而非第四道护栏：v51 safety_review 让**静态配置态势**对运营商可读；v52 promote safety-preflight 让它在 go-live 时**起闸**；v53 让**运行时余量**在决策时对 **agent** 可读
- 痛点：一个自主 agent 在动手交易前，应该知道自己**还剩多少空间**——今天日限额还剩 $50、离某个 position cap 还有 80%、离 drawdown trip 还差 5%——这样它能**聪明地 size 下一笔交易**，而不是盲发然后撞上 SAFEGUARD_TRIGGERED 被拒。运营商也获得一句话的"我的 agent 离限额多近？"
- 新模块 `safetyHeadroom.ts`（~330 行）：纯函数 `gatherSafetyHeadroom(config)`，每个**活跃的量化限制**变成一个 `HeadroomEntry`，带 used / remaining / utilizationPct + status（`ok | approaching ≥80% | exhausted ≥100% | tripped`）
- 覆盖的限制（spend / loss / rate / exposure 全维度）：
  - **daily USD cap**：24h 滚动量 vs 上限，按 account × chain 作用域（`dailyUsdVolume`）
  - **strategy budgets**：复用 `computeBudgetConsumption`（lifetime + 24h 滚动 remaining；perFire 是 per-trade 上限，作静态报告）
  - **drawdown 熔断**：当前 DD% 占 trip 阈值的比例 + 距离触发的 pp（`getDrawdownState`）；tripped 直接置顶
  - **trade rate limit**：账户上次交易至今的间隔 vs 最小间隔（`lastTradeAtByAccount`）→ ready 或 wait Nms
  - **position caps**：每个匹配 tag 的当前**净敞口** vs 上限（`netPosition` + `defaultFillRows`；wildcard pattern 展开到每个匹配 tag，与 enforcePositionCap 的 per-tag 语义一致）
  - **per-tx USD**：静态 ceiling，信息性报告（无累积状态）
- `binding`：最紧的活跃约束（tripped > exhausted > approaching > ok，同级比 utilization）——agent 一眼看到"现在卡我的是哪条"
- 确定性 + 离线：读 config + trades/drawdown 表，无 oracle、无 RPC。注入 seam（dailyVolumeFn / spentLookup / distinctStrategiesFn / drawdownLookup / lastTradeAtFn / fillRowsLookup）让测试纯净无 DB
- Surfaces：CLI `safety headroom [--account L] [--chain X] [--json]` + MCP `safety_headroom`（只读，agent 在 size 交易**之前**调用以待在 envelope 内）
- 与 v51 的分工：`safety review` 答"配置了什么护栏"，`safety headroom` 答"还剩多少"——同一安全栈的静态面 vs 运行时面
- 测试覆盖：`safetyHeadroom.test.ts` 18 case（daily USD used/remaining/util + ok/approaching/exhausted + account×chain 作用域 / per-tx 信息性 / strategy budgets lifetime+daily+perFire / drawdown 距离 + tripped 置顶 / rate limit ready vs wait / position caps 净敞口 + wildcard 展开 / binding 选择 tripped 优先 + 同级比 util / 空配置 null binding / 渲染 / APPROACHING_PCT 80% 边界）
- MCP_TOOLS 不变量：`safety_headroom` 加入 iter589/iter877 set（security-tools）
- 向后兼容：纯加法——无 schema migration、无现有行为改动、无引擎触动；纯读现有 config + 表
- v1 限制：headroom 是**当下快照**，不预测——它不告诉你"再发 N 笔会怎样"（agent 拿 remaining 自己除）；position-cap 的净敞口用 real 成交（paper=false），paper 策略的 cap 余量留待 v2；daily USD + rate limit 含 pending 交易（与各自 enforcement 一致——pending 可能确认，排除会让人 double-spend）；per-fire / per-tx 是 per-trade ceiling 无"已用"概念，作静态项不参与 binding

**Phase 52 — 晋升安全预检（promote safety preflight — "before this fires real trades, is the wallet GUARDED?"）** ✅
- 让 v51 的安全态势在**真正动钱的那一刻**起作用，而不是一个运营商得记得去跑的工具：`promote --to real` 是钱真正上场的时刻，它已有一套 v36 **funding preflight**（advisory 默认、`--require-funded` 强制、`--skip-preflight` 绕过），但只问"钱包**付得起**吗？"——完全不问"钱包在交易时**有没有被护栏看住**？"。一个策略可以拿到 funding ✓ 同时 agent 的钱包根本没有 USD 上限、infinite approvals 还开着
- 对称补全：在 funding preflight 旁边加一个 **safety preflight**——同样的形态（advisory 默认、打印态势、`--require-safe` 在 CRITICAL 护栏缺口上中止、`--skip-preflight` 同时关掉两个预检）
- 新 helper `safetyReview.safetyPromoteBlocker(report)`（镜像 `playbooks.preflightBlocker`）：当态势含至少一个 **CRITICAL** 缺口（safety 整个关掉，或 perTx **且** daily USD 上限都没有 → 真实交易无上限）返回 blocker 文案（点名 finding + fix）；否则返回 null。**WARN/INFO 永不阻断**——它们被打印给运营商权衡，不强制
- 集成点（funding 问"能付吗"，safety 问"被看住吗"，两者并排）：
  - CLI `playbook promote`：funding preflight 之后跑 `reviewSafety(loadConfig())`，打印 `Safety posture: ✓ hardened` 或 `⛔ EXPOSED / ⚠ MODERATE` + critical/warn 缺口；`--require-safe` 在 blocker 上抛 `SAFEGUARD_TRIGGERED`
  - MCP `playbook_promote`：新增 `requireSafe` 参数；结果**始终**附带 `safety` 态势（agent 可检视），`requireSafe=true` 在 CRITICAL 缺口上抛 `SAFEGUARD_TRIGGERED`。`skipPreflight` 现在同时关掉 funding + safety 两个预检
- 错误码复用 `SAFEGUARD_TRIGGERED`（既有安全栈语义——"一个 safeguard 阻止了这次 promote"），与 funding 的 `INSUFFICIENT_BALANCE` 对称
- 现在 go-live 的三个问题都在 promote 这一步被回答：strategy 质量（v49 promote-check）+ 钱包付得起（v36 funding）+ 钱包被看住（v52 safety）
- 测试覆盖：`safetyReview.test.ts` +4 case（`safetyPromoteBlocker`：critical 无 USD 上限阻断含 fix / safety 关掉阻断 / warn-only 不阻断 / hardened 不阻断）；`strategy-tools.test.ts` +1 case（`playbook_promote` schema 暴露 `requireSafe` + 描述提及 SAFEGUARD/safety）。全 handler 路径**故意不驱动**（它会跑 funding preflight 触发 RPC，与 MCP 测试避网原则冲突）——gate 行为由纯 `safetyPromoteBlocker` 全覆盖
- 向后兼容：纯加法——无 schema migration、无现有行为改动（两个预检都 advisory 默认，不传 `--require-safe`/`requireSafe` 行为与升级前完全一致）；`--skip-preflight` 语义从"跳过 funding"扩展为"跳过两个预检"（既有用户拿到更多而非更少）
- v1 限制：安全态势是**全局/账户级** config，不是 per-playbook——promote 的是某个策略，但约束它的护栏是全局钱包配置，所以这里展示的是"你即将让这个策略动真钱，你的钱包整体被看住了吗"（语义正确但不区分策略）；blocker 只在 CRITICAL 触发，WARN（loose slippage / infinite approvals / 无 token 安全）靠运营商看打印的态势自行判断；CLI 交互流的 require-safe 阻断未做端到端测试（同 funding preflight 一样，纯逻辑层覆盖）

**Phase 51 — 安全态势审计（safety posture review — "what protects me, and what's wide open?"）** ✅
- 关闭整个安全栈的**易读性**缺口：经过 ~50 个迭代，safety 栈累积到 **19 层独立护栏**（per-tx/daily USD 上限、slippage 上限、token 白/黑名单、honeypot 自动探测、infinite-approval 阻断、approval USD 上限、gas 预算、交易限频、portfolio 权重限制、净敞口上限、per-strategy 预算、drawdown 熔断、human approval gate）。每层都单独文档化，但运营商把 AI agent 托付真钱前的**第一个问题**——"此刻究竟有什么在保护我，哪些危险口子是敞开的？"——**没有单一答案**。回答它意味着读十几个嵌套 config key，**并且**得知道哪些缺失是无害的（gas 预算关着）vs 灾难性的（根本没有 USD 上限）。这个判断以前只活在维护者脑子里
- 新模块 `safetyReview.ts`（~360 行）：纯函数 `reviewSafety(config)`，两半结构
  - **guardrails[]**：每一层护栏，`active | off | partial` + 渲染出的配置值——"什么在保护我"的清单（运营商看到的是完整态势，不只是缺口）
  - **gaps[]**：真正要紧的缺失，每条带 `severity`（critical | warn | info）**反映对 agent 部署的真实风险** + **关闭它的精确 config 命令**——"哪里敞开着"的审计
- 严重度编码（文档化常量，这是核心价值——把"哪些缺失危险"变成代码）：
  - **CRITICAL**：`safety.enabled=false`（整个栈被绕过）/ perTx **且** daily USD 上限都没设（"一笔 agent 交易、或一个失控循环可以花掉无上限的资金"）
  - **WARN**：slippage 上限 ≥ 10%（sandwich/illiquid 敞口）/ `allowInfiniteApprovals=true`（"恶意 spender 能抽干整个余额，不只一笔"）/ 无 token 白名单**且**无黑名单**且** honeypot 探测关着（"agent 能交易任意 token，包括 scam/honeypot"）
  - **INFO**：无 approval USD 上限 / 无 gas 预算 / 无限频 / 无敞口上限 / 无 drawdown 熔断 / 无 human approval gate（自主部署的合法选择，但值得让运营商看见）
  - 智能降级：honeypot 探测开着但无名单 → token-safety 从 warn 降到 info（探测仍拦截 honeypot）
- Verdict：任意 critical → `exposed`；否则任意 warn → `moderate`；否则 `hardened`。counts 给出 critical/warn/info 缺口数 + active/total 护栏数
- 纯 + 确定性：只读 config，无 IO、无时钟（除注入的 generatedAt 戳）。适合 agent **自检**——读取约束自己交易的那些护栏，安全无副作用
- Surfaces：CLI `tradekit safety review [--json]`（清单 + 按严重度分组的缺口 + 每条 fix 命令）+ MCP `safety_review`（无参只读，agent 在晋升真钱前确认自己被约束）
- 测试覆盖：`safetyReview.test.ts` 14 case——三档 verdict（exposed via 无 USD 上限 / exposed via master off / moderate / hardened）+ USD 上限 critical 清除 + token-safety warn→info 降级 + 白名单清除缺口 + infinite-approval warn + 6 条 info 缺口各带 fix + counts 一致性 + 渲染
- MCP_TOOLS 不变量：`safety_review` 加入 iter589/iter877 set（security-tools）
- 向后兼容：纯加法——无 schema migration、无现有行为改动、无引擎触动；纯读现有 config。它让既有的安全投资**可审计、可读**，而不是再加一层护栏
- v1 限制：基于 config 的静态审计——不查运行时状态（drawdown 是否已 tripped 看 `safety drawdown`；今日已用 USD 看 health）；token-safety 缺口不区分"agent 实际只交易白名单内"——它评估的是**配置授予的能力面**，不是观测到的行为；approval gate 关着记为 info（自主交易是合法部署模式），运营商按真钱与否自行判断其分量

**Phase 50 — 晋升结果复盘（promote outcome — "did the promote deliver?"）** ✅
- 闭合信任管道的**反向**缺口：v49 promote-check 是**前瞻**的（"这个 paper 策略准备好上真钱了吗？"），但晋升之后**没有任何东西**回答"晋升究竟兑现了 paper 承诺的东西吗？"。运营商/agent 无法发现整个管道存在的意义所要防的那个最危险结局——一个 paper 上看着很美、上线后悄悄亏钱的策略。`deploy --paper` → `promote-check` → `promote --to real` 这条链一直缺最后一环：上线后的回头验证
- 关键洞察：两个时代的成交**已经**带同一个 strategy tag 分表存好了——`paper_trades` 是为晋升背书的**冻结基线**（晋升把 primitives 翻成 real 后 paper 表停止增长），`trades` 是上线以来的真实成交。无需新迁移、无需晋升时间戳：表本身就是时代分割线
- 新模块 `promoteOutcome.ts`（~360 行）：
  - 两个时代跑**同一个**成本基准 walker（`computePaperPnlMtm` via 导出的 `toMtmRows`）→ realized PnL 是 apples-to-apples 的；real 成交通过 `toMtmRows` 适配进 paper walker 的行形状
  - **归一化对比**：per-fill realized PnL + per-week cadence——50 笔的 paper run 和 6 笔的 live run 公平比较，而不是误导性的原始总额
  - 三段证据：`OutcomeEra`（fills/spanDays/fillsPerWeek/realized/perFill/中位 slippage/gas）× paper + real；`comparison`（per-fill ratio / cadence ratio / slippage ratio + `hasRealizedSignal`）
- Verdict（文档化常量阈值，reasons[] 点名每条）：
  - **insufficient_data**——无 live 成交（"还没上真钱，先 promote 或等首笔 live 成交"）/ < `MIN_REAL_FILLS`(3)（"太早，多跑几笔再看"）/ 无 paper 基线（"从没跑过 paper，没有可对比的对象"）
  - **diverged**——paper realized > 0 但 live 每笔 realize ≤ 0（"真实执行下这策略不赚钱"）
  - **underperforming**——live 每笔 realized < paper 的 60%（`UNDERPERFORM_RATIO_PCT`）/ live 中位 slippage > paper 假设的 1.5×（`SLIPPAGE_DIVERGENCE_RATIO`）/ live cadence < paper 的 50%（`CADENCE_CAUTION_PCT`，且 live runtime ≥ 2 天才采信，防小样本噪音）
  - **on_track**——零 flag
- 确定性 + 离线：verdict 只 key off realized PnL（闭合的 round-trip，无需 oracle）、live 成交**自己**的 realized slippage + gas、cadence——**绝不**依赖 unrealized marks。MTM 总额仅作上下文展示。`markPriceFn` 注入 seam（测试用确定 fetcher；生产用 defaultPaperPriceFetcher，且只在未注入时才创建文件 logger，保持测试纯净离线）
- 诚实降级：paper 从未平仓（只买没卖、realized=0）→ `hasRealizedSignal=false`，PnL 对比作废、verdict 改由 execution quality + cadence 决定并明说；缺 nativeUsd → gas 退化为 native 单位、不伪造 USD 投影
- Surfaces：CLI `tradekit playbook outcome <id> [--json]`（best-effort native price 表达 USD gas）+ MCP `playbook_outcome`（agent 自动化晋升后监控同款查询）
- 测试覆盖：`promoteOutcome.test.ts` 12 case——三类 insufficient_data + INVALID_PARAMS + on_track 零 flag + diverged + underperforming（per-fill / slippage）+ paper 未平仓降级 + 归一化（per-fill/per-week 而非原始总额）+ gas USD/native 降级 + 渲染
- MCP_TOOLS 不变量：`playbook_outcome` 加入 iter589/iter877 set（strategy-tools 注册数 16 → 17）；导出 `toMtmRows`（原 strategyReport 私有）作为两条路径共享的 walker 适配器
- 向后兼容：纯加法——无 schema migration、无现有 CLI/MCP 行为改动、无引擎路径触动；现有部署直接升级拿到能力。`promote-check`（前瞻）+ `outcome`（回顾）现在对称地夹住 `promote` 这一步
- v1 限制：时代分割完全靠"paper_trades vs trades 同 tag"——若运营商在晋升后又 demote 回 paper（`promote --to paper`），新的 paper 成交会混进基线（v2 可加显式 promote 时间戳列做精确切窗）；cadence 对比对固定 cron 的 DCA 意义不大（paper/real 同频），主要服务阈值触发型策略；realized 对比只覆盖稳定币计价的闭合 round-trip（与 walker 同约定）

**Phase 41 — 并发 worker tick（per-round concurrent dispatch）** ✅
- 解决 iter33 留下来的真实生产瓶颈：pre-iter41 engine supervisor 的 worker loop 是**严格顺序**的 — `for (const worker of workers) { if (due) await worker.tick(); }`。`orders` worker 在慢 RPC 上 tick 30s，`schedules` worker 就算 interval 到了也得等 30s 才能跑。iter33 加了 per-worker backoff 应对**重复失败**，但**正常缓慢**还是 N×SUM 而不是 MAX
- 真实场景：5+ deployed strategies + 20 active orders + 多 chain（每 chain 自己的 RPC 延迟）+ 6 个 workers（orders/schedules/reconcile/rebalance/alerts/db_maintenance）顺序运行 = wall-clock 是所有 due workers tick 时间之和。对于慢 RPC tier 的运营商，吞吐量惩罚是数倍级的
- 选择 **per-round Promise.all** 架构而非 **per-worker 独立 async loop**：
  - per-round 保留 supervisor 主循环结构 + maxTicks rounds 语义 + 现有测试不变
  - per-worker async loop 是更彻底的方案但需要重写测试 + 处理 status file 写并发 + 重新设计 heartbeat 协调
  - 当前最大瓶颈是"一个 round 内 N 个 due workers 串行执行"，per-round Promise.all 直接解决：wall-clock = MAX(tick durations) 而非 SUM
- engine.ts 重构：抽取 `tickOneWorker(worker)` 函数（~150 行 — 包含 health state 更新、transition 通知、status 行更新、dueAt 重计算）。supervisor 主循环改为：
  ```ts
  const dueWorkers = workers.filter((w) => (dueAt.get(w.name) ?? 0) <= t);
  if (dueWorkers.length > 0) {
    firedThisRound = true;
    await Promise.all(dueWorkers.map((worker) => tickOneWorker(worker)));
  }
  ```
- 并发安全性分析（why this is safe）：
  - **per-worker status row 写入**：每个 worker 只通过 name lookup 写自己的 row (`status.workers.find((w) => w.name === worker.name)`) — 无跨 worker 碰撞
  - **per-worker health state**：`healthStates: Map<string, WorkerHealthState>` — 每个 key 由一个 worker 写
  - **per-worker dueAt**：同款 Map — 一写一读，写都是各自的 key
  - **notification + engine_events 写**：tryNotify 内部已有 dedup window + queue（iter28+），insertEngineEvent 是 safeRecord wrapper（iter39）— 都是 async-safe
  - **SQLite 并发**：iter611 设置的 busy_timeout=5000ms 处理 writer-vs-writer 竞争
  - **worker.tick 互相不调用**：不可能 deadlock-via-recursion
- 副产品：iter202 的 `StatusWriter` 类（debounced status file writer with coalescing）作为 stand-alone 工具完成 — 当前 supervisor 仍然在 round 结束统一写一次（保留现状），但未来如果走 full per-worker async loop 路径，StatusWriter 可以直接 drop in 处理并发写。9 个独立单元测试覆盖（snapshot getter / 写合并 / zero debounce 同步路径 / flush / stop / writeFn 错误容忍 / snapshotFn 错误容忍）
- engine.test.ts 加 3 个并发行为 case：
  - **wall-clock ≈ MAX**：两个 200ms worker 同 round 触发 → 总耗时 < 380ms（不是 400ms 序列）+ 两个 tick start 时戳差距 < 50ms
  - **slow 不阻塞 status 更新**：fast (10ms) + slow (150ms) 同 round → 两个 status row 都被更新为 ticks=1
  - **抛错的 worker 不阻塞其他 worker**：synchronous throw 的 worker 通过 catch 转 ok:false + 兄弟 worker 继续 tick
- 27 个现有 engine test **完全不变**通过（包括 multi-round scheduling with fake clock + worker resilience transitions + 状态文件结构）— 重构是 backward-compatible 的根本证据
- 向后兼容：
  - **maxTicks 语义不变**：rounds count，per-tick semantics 在 round 内并行化不影响外层计数
  - **status file shape 不变**：concurrent ticks 写 own row 不改变结构；round 结束统一序列化 + 写
  - **现有 worker tick 接口零改动**：只是从 sequential await 改为 Promise.all dispatch
  - **观察性零损失**：所有 engine_events / notifications / health state transitions 仍然 emit
- 不变量保护：
  - **single status writer**：尽管 ticks 并发，status file 仍然只有 supervisor 主循环写（round 结束）— 读 status file 的 client 不可能看到中间态
  - **iter33 health state 的 update is per-worker**：单个 worker 的 tick 完成才更新自己的 health state — Promise.all 不会让某 worker 看到另一 worker 的中间 health
  - **per-worker dueAt 计算独立**：每个 tickOneWorker 内部计算自己的 nextDue + 写入自己的 dueAt slot — 无 cross-pollination
- v1 限制 / 留 v2：
  - **没有跨 round 并发**：round 仍然是 sync boundary — 下个 round 必须等所有 due workers 完成。极慢的 single worker (e.g. 多 chain reconcile 60s+) 仍会拖慢主循环 sleep 计算。完整的 per-worker async loop（每个 worker 自己的 setInterval 循环）是 v2 方向 — 改动面更大但消除 round boundary
  - **status writer 是预备工具**：iter202 的 StatusWriter 在 iter41 没被 supervisor 实际使用（per-round 模型下旧的 sync writeStatus 仍然够用）— 它存在为 v2 per-worker loop 的预先工具准备好

**Phase 40 — DB 生命周期自动化（integrity / retention / auto-backup）** ✅
- 关闭长期运行部署的最后一个核心运维缺口：iter28+ 累积 12+ 个新写入路径（paper_trades、alert_state、engine_events、order_check_log、...）后，SQLite 文件本身变成高价值积累资产 — 但 pre-iter40
  - 没有保留策略：每个表无限增长，1 年部署可累积 500K+ audit_log + 100K+ order_check_log
  - 没有完整性检查：SQLite corruption（罕见但真实）静默直到 query 失败
  - 没有自动备份：`tradekit backup export` 需要运营商手动触发记得跑
- 三个独立可启用的能力，全部默认 disabled（向后零行为变化）：
  1. **Integrity check** — wraps `PRAGMA integrity_check`，typed `IntegrityCheckResult` 含 ok/durationMs/errorCount/errors。CLI / engine worker / MCP 共享一个 source of truth。失败时由 db_maintenance worker 记录 iter39 `db.integrity_failed` engine event (severity=critical)
  2. **Retention prune** — per-table 配置 cutoff days（auditLogDays / paperTradesDays / orderCheckLogDays / engineEventsDays / failedTradesDays），保守的 conservative 默认（全部 NULL = 永不 prune，运营商必须显式启用每条）。**成功 trades 绝对不动** — 是税务关键记录；只 prune `failed`/`reverted` 终态 + 显式启用时
  3. **Auto-backup** — atomic SQLite copy via `VACUUM INTO`（不需要手动 WAL checkpoint，无半写文件风险）；时间戳文件名 + FIFO rotation 保留最近 N
- 新模块 `dbLifecycle.ts`（~470 行）— 5 个纯/纯-ish helper：
  - `runIntegrityCheck()` → `IntegrityCheckResult`（包含 errors[] + durationMs + checkedAt ISO）
  - `pruneByRetention(config, opts)` → `PruneReport`（per-table outcome：ran/skipped + cutoffIso + rowsRemoved + reason）— 通过 `RETENTION_TABLES` 元数据数组配置，添加新可保留表 = 一条 entry
  - `createBackup(destPath)` → `BackupResult`（VACUUM INTO + size + duration + error）；拒绝覆盖已存在的 dest（防意外覆盖；engine 自动备份用 timestamped names 因此 collision 不可能）；relative paths 相对 DATA_DIR resolve
  - `rotateBackups(dir, retainCount)` → `RotateBackupsResult`（按 mtime 排序 newest-first 删除超出 retain 的；`.db` 扩展名过滤忽略目录里的非备份文件）
  - `autoBackup(config)` 组合 createBackup + rotateBackups，timestamped filename `tradekit-YYYYMMDDHHMMSS.db`
  - `readDbStats({ config })` → `DbStatsReport`（DbFileStats + retentionPreview 不执行 DELETE）
- 新模块 `dbMaintenance.ts`（~150 行）— engine 端 orchestrator
  - per-subtask 内部 cadence 跟踪（lastIntegrityCheckAt / lastBackupAt，per-process state）
  - integrityCheck.intervalHours 默认 24，backup.intervalHours 默认 24（daily），retention 每 tick 执行（idempotent + 失败为 0 时 cheap）
  - 每个 subtask 包在独立 try/catch — 一个失败不阻止其他；每个失败/成功 emit iter39 engine_event（`db.integrity_failed` / `db.prune_failed` / `db.backup_failed` / `db.backup_ok`）— operator 在 `tradekit engine events` 看到全部历史
- db.ts 加 4 个 prune helpers + `getDbFileStats`：
  - `pruneOldAuditBefore(beforeIso)` — audit_log 是最高基数表，operator with 90/180-day 合规要求获得明显磁盘节省
  - `pruneOldPaperTradesBefore` — paper data ephemeral by design
  - `pruneTerminalTradesBefore` — **只** prune `status IN ('failed', 'reverted')`（保护 successful trades 用于税务）
  - `getDbFileStats()` — main + WAL + SHM size + 每个 interesting table 的 row count（用 `try/catch` 处理 pre-migration 表缺失）
- Config 新 schema `db: { retention, backup, integrityCheck }`：
  - 每条 sub-config 默认 enabled=false，operator opt in
  - retention.{auditLogDays, paperTradesDays, orderCheckLogDays, engineEventsDays, failedTradesDays} 默认 NULL — 即使 enabled=true 也得显式配置 days 才会动那张表（防止"启用没读文档导致误删"）
  - backup.{intervalHours: 24, destDir: "backups", retainCount: 7} 默认每日 7 份滚动
- Engine worker `db_maintenance` 加入 iter33 supervisor — 6th built-in worker。default enabled=false（向后兼容），interval 1h covers most cadences。`READ_ONLY_WORKERS` 集合加 `db_maintenance` — 不需要 password，可以 stand-alone `--workers db_maintenance` 跑
- 新 CLI `tradekit db <action>`：5 subactions
  - `db stats` — 行数 + 文件大小 + retention preview，heaviest-tables-first 排序
  - `db integrity-check` — 包 PRAGMA + exit 1 on corruption（cron-friendly 健康闸）
  - `db prune [--dry-run]` — `--dry-run` 复用 readDbStats 的 preview path（不调 DELETE 完全安全）；真实执行调 pruneByRetention
  - `db backup [--dest PATH]` — 手动备份，default timestamped file in DATA_DIR
  - `db rotate [--retain N]` — 应用 rotation policy
- 新 MCP 工具 `db_stats` + `db_integrity_check`（agent 可调度的 DB 健康监控）
- 测试覆盖：`dbLifecycle.test.ts` 20 case
  - runIntegrityCheck on clean DB
  - pruneByRetention disabled / per-table unset / cutoff 应用 / 多表协同 / window 内行**不**动 / order_check_log 集成
  - createBackup VACUUM INTO + DATA_DIR relative paths + 拒绝覆盖 + 创建父目录
  - rotateBackups by mtime + 忽略非 .db 文件 + 不存在目录处理
  - autoBackup 组合 + 失败路径（permission denied dest）
  - readDbStats + retentionPreview enabled/disabled
- MCP_TOOLS 不变量：`db_stats` + `db_integrity_check` 加入 iter589/iter877 set
- 向后兼容：
  - 既有 `tradekit backup export` (encrypted multi-asset) 完全不变 — 用于 disaster recovery 跨主机迁移
  - 新的 `db backup` 是 SQLite-only atomic snapshot — 用于 auto-backup 路径 + 同主机快速回滚
  - 全部 db.* 配置默认 disabled — existing deployments 升级零行为变化
  - 现有 retention helper `pruneOrderCheckLog` (iter25) 被复用为 dbLifecycle 的 RETENTION_TABLES 条目之一
- 不变量保护：
  - **conservative 默认**：`db.retention.enabled` AND per-table days 都得显式配置 — "我刚启用没看文档"不会导致数据丢失
  - **成功 trades 永远不动**：`pruneTerminalTradesBefore` 的 WHERE 子句锁定 `status IN ('failed', 'reverted')`；要 prune successes 必须直 SQL
  - **VACUUM INTO atomicity**：SQLite primitive 保证备份文件要么完整要么不存在 — 没有半写状态可以坑运营商
  - **subtask isolation**：integrity 失败不影响 retention 执行；retention 失败不影响 backup；每个失败独立 emit engine event
  - **engine_event 持久化**：iter39 表存 db.* 事件 — operator 一周后查"什么时候 backup 失败过"在 `tradekit engine events --types db.backup_failed` 找到
- v1 限制：retention windows 是基于 `timestamp` 列的简单比较 — 没有"keep N most recent regardless of age" 选项（运营商现在写"keep last 30 days"，未来 v2 可加"keep last 1000 rows"）；backup 用 VACUUM INTO 是单文件 atomic — 没有 incremental backup（运营商带 retain=7 实际上每天一份完整复制，对 < 1GB DB 完全 OK）；auto-prune 不去重已被 backup 的旧数据（运营商手动协调或用外部 retention policy 做 lifecycle）

**Phase 39 — 引擎事件表（durable engine state transitions）** ✅
- 关闭 iter36 timeline 留下的最后一个 heuristic 漏洞：engine lifecycle / worker resilience / config reload 三类核心引擎状态转换 pre-iter39 只有 transient notifications（iter28 onwards）— 进程重启就丢，operator 答不出"上周一我的 engine 重启了几次？""orders worker 这个月 degraded 了多少次？""3 天前是谁 reload 的 config，影响了什么？"
- iter36 timeline 用 audit_log heuristics 解决了一部分（engine.lock/unlock 通过 audit_log tool 字段可以识别），但 worker.degraded/recovered + config.reloaded/reload_failed **完全没有 DB trail** — 它们直接走 notify 通道
- 新 v26 迁移 `engine_events` 表 — 单表持久化全部 8 种事件类型：
  - **engine.started** / **engine.stopped**（lifecycle）
  - **engine.lock** / **engine.unlock**（iter28 kill switch）
  - **worker.degraded** / **worker.recovered**（iter33 resilience transitions）
  - **config.reloaded** / **config.reload_failed**（iter35 hot-reload）
  - 故意**不**持久化 heartbeats（高基数 — 每小时 1 个 × 8760 小时/年 = 8760 行只为活性检查；operator 用 `engine status` 看活性）
- 列设计：`id` / `timestamp` / `event_type` / `severity` / `pid`（写入进程 pid）/ `worker_name`（仅 worker.* 事件）/ `fields_json`（事件 type-specific structured payload）/ `dedup_key`（mirror notification dedupKey，operator 可以 cross-reference Slack ↔ DB）
- 2 个索引：`(timestamp DESC)` 用于 timeline 倒序查询、`(event_type, timestamp)` 用于按类型过滤的 forensic 查询
- 新模块 `engineEvents.ts`（~280 行）：8 个 typed 构造器
  - 每个构造器一个特定 args interface（如 `RecordEngineStartedArgs`、`RecordWorkerDegradedArgs`）— 编译期保证 payload 形状 + severity 符合该事件类型的约定
  - 全部走 **error-safe `safeRecord` wrapper**：DB insert 失败 → 吞掉 + `logger.warn`，**绝不**让 engine 关键路径（特别是 `engine.stopped` 写入）因为 DB hiccup 而 cascade 崩溃
  - dedup_key 镜像 iter28+ notification dedup 模式 — `engine.worker.degraded:<worker>`、`engine.worker.recovered:<worker>:<hour-bucket>`、`config.reloaded:<pid>:<minute-bucket>` — operator 拿 dedupKey 可以 join notification 历史 + DB 表
- 集成点 — 每个调用站点 **双写**（保留现有 tryNotify + 新增 recordX）：
  - `engine.ts`：supervisor 启动后 `recordEngineStarted`；shutdown 时 `recordEngineStopped`（fatal=非 null → severity=critical）；iter33 worker transition `entered_backoff` → `recordWorkerDegraded`，`recovered` → `recordWorkerRecovered`
  - `engineLock.ts`：`lockEngine` 转换检测后 → `recordEngineLock`；`unlockEngine` → `recordEngineUnlock`（带 pairedLockedAt 让 timeline 配对 lock/unlock pair）
  - `configReload.ts`：成功 reload → `recordConfigReloaded`（severity 按 critical/warn/info count 派生 — 镜像 iter35 notification 规则）；schema parse 失败 → `recordConfigReloadFailed`
- Timeline 集成：`timeline.ts` 新增 `collectEngineEvents` source，从 v26 表直读，**替换 iter36 的 audit_log heuristic**（exact data, no inference）。EventKind union 扩展 8 个新值；EventRefs 加 `workerName` + `pid` 字段给 engine 事件用
- `summarizeEngineEvent` 为每种事件类型渲染紧凑一行：
  ```
  · 2026-05-31 12:00:00Z engine.started      pid=12345 workers=orders,schedules,reconcile,rebalance,alerts
  ⚠ 2026-05-31 13:15:30Z worker.degraded     [orders] consecutive=3 effective=60000ms
  · 2026-05-31 13:18:45Z worker.recovered    [orders] after=3 fails
  ⚠ 2026-05-31 13:30:00Z engine.lock         locked by cli: investigation
  · 2026-05-31 14:00:00Z engine.unlock       unlocked by cli
  ⚠ 2026-05-31 14:30:00Z config.reloaded     diff=5 critical=2 warn=1
  · 2026-05-31 14:31:00Z engine.stopped      uptime=9000s
  ```
- 新 CLI `tradekit engine events [--since 24h|ISO] [--until ISO] [--types engine.started,worker.degraded,...] [--severity ...] [--worker NAME] [--limit N] [--json]`
  - Default window 24h — 比 timeline 默认的 4h 长，因为 engine events 频率低（5+ workers × 几个 transition / 天）
  - `--types` 多选过滤（CSV）— 内部一次大查询 + post-filter（DB 助手按设计接受 single type 或 prefix；多个时在 memory 过滤）
  - `--worker` 过滤 worker.* 事件
  - `--severity` floor，与 timeline 同款
  - 文本输出有 critical/warn/info badge + worker name + 紧凑 per-event summary
- 新 MCP 工具 `engine_events` 在 observability-tools.ts — mirror CLI 表面，agent 自动化 incident response 同款查询
- 测试覆盖：`engineEvents.test.ts` 19 case
  - 每个 8 typed 构造器（lifecycle / lock / unlock / worker degrade-recover / config reload-fail）的 payload 形状 + severity + dedup_key 模式 + JSON.parse roundtrip
  - listEngineEvents 过滤：event_type prefix / minSeverity floor / workerName / pid / window
  - pruneEngineEvents retention
  - safe-record 错误容忍：mocked insertEngineEvent 抛错时构造器**不**抛 + `logger.warn` 被调用 + 调用者无可见副作用
- MCP_TOOLS 不变量：`engine_events` 加入 iter589/iter877 set
- 向后兼容：纯加法 — v26 是 additive migration（CREATE TABLE IF NOT EXISTS），现有 audit_log / timeline 数据不变；现有 notifications 继续 fire，DB 持久化是 **side-by-side**（不替代），existing 监控 / Slack 集成无变化；iter36 timeline 在新表存在时优先用，对 pre-iter39 历史回退到 audit_log heuristic（虽然实际上新历史是 v26 表，旧表仍可读，所以两条路径不冲突）
- 不变量保护：
  - **error-safe writes**：safeRecord 把每个 insert 包在 try/catch 内 — DB hiccup during engine.stopped 写入不会 crash 关键 shutdown 路径
  - **side-by-side**：每个事件点 BOTH `await tryNotify` AND `recordX` — 即使 DB 完全坏掉，Slack 仍然收到通知（iter28 关注的运营商即时感知）；DB 持久化是历史 forensics 的补充
  - **dedup_key 一致性**：构造器内的 dedupKey 必须与对应 tryNotify 的 dedupKey **字符串完全一致** — 这是测试用 `expect(rows[0].dedup_key).toBe("engine.lock:...")` 验证的不变量；operator 拉 Slack history + 查 DB 时按 dedup_key join 找到的是同一逻辑事件
- v1 限制：heartbeat 不持久化（操作员可以加 retention job 后期增加，但 v1 保持轻量）；engine.start 自动 pid 写入，没有 hostname 字段（多主机部署可在 fields_json 中加 hostname，但 v1 单主机为主）；alert.fired / alert.resolved 仍然是 iter36 heuristic — engine_events 故意只覆盖**引擎本身**的事件，alert 是 per-strategy 域（v2 可加 alert_events 表）

**Phase 38 — 价格层批量化 + 提供商可观察性（batch price fetch + provider stats）** ✅
- 解决"5+ 部署策略时被 CoinGecko 免费档限流"的生产瓶颈：pre-iter38 的 price 层有 60s 缓存（iter132）和 in-flight Promise dedup（iter80），但在 cache-cold tick 上 N 个不同的 base token 仍然产生 N 个独立的 HTTP 调用。CoinGecko 免费档约 30 req/min，运营商 15 个不同 token × 30s tick = 30 req/min 已经在边缘，再加上 reconcile / alerts / strategy report worker 一起跑就超
- CoinGecko 的 `/simple/price?ids=...,...,...&vs_currencies=usd` 端点早就支持逗号分隔的 ID 批量查询 — 我们一直在单个查询。一次批量调用替换 N 次 = 数十倍的 API 调用减少 + 客户端 round-trip 减少
- 此外完全没有 per-provider 观察性：操作员被限流时无从知道 "是 CoinGecko 出问题还是 DexScreener" / "p95 延迟是多少" / "最近的错误码是 429 还是 5xx" → 盲调
- 三个互补的新模块：
  1. **`priceCacheShared.ts`**（小型模块）：把 iter80/iter132 的 `priceCache` / `priceInFlight` / TTL 常量 / `evictIfOverCap` 抽出到独立文件，让 `price.ts`（legacy 单 token 路径）和新 `priceBatch.ts`（batch 路径）共享 SAME 缓存而不会循环导入
  2. **`priceStats.ts`**（~250 行）：内存型 per-provider 计数器
     - 类型化 `ProviderCall`：ok / latencyMs / tokensRequested / tokensReturned / errorCode / partialError
     - `recordProviderCall(provider, call)` 累加 + 滑动窗口最近 50 个延迟样本
     - `getProviderStats()` snapshot：totalCalls / successes / failures / hitRate (tokensReturned / tokensRequested) / lastErrorCode / lastErrorAt / timing.{count, avgMs, p50Ms, p95Ms, maxMs} / observedSince / observedUntil
     - `classifyFetchError` 将原始 `Error` 归类到 8 种已知 code（HTTP_429 / HTTP_5xx / HTTP_4xx / TIMEOUT / NETWORK_ERROR / PARSE_ERROR / UNKNOWN_ERROR），同时检查 `Error.name` + `Error.message` 让 SyntaxError 这种把判别器放在 name 的特殊类正确分类
     - 边界设计：仅内存，进程重启清零。这是**可观察性辅助**不是审计 trail（per-call 持久化每个 ticker 价格调用会爆数据库）
  3. **`priceBatch.ts`**（~400 行）：新的批量入口 `getCurrentPrices(addresses[], logger)` → `Map<addrLower, price | null>`
     - Phase 1: cache 查找（共享 priceCache）→ hits 直接返回
     - Phase 2: 对 misses 做 in-flight Promise dedup（共享 priceInFlight）
     - Phase 3: 按 provider 分组 — 有 CoinGecko 映射的进 batch chunk（每 chunk ≤ 250 ids 防 URL 超长），无映射的直走 DexScreener
     - Phase 4: 并发 dispatch — CoinGecko chunks 并行 `Promise.all`，DexScreener fallback 用 `Promise.allSettled`；CoinGecko 失败的 token 自动 fallback 到 DexScreener
     - Phase 5: 每个调用都通过 `recordProviderCall` 报告 stats，batch 调用 tokensRequested=N，tokensReturned=有效返回 count
     - 单 token 包装 `getCurrentPriceBatched(token, logger)` 调 `getCurrentPrices([token])` — backward compat
- Engine 集成：`runOrderTick` 在迭代 active orders 之前调用 `getCurrentPrices(distinctTokens)` 预热缓存。15 个 unique tokens 的 cache-cold tick 现在是 **1 个 HTTP 调用**（CoinGecko batch），而不是 15 个串行调用。循环内的 per-order `getCurrentPrice` 现在是纯缓存命中
- Legacy `getCurrentPrice` 单 token 路径**不删**也**不改 API**：existing tests + 调用者继续工作；只是在 `priceFromCoinGecko` / `priceFromDexScreener` 内部加了 stat 记录调用 — both legacy and batch paths 喂同一个 stats map，stats 是 union
- 新 CLI `tradekit price stats [--reset] [--json]`：
  ```
  Price provider stats (in-memory, since process start):
    coingecko
      Calls:    47  (45 ok, 2 fail = 4.3%)
      Tokens:   210 returned / 230 requested  (91.3% hit rate)
      Latency:  avg 312ms · p50 280 · p95 1100 · max 2500  (last 47 samples)
      Last err: HTTP_429 at 2026-05-31T14:32:00Z
      Window:   2026-05-31T10:00:00Z → 2026-05-31T14:35:00Z
    dexscreener
      Calls:    18  (18 ok, 0 fail = 0.0%)
      Tokens:   14 returned / 18 requested  (77.8% hit rate)
      Latency:  avg 180ms · p50 150 · p95 380 · max 500  (last 18 samples)
  ```
- 新 MCP 工具 `price_stats` 在 observability-tools.ts，支持 `reset: true` 让 agent 做 delta-since-last-scrape 监控
- 测试覆盖：
  - `priceStats.test.ts` 24 case：recordProviderCall（创建 / 累加 / failure 路径 / tokensRequested 累加 / partialError 作为 lastErrorCode / per-provider 隔离）+ 滑动窗口（默认 50 + 自定义 size）+ summarizeTiming（empty / 全统计 / 单样本 / 未排序输入）+ getProviderStats（empty / multi-provider）+ reset（全部 / 单 provider）+ classifyFetchError（429 / 5xx / 4xx / TIMEOUT / NETWORK_ERROR / PARSE_ERROR / UNKNOWN_ERROR）+ observed window
  - `priceBatch.test.ts` 21 case：empty input / cache 命中跳过 HTTP / null cache 命中 / 缓存过期重 fetch / batch CoinGecko 单调用 / 地址 dedup 大小写不敏感 / CoinGecko 空响应触发 DexScreener fallback / CoinGecko throw → fallback + stat fail / DexScreener-only 路径 / DexScreener 并发 / DexScreener 返回 null / DexScreener throw / 混合 cache + fetch / 缓存填充 / stats 记录 CoinGecko batch / stats CoinGecko + DexScreener 独立 / fallback 流双 provider 调用 / single-token 包装 / result 完整性
- 不变量保护：
  - **共享缓存单一来源**：priceCacheShared 是 SoT — 改 TTL 时只一处。priceBatch 和 price 都读同一个 Map → 一个路径写的 cache，另一个路径下次直接命中
  - **stats 不阻塞 hot path**：recordProviderCall 是 in-memory 累加，没有 await、没有抛出。即使 stats 有 bug 也不会让 price 调用失败
  - **batch 失败容错**：单个 chunk 失败 → 该 chunk 的 tokens 自动落入 DexScreener fallback；fallback 也失败 → 返回 null + cache null（15s TTL 让下次 tick 重试）
- MCP_TOOLS 不变量：`price_stats` 加入 iter589/iter877 set
- 向后兼容：纯加法 — `getCurrentPrice` API 不变；现有 2400+ tests 全过；stats 是 additive 观察性；priceBatch 是新入口，未来 iter 可逐步迁移其他调用点（schedule worker / strategy report / web 等）
- v1 限制：DexScreener 没有 batch endpoint，无法真正合并 — fallback 仍然是 per-token，靠 `Promise.allSettled` 并发拉低 wall-clock；stats 是 in-memory only — 进程重启清零（生产部署应该用 Prometheus 等外部 scrape 做持久化）；CoinGecko 250-id chunk 上限是保守估计，真实上限更高但 250 保证 URL ≤ 5KB

**Phase 37 — 批量操作（scoped bulk halt/resume）** ✅
- 关闭"事故响应粒度"中间层：iter28 engine lock 是全局 kill switch（太广 — 暂停一切，影响所有策略），per-primitive `order cancel` / `schedule pause` / `rebalance pause` 是单粒度（太细 — 30 个 primitives 时操作员要敲 30 条命令 + 跨 3 类原语手工跑）。"halt 与策略 X 相关的所有东西"今天必须用 jq + xargs，N 个 audit_log 行 + N 个通知 + 任意中途失败留半成品状态
- 新模块 `bulkOps.ts`（~480 行）：plan/execute 分层
  - **`planHalt(filter)`**：纯 DB 读 + 分类。返回 typed `BulkHaltPlan` 含每个 primitive 的 `operation: cancel | pause | skip` 分类 + reason field + summary 计数。已 terminal 的 primitives 被分类为 `skip` 带原因（`already filled` / `already paused`），**不**会被错误地标记为"应该 halt 但失败了"
  - **`executeHalt(plan)`**：在单个 SQLite BEGIN/COMMIT 内执行 plan。每行通过现有的 `cancelOrderById` / `pauseScheduleById` / `pauseRebalancePlanById` helper — 它们的 validation + race detection 全部被继承。Per-row failures 被收集（不抛），剩余的成功操作继续 — 一个 30-primitive halt 中途某行被 engine 并发翻 terminal 不会回滚另外 29 个成功的操作
  - **`planResume / executeResume`**：对称操作，但显式拒绝 `orders` types — cancelled orders 是 terminal 状态不能复活，`types: ["orders"]` 会抛 INVALID_PARAMS 提示运营商用 `order create` 或 `playbook replace`
- 安全要求：必须至少指定一个 scope（`--strategy` / `--chain` / `--account`），否则强制 `--all` flag 让"halt 一切"成为明确意图。无 scope + 无 --all 抛 INVALID_PARAMS。真正的全局 kill switch 仍然是 iter28 engine_lock — 通过这个 scope 要求两个原语**故意**不重合
- 三类合并的写时统一性：halt orders → cancel（terminal）；halt schedules → pause（reversible）；halt rebalances → pause（reversible）。**Resume** 只 un-pause schedules + rebalances；cancelled orders 不能恢复 — 强制操作员重新走 `order create` / `playbook replace` 路径
- **One bulk notification vs N**：操作员 halt 12 个 primitives 时 Slack/Discord 只看到一行 `Bulk halt: 12 primitive(s) — strategy=dca-eth`，**不是** 12 行 per-primitive 取消通知（per-primitive cancel/pause helpers 现在就不发通知，audit_log 行 是 forensic trail）。运营商的事故响应不会自己 spam Slack
- 通知 dedupKey 含 ISO 时戳到秒（不到毫秒）：两个 halt 在同一秒内只发一个 notify — 防误触发的 double-fire；不同秒的 halt 互不影响 dedup
- CLI surface 完整三种交互模式：
  - 无 flag：打印 plan 预览 + 提示 `Type 'halt' to confirm`（typed confirmation，类似 iter28 的 destructive 操作模式）
  - `--dry-run`：纯预览，**不**执行，**不**提示
  - `--yes`：跳过确认（脚本 friendly）
  - `--json`：machine mode，跳过确认，输出 `{ ok, plan, applied, skipped, errors, errorDetails }`
- Plan 文本渲染分组 by primitive type：
```
Bulk halt plan: strategy=dca-eth
  Would affect 12 primitive(s):
    orders     to cancel: 8
    schedules  to pause:  3
    rebalances to pause:  1
  Skipped (already terminal): 2
    already filled: 2

  orders:
    ✕ cancel  #42    SELL 1 ETH/USDC  ≤ $1900  (active → cancel)
    ✕ cancel  #43    SELL 1 ETH/USDC  ≥ $3000  (active → cancel)
    ...
  schedules:
    ⏸ pause   #5     BUY 100 ETH/USDC  @ 0 10 * * *  (active → pause)
    ...
```
- 新 MCP 工具 `bulk_halt` + `bulk_resume`（admin-tools.ts）：mirror CLI surface — agent 做 incident response 自动化时同样的 plan+execute 两阶段。MCP 路径默认 `dryRun=false` 但 agent 实践应该先 dryRun + 检查 plan 再 confirm — 这是与 CLI 互动模式同款的安全模式
- 测试覆盖：`bulkOps.test.ts` 27 个 case
  - filter validation（unscoped 拒绝 + --all 接受 + 单 scope 接受 / orders in resume types 拒绝）
  - plan 分类：active order → cancel / filled order → skip with reason / active schedule → pause / already-paused schedule → skip / active rebalance → pause / --types 过滤 / 三类组合 / chain 过滤 / account 过滤 / chain lowercase 归一化 / skippedReasons 聚合 / --all 全局
  - planResume：paused → resume / active → skip with reason / paused rebalance → resume
  - executeHalt end-to-end：cancel + pause + pause atomicly / 跳过已 terminal / 收集 per-row errors 不中断批 / multi-strategy 仅 matching 受影响 / --types orders only 不动其他
  - executeResume：paused → active / already active → skip
  - idempotency：halt 两次 second is safe no-op（27 个 case）
- MCP_TOOLS 不变量：`bulk_halt` + `bulk_resume` 加入 iter589/iter877 set
- 向后兼容：纯加法 — 无 schema migration，无现有 CLI/MCP 行为改动，无现有引擎路径触动；现有部署直接升级拿到能力。Per-primitive `order cancel` / `schedule pause` 继续工作；iter28 engine_lock 继续是真正的全局 kill switch
- 不变量保护：
  - **plan/execute 分离**：planner 是纯函数，executor 是 effectful — 测试 planner 完全不需要 mock DB writes；CI 在 dry-run mode 可以验证 plan 不触发 mutations
  - **at-least-one-scope 强制**：`requireScope` 在 planner 入口检查 — execute 不可能在 unscoped state 下被调用（plan 阶段已经抛错）
  - **atomic at row level + bounded at batch level**：SQLite 默认 implicit transaction 保证每行 atomic；外层 BEGIN/COMMIT 让所有 audit_log 行批量落 — 操作员按 timestamp 查 audit 看到一个 bulk burst 而不是 30 个 staggered 行
- v1 限制：plan→execute 之间有一个 race window — plan 看到 row 是 active，execute 时 engine 可能已经把它翻成 filled。这时 executor 收集 per-row error 不阻断批；操作员看到 errors 列表知道某些行实际被 engine 抢了。v2 可以加 `WHERE id=? AND status=?` 防止 race，但当前实现下 audit trail 已经清晰展示"谁碰过哪一行"故 v1 acceptable

**Phase 36 — 取证时间线（unified forensic timeline）** ✅
- 完成观察性三脚架的第三条腿：iter31 strategy report 解决"this strategy 现在怎么样"（状态中心、单策略）；iter32 strategy alerts 解决"X 出问题了告诉我"（推送、阈值驱动）；iter36 timeline 解决"13:55 到 14:05 之间发生了什么"（时间中心、跨策略）
- 真实运营痛点关闭：事故发生时运营商今天必须跑 6+ 个命令（`trades --status failed`、`viewTx`、`order list --status failed`、`order replay <id>` 逐个、`audit --since 1h`、`strategy alerts list --active-only`）然后**手动按时间戳合并**才能拼出事件全貌。iter36 一条命令搞定，所有源已经在表里就差合并器
- 新模块 `timeline.ts`（~520 行）：
  - 类型化 `TimelineEvent`：`at` / `kind`（10 种判别 union 成员）/ `severity` / `summary` / `refs`（type + id + 反规范化的 chain/account/strategy/txHash）/ optional `details`
  - 5 个独立 per-source collector：`collectTradeEvents` / `collectPaperEvents` / `collectAuditEvents` / `collectJournalEvents` / `collectAlertEvents` — 每个纯函数 take rows + filter + window → events
  - 主 entry `collectTimeline(args)`：解析窗口 → 查 5 个源（注入测试 seam）→ 合并 + 全局排序（时间倒序 + tiebreak）→ 全局 limit truncate
  - 严重等级派生从源数据：trade.failure → critical，trade.fill → info；audit error_code 非空 → critical，engine_lock/revoke 等"elevated tool" → warn，其余 → info；order journal 的 `error` → critical，`triggered_fired` / `near_threshold` → warn；alert.fired 依规则 type 映射（drawdown_threshold / failure_streak → critical）
  - `resolveWindow` 默认 since=now-4h、until=now；`parseSinceDuration` 接受 `4h` / `30m` / `2d` / `1w` 或 ISO timestamp
- 与 iter31 strategy report 的 activity section 故意不冲突：iter31 activity 是 per-strategy 分组的（recentFills / recentFailures / recentJournal）；iter36 timeline 是 FLAT 时间倒序、跨策略合并的。两个 consumer 不同 — strategy report 回答"这条策略在做什么"，timeline 回答"这个时间窗里所有策略发生了什么"
- 解析 alert.fired vs alert.resolved 的巧妙之处：`strategy_alert_state` 表只有当前状态行，没有事件流。但 iter32 设计时刻意持久化了 `first_triggered_at`（fired 时戳）+ `last_evaluated_at`（reconciler 最近一次评估时戳，**包括 resolve 写**）。所以：
  - 行 active=1 且 first_triggered_at 落在窗口内 → 这是一个 fired event
  - 行 active=0 且 last_value_json 非 null 且 last_evaluated_at 在窗口内 → 这是一个 resolved event（reconciler 在 resolve 写时保留 last_value_json 让我们识别"这行最近被解除过"）
  - 这是个 best-effort heuristic — v2 可以加 explicit `alert_events` table 让 resolution 时戳 100% 精确，但现状用零迁移成本拿到 95% 准确度的解析
- Journal 源的过滤策略：`tracking_started` 和 `hwm_advanced` 是 iter25 的 "engine 决定" 但运营性意义低（4h 窗口里一条 trailing 订单可能产生 N 条 hwm_advanced），故 timeline 默认**跳过**这两类。保留：`triggered_fired` / `triggered_skipped` / `near_threshold` / `error` / `edited_by_operator` — 都是运营商关心的状态变化
- 新 CLI `tradekit timeline [--since 4h|ISO] [--until ISO] [--chain X] [--account L] [--strategy TAG] [--kinds list] [--severity floor] [--no-paper] [--limit N] [--json]`：
  - 文本输出：紧凑表格 `[severity-badge] [time] [kind padded] [summary]`，最后一行 `(output truncated to --limit N; pass higher to see more)` 当 truncate 发生
  - 头部三个 severity 计数 `X critical · Y warn · Z info`
  - `--no-paper` 给"只看真单"的运营商
  - `--severity warn` 在事故响应时过滤掉 info 噪音
  - `--json` 输出 `{ ok, count, since, until, events: TimelineEvent[] }` — Vector / jq / Fluent Bit 管道友好
- 新 MCP 工具 `timeline_query`（observability-tools.ts）：相同的过滤集 + 类型化 `TimelineEvent[]` 返回 — agent 调研事故时一次 MCP call 取回完整时间窗合并，不用手动跨 6+ tool 拼接
- 测试覆盖：
  - `timeline.test.ts` 29 case
  - `resolveWindow` + `parseSinceDuration` 各种 duration / ISO / 错误格式
  - 每个 collector 独立测试（窗口过滤 / chain/account/strategy 过滤 / kinds 过滤 / minSeverity floor / 严重等级派生 / 错误信息渲染）
  - 端到端 6 case：跨源合并 newest-first / 全局 limit 截断 / --no-paper / alert.fired 流入 timeline / journal 路径产生 order.edited 事件 / strategy 过滤跨源协同（trade + alert 同时按 tag 过滤）
- MCP_TOOLS 不变量：`timeline_query` 加入 iter589/iter877 set
- 向后兼容：纯加法 — 没有 schema migration（所有源表都已存在），没有现有 CLI/MCP 行为改动，没有引擎路径触动；现有部署直接升级就拿到能力
- 不变量保护：
  - **5 个源各自独立**：添加未来源（e.g. engine.events 表）= 一个 collector 函数 + 一组 tests，**不**修改现有 collectors，**不**修改主 entry 的合并逻辑
  - **per-source DB 限制 + 全局 limit**：每个源最多取 max(limit*2, 200) 行，合并后取全局 newest-N — 保证 limit=100 时全局确实是 newest-100，即使某个源贡献了 500 条
  - **稳定排序**：相同 timestamp 按 kind 字符串 + id 倒序 tiebreak — CI diff / JSON tail / 测试快照都是 deterministic
- v1 限制：alert.resolved 检测是 heuristic（active=0 + last_value_json 非 null + last_evaluated_at 在窗口内），90%+ 准确但理论上可能误报（一种边缘 case：rule 进入 backoff_deepened 后又 resolve 在同一秒内 — last_value_json 既反映 deeped 又反映 resolved 状态。这个 case 在 v1 时戳精度下不太可能 reproduce）；v2 加 explicit `alert_events` table 让所有 transitions 完全独立可查；engine 状态转换（lock/unlock/worker.degraded/recovered）现在只通过 audit_log 暴露 — 未来 iter 可以加显式 engine_events 表

**Phase 35 — 配置热重载（SIGHUP）+ 影响预检（preflight）** ✅
- 关闭长期运行 daemon 的最后一个常见运维痛点：iter34 以前每次修改 config（收紧 maxSlippageBps / 加 strategyBudget / 新 strategyAlerts 规则 / 调 worker interval）都要重启 engine — 重新解密 keystore（昂贵的 scrypt cost）、in-flight tick 状态丢失、重启窗口内交易没有 safety 保护。Unix daemons 30 年前就用 SIGHUP 解决了这个问题，iter35 把这套搬过来
- 同时关闭"config 改了之后才发现问题"的反应式调试模式：iter32 alerts watcher 几小时后用 success_rate_drop 通知告诉运营商 "23 个 active orders 的 slippage 超过新的 maxSlippageBps" — iter35 把这个信号提前到 config 改动 **之前**
- 三层联动设计：
  1. **`ConfigRef` 容器**：engine supervisor 的 `const config = loadConfig()` 换成 `const configRef = new ConfigRef(loadConfig())`，workers 每个 tick 通过 `configRef.get()` 读取，SIGHUP 介于两个 tick 之间 swap，**在飞行中的 tick 看不到 swap**（要么用全旧、要么用全新，没有中间态）
  2. **SIGHUP handler**：buildSighupHandler 验证新 config 通过 `configSchema.parse` 后才 swap；parse 失败 → 旧 config 保留 + emit critical 级别 `config.reload_failed` 通知（**不会**静默继续用旧 config 让运营商误以为生效）
  3. **Preflight 影响分析**：纯函数 `computeConfigImpact(oldConfig, newConfig, activeState)` 跑 11 个独立 analyzer（maxSlippageBps / perTxUsdLimit / dailyUsdLimit / tokenBlacklist / tokenWhitelist / strategyBudgets / drawdownCircuitBreaker / engine.workers / strategyAlerts / engine.resilience / defaultSlippageBps），每个返回 zero-or-more warnings + 受影响的 primitives
- 三种严重等级 + 明确语义：
  - **critical**：当前状态违反新规则（操作员**必须**行动）— 例如 23 个 active orders 的 slippage_bps 超过收紧后的 maxSlippageBps
  - **warn**：未来 fire 可能 block — 例如新加 perTxUsdLimit 还没受影响但可能受影响
  - **info**：可观察但无伤害 — 例如 worker interval 从 30s 改到 60s
- `tradekit config preflight [--file PATH] [--strict] [--json]` 三种模式：
  - `--file PATH`：读取一个**候选** config 文件 + 与当前保存的 config diff — 用于 CI 在 PR 合并前 gate config 改动
  - 无 `--file`：当前 saved config 对当前 saved config — 实际上是"是否有任何待 reload 的状态"的烟雾测试（v2 持久化 last-reloaded 快照后可以变成 "current-saved vs supervisor-loaded" 真正 diff）
  - `--strict` exit 1 当任何 critical warning 存在 — CI gate 用
- `tradekit config reload`（独立子命令）+ `config set / push / drop` 后**自动**调用 `kickRunningEngine()` 找运行中的 supervisor pid（从 iter11 status file）+ 发 SIGHUP；engine 不在运行就 silently no-op（next `engine run` 自然加载新 config）。运营商再也不用记得"改完要重启"
- `kickRunningEngine` 健壮性：4 种 no-op 路径都明确返回类型化原因 (`no_status_file` / `stale_pid` / `self` / `signal_error`) — CLI 知道是默默 OK 还是要给操作员示警；signal 0 探针（POSIX 标准 idempotent test）区分 ESRCH (stale) vs EPERM (用户权限问题)
- 通知 + 透明度：每次成功 reload emit `config.reloaded`（severity 由 preflight 决定 — critical/warn/info），body 携带 diff summary + non-info 警告的 message。运营商通过 Slack/Discord/webhook 看到 "Config reloaded (5 changes: 2 critical, 1 warn, 2 info) — CRITICAL: safety.maxSlippageBps tightened 500 → 200; 3 active primitives carry a higher slippage..."
- 新错误码：`config.reload_failed` 用现有 `INTERNAL_ERROR` / Zod 错误，不引入 new ErrorCode — 是个 notification event name，不是 ToolError code
- 新 MCP 工具 `config_preflight`（admin-tools.ts）：agent 传 inline proposed config（full 或 partial overlay，merge=true 默认走 deep-merge），返回 typed ImpactReport。agent 在自动化调参时（"raise budget if last 30d shows safe drawdown"）可以 sanity-check **之前**就 propose 修改
  - 故意**不**暴露 `config_reload` MCP 工具：跨进程 signal 是 host 的特权，agent 不应该直接调 — agent 写文件 + 调用 host 端的 `config reload` CLI surface 才是正确分层
- 测试覆盖：
  - `configPreflight.test.ts` 26 case：每个 analyzer 的 happy + 边界 + tightening/loosening 分类 + summary 聚合 + 各严重级判定
  - `configReload.test.ts` 14 case：ConfigRef swap / handler 成功路径 swap + 通知 / preflight 状态注入 / 无变更 info severity / loadFn throw 保留旧 config + critical 通知 / schema parse 失败保留旧 config / kickRunningEngine 6 种路径 (no_status_file / self / stale_pid / ESRCH / EPERM / 成功 delivery)
- 向后兼容：纯加法 — 没有 schema migration（ConfigRef 是 in-memory），没有现有 CLI 行为改动，没有现有 MCP 工具改动；现有 `engine run` 启动后自动加 SIGHUP handler，operators 不需要重新部署就拿到能力；现有 `config set` 自动 kick，但 kick 失败永远不影响 set 本身的成功 — set 是 disk write 的成功语义，reload 是 process state 的 best-effort 同步
- 不变量保护：
  - **swap 原子性**：configSchema.parse 在 ref.set 之前，parse 失败时 ref 完全不动 — 没有半途生效的中间态
  - **mid-tick 一致性**：worker 在 `worker.tick()` 函数体内读到的 config 在该 tick 内始终一致 — supervisor 在 tick await 之后才检查下个 worker，SIGHUP handler 也是在 tick 之间执行
  - **kick != mutation success**：`saveConfig` 失败抛错 user 知道；`kickRunningEngine` 失败被 swallow + stderr 提示 — 两个失败模式严格区分
- v1 限制：file-system watcher（自动 reload on file save 而不要 SIGHUP）留 v2 — 简单 SIGHUP 模式无 race / 无 inode trickery / 跨 OS 一致；persistent "last reloaded snapshot" 留 v2 让 `config preflight` 无 --file 时能真正 diff supervisor-loaded vs disk-saved；config_reload MCP 工具留 v2（需要 token-based authorization 才能让 agent 跨进程 signal）

**Phase 34 — 状态保留的就地编辑（in-place edit of orders + schedules）** ✅
- 关闭 iter1-33 累积下来的最后一个常见运营痛点：修改已部署原语必须 destroy + recreate，丢掉 trailing HWM、attempt counter、order journal 连续性。对 trailing stop 尤其严重 — HWM 已经追踪了几个小时/几天，操作员想把 trail 从 5% 收紧到 7% 就要把全部状态扔掉。这是日常操作中最频繁的调整，刚好是状态保留最重要的场景
- 设计原则：**严格区分可编辑 vs 冻结字段**
  - 可编辑（操作员调整策略参数的自然集合）：target_price_usd / trail_pct / base_amount / quote_amount / slippage_bps / auto_slippage / expires_at / strategy / note / paper（schedule 还有 cron_expr / next_run_at / end_at / max_runs / on_fill_json）
  - 冻结（改了就是另一个原语，强制 destroy + recreate）：id / side / chain / account / base_token / quote_token / trigger_type / group_id (OCO)
  - 引擎管理（编辑路径绝对不碰）：water_mark_usd / attempts / last_checked_at / fill_* / run_count / total_base_filled / total_quote_spent
  - 两组 writer 严格按列不重叠 — 引擎不写可编辑列，编辑不写引擎列 — race condition 物理上不可能
- v25 后向兼容的 SQL 路径：单条 UPDATE 语句，guard 在 `WHERE id=? AND status='active'`（schedule 还接受 'paused'）。同时另一个 tick 把 row 翻 terminal 时，UPDATE 返回 changes=0 + 编辑层抛错告诉操作员"order 已 filled/expired/cancelled"，**不会**静默吞掉操作员的编辑或覆盖引擎刚写的终态
- 新模块 `orderEdit.ts`（~430 行）+ `scheduleEdit.ts`（~330 行）— 同款形状的两层：
  - `validateXxxEdit({ row, changes, config, now })` → 纯函数，returns `{ dbChanges, diff }` 或抛 ToolError。每个字段独立校验路径 + 跨字段约束（exactly-one-amount invariant; trail_pct 仅 trailing 可用；maxRuns 不能低于当前 run_count）。引擎的安全规则也被尊重 — slippage > safety.maxSlippageBps 抛 SLIPPAGE_TOO_HIGH（同 create 路径）
  - `editXxx({ id, changes })` → 事务式 entry：getById → validate → updateXxxEditable → journal → getById 再读 after row。整个流程**纯同步 SQLite 操作**，无 await，无 race window
- 论坛连续性：每次成功的 order edit 都向 `order_check_log` (iter25 journal) 追加一行 `decision: "edited_by_operator"`，notes 字段是 JSON-encoded 字段 diff（`{"trailPct":[5,7],"slippageBps":[50,75]}`）。`tradekit order replay <id>` 自然把操作员编辑和触发评估混在一条时间线 — 当订单最终 fire 时，全 lifecycle 历史完整可见
- `OrderCheckDecision` discriminated union 加新成员 `"edited_by_operator"`；orderJournal.ts 的 decisionMarker / decisionLabel 同步扩展（`✎ edited by operator`）— 这条 enum 变更让 TS 的 exhaustiveness 检查强制下游 case switch 处理新值，所以**没有任何 renderer 会静默漏掉编辑事件**
- Cron 编辑特殊语义：schedule edit 修改 cron_expr 时**自动**重算 next_run_at = nextRun(parsed, now) — 操作员意图是"下一次按新 cron 触发"，保留旧 next_run_at（按旧 cron 算的）就是 stale。同时旧 cron 期 + run_count 历史完全保留，只重置 "下次什么时候 fire"
- maxRuns 不能低于 run_count：防止把 schedule 推进非法状态（"已经 fire 12 次但 maxRuns=5"）。操作员可以 set 等于 run_count 来让 schedule 在下次 fire 后立刻 retire，或者 cancel
- on_fill spec 编辑走 iter27 的 validateOnFillSpec — 同样的 fake-fill 渲染 + create-order-row 校验 gate，misconfiguration 在编辑时 INVALID_PARAMS，不会让损坏的 hook spec 在下一 fire 才崩
- No-op 编辑是零成本的：操作员传 `--slippage-bps 50` 但当前已经是 50 → diff = [] → 不更新 updated_at、不写 journal、立即返回。Idempotent retry 是免费的（agent 重试编辑同样参数不会 spam log）
- 新 CLI：
  - `tradekit order edit <id> [--target-price N] [--trail-pct N] [--base-amount A | --quote-amount A] [--slippage-bps N] [--auto-slippage true|false] [--expires-in D | --expires-at ISO] [--note "..."] [--strategy TAG] [--paper true|false] [--unset target-price,trail-pct,expires-at,note,strategy,slippage-bps] [--json]`
  - `tradekit schedule edit <id> [--cron "..." | --every D] [--base-amount A | --quote-amount A] [--slippage-bps N] [--auto-slippage true|false] [--end-at ISO] [--max-runs N] [--note "..."] [--strategy TAG] [--paper true|false] [--on-fill '<json>' | --on-fill-file P] [--unset end-at,max-runs,note,strategy,slippage-bps,on-fill] [--json]`
  - `--unset` 约定：可被 unset 的字段是 nullable 的子集；对 nullable 字段 `--unset note` 等同于 `--note ""`，对 trailing 的 `target-price` 是"清掉激活门"
  - 文本输出列出 per-field 改变 `trailPct: 5 → 7`，trailing 订单显式打印 `Trailing HWM preserved: $2500` 让操作员立刻看到 state 没丢
  - `--json` 输出 `{ ok, diff: [...], order }` — agent 可直接读 diff 数组
- 新 MCP 工具 `order_edit` + `schedule_edit`，加入 iter589/iter877 MCP_TOOLS Set 不变量；mirror CLI 表面 — agent 同样可以一次调用调整策略
- 测试覆盖：
  - `orderEdit.test.ts` 22 case：validate 层 trailPct 改变保留 HWM 在 dbChanges / amount swap exactly-one / no-op 时空 diff / terminal 状态拒绝 / trailPct 用在非 trailing 拒绝 / 拒绝清掉 price_below 的 target / 拒绝越界 trailPct / 拒绝双 amount 双向 / SLIPPAGE_TOO_HIGH / expiresAt past / 格式错误。End-to-end：HWM 保留 / attempts 保留 / journal 写入 + JSON diff / no-op idempotent / 终态拒绝 / 并发竞争（cancel 之后再编辑触发 terminal-aborted error）/ 未知 id throw / 同款参数 retry no-op
  - `scheduleEdit.test.ts` 21 case：cron 改变 + next_run_at 重算 / --every 转 cron / no-op / endAt+maxRuns 联合编辑 / 终态拒绝 / paused 状态接受 / 双 cron+every 拒绝 / 畸形 cron / 双 amount / maxRuns < run_count / maxRuns = run_count 接受 / endAt past / SLIPPAGE_TOO_HIGH。End-to-end：run_count + total_base_filled 保留 / cron 改后 next_run_at 持久化 / 终态拒绝 / 未知 id / no-op / paused 编辑保留 status / onFill null 清掉 hook
- 向后兼容：纯加法 — 没有 schema 迁移（所有列都已经存在），没有现有 CLI 改动，没有现有引擎路径改动；`edited_by_operator` 是 OrderCheckDecision 的新 enum 成员，TS 强制所有下游 switch 处理，但实际所有 renderer 自动接受 / 渲染该值
- 不变量保护：可编辑 vs 冻结字段的边界由 `OrderEditableFields` interface 在 type-level 强制 — 不可能从 orderEdit.ts 不小心去写 water_mark_usd 因为它根本不在 type 里。这是比"运行时检查"更强的保证

**Phase 33 — 引擎韧性（resilience: backoff + tick timing + alerts integration）** ✅
- 生产部署的实际痛点：iter32 alerts watcher 是 sidecar 进程，运营商管两个进程；引擎 worker 一旦持续失败（dead RPC / dry oracle）就以 base intervalMs 死循环重试，产生 load storm + notification 风暴；tick 时长完全不可见 — 操作员看不到 "orders worker p95 从 200ms 涨到 4s" 这种慢性退化
- 三层韧性改进，闭环引擎"生产级 daemon"能力：
  1. **alerts 升级为第 5 个一等 worker**：`tradekit engine run` 默认包含 alerts，无需 sidecar；read-only（不需要 wallet password，与 reconcile 同类）；safety.strategyAlerts 未开启时 tick 是 no-op，对未 opt-in 用户零成本
  2. **每 worker 连续失败指数退避**：连续失败 ≥ thresholdFailures（默认 3）后，effective interval 按 backoffMultiplier（默认 2×）放大，封顶 maxBackoffMs（默认 10min）；首次成功 reset 到 base interval；这一对状态转换 emit 解耦的 `engine.worker.degraded` / `engine.worker.recovered` notification（dedupKey 防同一退避窗口重复发）
  3. **滑动窗口 tick 时长**：每 worker 维护最近 N（默认 20）个 tick 的 durationMs，在 `engine status` 渲染 avg / p50 / p95 / max — 操作员发现 "添加第 12 个 token 到 whitelist 后 orders p95 翻倍" 不用 grep 日志
- 新模块 `engineHealth.ts`（~400 行）：纯函数 + 不可变状态
  - `interface WorkerHealthState`（ticks / successes / failures / consecutiveFailures / backoffMultiplier / recentDurationsMs[] / degraded / lastSuccessAt / lastFailureAt）
  - `nextWorkerInterval({ baseIntervalMs, state, config })` → effective interval（考虑 backoff + cap）
  - `recordTickResult({ state, ok, durationMs, baseIntervalMs, config, now })` → `{ state, transition }` — 纯函数 update + 分类转换
  - `WorkerHealthTransition` discriminated union: `entered_backoff` / `backoff_deepened` / `recovered` / `no_change`
  - `summarizeTimings(durations)` → `{ count, avgMs, p50Ms, p95Ms, maxMs }`，空数组返回 null
  - 设计选择：**所有状态显式传入**，supervisor 持有 Map<name, state> + 喂给纯函数 → 容易测试 + I/O 与逻辑解耦
- 关键不变量：backoff 的乘数 **本身** 被 maxBackoffMs / baseIntervalMs 上限封顶 — 否则在持续失败的情况下 multiplier 可以无限增长（即使 effective interval 已经被 cap），后续 `still_active` 转换错误地反复 emit notification。两个独立 cap：multiplier cap + ms cap，组合保证再多连续失败也不会无限放大 multiplier
- Config schema 扩展：
  - `engine.workers.alerts: engineWorkerSchema`（默认 enabled, 5min interval — 比 orders 慢，比 rebalance 一致；alert evaluation 本身廉价）
  - `engine.resilience: { enabled, thresholdFailures, backoffMultiplier, maxBackoffMs, tickTimingWindow }`（默认 enabled）
  - `EngineWorkerName` 类型加 `"alerts"` literal
- Engine supervisor 集成：
  - `requiresPassword` 检查现在 `!READ_ONLY_WORKERS.has(w.name)` — alerts + reconcile 都属于 read-only，单独跑 `--workers alerts` 不需要 password
  - 初始 status snapshot 加 4 个新字段：consecutiveFailures / degraded / effectiveIntervalMs / tickTiming
  - 每 tick 完成后：`recordTickResult` 算新 state + 转换；transition.kind 决定是否 emit notification；status 行同步更新 health 字段；下次 dueAt 走 `nextWorkerInterval` （退避自动生效）
  - degraded 通知 dedupKey 是 `engine.worker.degraded:<name>` — 同一退避周期再次 entered_backoff 不会重发（因为 state.degraded=true 时下次 violation 走 `backoff_deepened` 分支，**不** emit notification）；recovered 通知 dedupKey 含小时戳，避免同一小时内反复 flap 时刷屏
- CLI 状态显示升级：`engine status` 文本输出每 worker 多两行
  - 第一行 status 头加 `⚠`/`●` health badge（degraded 时 ⚠）
  - 第二行（仅在有数据时）：`BACKOFF: N consecutive failures → effective interval Xs` 或 `tick time: avg ?ms · p50 ? · p95 ? · max ?`
  - JSON 输出自动 surface 全部新字段（`status.workers[].degraded` / `consecutiveFailures` / `effectiveIntervalMs` / `tickTiming`）— Prometheus 用户 + dashboard 可以直接 scrape
- 测试覆盖：
  - `engineHealth.test.ts` 19 case 全部纯函数：nextWorkerInterval cap 行为 / recordTickResult 成功 + 失败 + 跨阈值 + 深入 backoff + 多次 deepen / multiplier cap / disabled resilience 永不退避 / timing window 大小 + 最新优先 / summarizeTimings 各百分位 / 完整 fail-degrade-fail-recover-no_change-fail-redegrade 流程
  - `engine.test.ts` 加 4 case integration：consecutiveFailures + degraded 在 3 次失败后置位 / fail-recover 周期 effectiveIntervalMs 恢复 base / tickTiming 在第一次 tick 后非 null / alerts worker 不需要 password（验证 READ_ONLY_WORKERS 集合）
- 向后兼容：默认配置匹配现有行为（resilience 默认开启，但 thresholdFailures=3 + 默认 worker 行为对单次 RPC 抖动不敏感）；现有 status 文件读取代码继续工作（新字段是 additive）；现有部署直接升级看到 alerts 自动 enable — 但是 safety.strategyAlerts 未配置就是 no-op，**零行为变化**
- 不变量保护：alerts worker 的成功语义是"tick 没抛异常"而**不是**"没有 alert fire" — alert fire 本身是 alerts worker 的成功输出。错误地用 `ok = !alertsFired` 会让正常运行的 alerts worker 把自己 degrade，进入退避，停止工作。这条边界由 buildBuiltinWorkers 的 alerts case 显式注释 + `ok: true, data: report` 模式锁定
- v1 限制：worker 仍然顺序执行（不并发）— 一个 orders tick 60s 仍然阻塞下个 worker 60s。并发 worker 需要重新思考 DB 写锁 + 通知顺序，留 v2；retry-with-different-RPC 退避层之上的智能 fallback 也留 v2

**Phase 32 — 策略告警（proactive strategy alerts）** ✅
- 完成 iter31 的 pull-based observability 的 push 端：iter31 告诉操作员**怎么了**，iter32 告诉他们**什么时候去看**。运营商运行 5+ 个策略时，被动报告不够 — 需要 webhook 推送当策略健康度跨越阈值
- 7 种规则类型覆盖运营关心的失败模式：
  - **staleness**：策略已部署但 N 秒内无成交 — DCA 卡住了？budget 默默用完了？bug？
  - **slippage_trend**：观测到的平均滑点 ≥ baseline × multiplier — regime change？liquidity dry up？
  - **success_rate_drop**：N 笔窗口内成功率跌破阈值 — slippage 设太紧？token 出问题？
  - **failure_streak**：N 连续失败 — 紧急情况，可能是新合约部署 / blacklist 触发 / 路由错误
  - **budget_approach**：strategy budget 消耗 ≥ X%（lifetime 或 daily）— 接近 STRATEGY_BUDGET_EXCEEDED 的提前告警
  - **drawdown_threshold**：per-strategy drawdown ≥ X% — 接近 portfolio breaker 的提前告警
  - **trigger_proximity**：任意 active order 距离触发 ≤ X% — 提前心跳（vs 反应式的 order.filled）让操作员有机会调整
- v25 迁移：`strategy_alert_state` 单表持久化每个 `(tag, rule_type)` 的 dedup 状态 — `active` flag + `first_triggered_at` + `last_evaluated_at` + `last_value_json`。**每次状态转换 emit ONE notification**：OK→active 发 fire 事件；active→OK 发 resolved 事件；其余 tick silent，不会每次 tick 都重复推送同一条告警
- 新模块 `strategyAlerts.ts`（~600 行）：
  - 7 个 pure rule evaluator（每个 takes StrategyReport + rule config + returns AlertEvaluation 带 applicable/violated/message/value）
  - `reconcileAlertState`：纯函数，对比当前 evaluation 与 DB 中前一个状态行，分类为 fire/resolve/still_active/still_ok/skip
  - `runAlertTick`：orchestrator — 列举有活动策略的 tag → 按 rules 推导**仅需的 report sections**（cheap path：只配 trigger_proximity 时跳过 slippage 统计计算）→ build report → evaluate → reconcile → notify + persist
  - `enumerateActiveTags`：去重合并 trades.strategy + active orders/schedules/rebalances.strategy
- Tag 过滤 `appliesTo`：每条规则可选 `["playbook:*", "dca-eth"]` pattern 列表（literal 或 `prefix*` wildcard，与 strategyBudgets 同款），让一套 config 覆盖异构策略（不同策略容忍不同 slippage / budget）
- 规则不可用（inapplicable）silently skipped：rule 评估时遇到缺少 sections / 样本不足 / 无 live price 等情况返回 `applicable: false`，**既不 fire 也不 resolve** — 保留前一状态行供下一 tick 重新评估。避免 false positive（"slippage 高了！" — 其实只看到 1 笔成交）+ false negative（"已恢复！" — 其实评估失败了）
- Notification 形状复用现有 notify stack：每个 rule 类型有固定 severity（drawdown_threshold 和 failure_streak = critical；trigger_proximity = info；其余 = warn），独立 dedupKey 防 notification 系统的二次 dedup 误吞，fields 携带规则 value payload + 可选 operator-写的 note
- Resolution event 1:1 pair：`strategy.alert.resolved.<rule_type>` event + 持续时间字段（active 多久后恢复），dashboard / agent 可以 pair fire/resolve 计算 alert lifecycle stats
- 新 CLI `tradekit strategy alerts <action>`（4 subactions）：
  - `list [--tag X] [--active-only]` — 浏览所有状态行（按 tag 分组，活跃数 + 持续时间）
  - `show-rules` — 列出配置的规则 + 每条匹配到哪些活跃 tag（**部署前验证 config 改动**）
  - `run [--once | --watch N] [--tag X]` — 手动跑 tick；watch mode 守护进程式循环（最低 5 秒）。--tag 限制只评估单个策略，调试用
  - `reset [--tag X] [--rule TYPE] [--yes]` — 清状态行；rule 重新 armed，下次违反会 emit 新的 fire — 用于运营商手动 acknowledged 告警后想看后续变化
- `strategy report --alerts`：报告末尾附加当前活跃的 alert 行（不触发 watcher，纯读 v25 表），让两次 iter31 的 strategy 报告之间发生的告警立即可见
- 配置完全 opt-in：`safety.strategyAlerts.enabled` 默认 false。开启后还要 `rules: [...]` 非空才工作。零规则 + enabled=true 的 tick = no-op + debug 日志 — 不会"配置错了 silently 跑空"，但也不会 spam 默认无配置的用户
- 测试覆盖：`strategyAlerts.test.ts` 43 case
  - tag 匹配（literal + wildcard + empty appliesTo）
  - sectionsForRules（union 计算 + identity 永远 needed）
  - 7 个 rule evaluator × 每个的 inapplicable + violated + ok 路径
  - evaluateAllRules（appliesTo 过滤）
  - reconcileAlertState（5 种 transition 分类）
  - 端到端 6 case：disabled config no-op / empty rules no-op / 违反 → fire + persist + 第二 tick silent / active → 解除 emits resolution + 清状态 / inapplicable 不写状态行 / 多策略 + appliesTo wildcard
- 不变量保护：每次 fire / resolve **必** 经过 reconciler 才能 emit notification；reconciler 不写 DB（只分类），所有写都在 runner —— 测试通过纯 stateLookup 函数注入 + 验证 transition kind 即可断言 dedup 正确性
- 向后兼容：v25 migration 不影响任何现有表；现有 config 文件 zero changes 仍工作（schema 是 optional）；engine.run 行为不变（告警是独立 CLI 路径，未来 iter 可加入 supervisor worker，但 v1 故意分开避免引入新的 engine 故障模式）
- v1 限制：rule evaluator 没有"组合规则"（e.g. AND/OR），每条独立；rule 配置走 config 文件全局而非 per-playbook（playbook spec 嵌入规则留给 v2，需要 playbook diff 处理规则变更）；alerts 只走 notify stack，没有 web UI 集成（操作员的 Slack/Discord/webhook 已经在那里 — 走现有渠道更省事）

**Phase 31 — 统一策略可观测性（unified strategy report）** ✅
- 解决日常运营痛点：iter1-30 累积出完整的 create → deploy → backtest → monitor → iterate → destroy 生命周期，但**单一策略的实时状态查询**仍然碎片化 — 操作员要回答"我的 eth-bracket-dca 策略现在怎么样？"需要敲 7+ 个命令：`playbook show / order list --strategy / schedule list --strategy / rebalance list --strategy / trades --strategy / pnl --strategy / slippage --strategy`。数据全在那里，缺一个聚合层
- 新模块 `strategyReport.ts`（~700 行）：**ONE entry point** `buildStrategyReport({ tag, window, mode, sections, livePriceFn, ... })` 产出 7 段类型化报告 — `IdentitySection / CompositionSection / PerformanceSection / PositionSection / RiskSection / ActivitySection / ForwardSection`。Pure-ish（只读 DB + 可选 livePriceFn 回调）让 CLI / MCP / web 共享同款数据形状
- 标签解析宽容：纯数字 → `playbook:<N>`，free-form tag（如 `dca-eth`）直接用。`tradekit strategy report 1` 等同 `tradekit strategy report playbook:1`
- Paper-aware 自动检测：`mode: "auto"`（默认）走以下规则 — 所有 active 原语 paper=1 → paper；任一 real 原语 → real；无 active 原语 + 仅 paper_trades → paper；fallback real。`mode: "real" / "paper"` 强制覆盖
- 7 段聚合细节：
  - **identity**：playbook name + source_path + source_hash + deployed_at + ageSeconds + status；free-form tag fallback 到最早 primitive created_at 算 age
  - **composition**：每种原语数量 + 7 状态生命周期计数（active / filled / failed / expired / cancelled / paused / completed）+ 排序后的 primitive 列表带 summary
  - **performance**：fills / failures / successRate / buyCount / sellCount / realizedQuoteSpent / realizedQuoteReceived / realizedNetQuote + slippage avg/p50/p95/max（real only — paper 无 realized_slippage_bps）。window 过滤通过 sinceIso
  - **position**：从 trades 走每笔 fill，累加 net (chain, token, base/quote role) — BUY 累 base 减 quote，SELL 反向；近零行（rounding artifacts，<1e-12）过滤；按 (chain, role, symbol) 稳定排序
  - **risk**：匹配 `strategyBudgets`（exact tag 或 `playbook:*` wildcard），返回 lifetime/daily/perFire 限额 + 已消耗 + 百分比；per-strategy drawdown 通过 `strategy:<tag>` scope key 查 drawdown_state 表
  - **activity**：recentFills / recentFailures / recentJournal — 各取最近 10 条；journal 走 `replayOrderEntries` 跨所有 owned orders 并按 checked_at desc 合并
  - **forward**：next_run_at 最早的 active schedule + 每个 active order 的距离-到-触发 — 价格触发用 `target_price_usd` 作 threshold，trailing 用 `water_mark × (1 ± trail_pct/100)`；distance% = (threshold - current) / current × 100；`wouldFireNow` 调用与 engine 同款 `isOrderTriggered` / `evaluateTrailingTrigger` 谓词保证 sanity-check parity；按 |distance| 升序排（最接近触发的在前，wouldFireNow=true 顶置）
- Section filter 让 fast path 成为可能：`sections: ["identity", "forward"]` 跳过 trades/journal/budget 计算，agent 做高频心跳检查（"我的策略还在跑吗？有什么要触发吗？"）只需毫秒
- 新 CLI `tradekit strategy report <id|tag> [--window 1d|7d|30d|90d|all] [--mode real|paper|auto] [--sections id,comp,perf,pos,risk,act,fwd] [--no-prices] [--json]`：
  - `--no-prices` 跳过 livePriceFn 网络调用（forward 段的 currentPriceUsd + distancePct 变 null），适合无网络环境的离线快照
  - `--sections` 接受短别名（id / comp / perf / pos / act / fwd）
  - 文本渲染分 7 段独立 renderer + 头部 — 每段用 60 字符 `─` 分隔线 + 缩进对齐
  - `--json` 输出整个 typed StrategyReport，agent 可直接消费同款 schema
- 新 MCP 工具 `strategy_report`（strategy-tools.ts 第 9 个工具）：mirror CLI 表面 — agent 一次调用拿到全量。`includePrices` 默认 **false** —— MCP 调用应当 deterministic + network-free 除非显式 opt-in
- CLI 别名：`strategy show` 等同 `strategy report`；`strategy list` 转发到 iter651 的 `strategies list`（向后兼容 + 在新命名空间下可发现）
- 测试覆盖：`strategyReport.test.ts` 43 个 case
  - tag normalization（4 case）、playbookIdFromTag（2 case）
  - resolveMode（6 case 覆盖 auto 模式全分支 + explicit override）
  - buildComposition 单元（counts + trailing summary + paper flag）
  - buildPerformance real（fills/failures + sums + slippage stats + window filter）+ paper（everything-as-fill + slippage null）
  - buildPosition（accumulate + skip failed + paper 全部计入 + zero filter）
  - buildRisk（exact tag + wildcard + drawdown surface + null drawdown）
  - buildActivity（fills+failures 新-旧排序 + paper 全 fill + journal merge）
  - buildForward（distance 计算 + wouldFireNow + closeness 排序 + trailing HWM + null next_run + earliest schedule + livePriceFn 异常容忍）
  - buildIdentity（playbook 路径 + free-form fallback）
  - 端到端 4 case（real playbook 全 7 段 + paper mode 自动切换 + sections filter 跳过其余 + 数字 tag → playbook:N）
- 不变量保护：`strategy_report` 加入 iter589/iter877 MCP_TOOLS Set；strategy-tools.test.ts "registers all 8" 改 9 — 维护者忘了更新 invariant 会立即失败
- 向后兼容：零 schema 变更（纯查询聚合），零现有命令行为变更，所有 7 段都是可选的（sections filter）；旧脚本 / agent 全部继续工作
- v1 限制：不做 mark-to-market（开仓 PnL 需要每个 token 一次 oracle 调用，会让命令变 non-deterministic — 文档中明确说与 `paper balances` / `price` 工具配合手算 total PnL）；drawdown 只查 `strategy:<tag>` 的 per-strategy scope，**不**显示 `global` scope（那个属于 portfolio-level breaker，不归这里管）

**Phase 30 — 纸面交易（paper trading mode）** ✅
- 第三种策略评估模式补完最后一块拼图：iter16 历史回测（过去数据）+ 链上实盘（真实资本）之间的真空地带 — 操作员希望用**实时市场**验证新策略但不冒资本风险。Paper mode 提供完全一致的 lifecycle（triggers / watermarks / OCO 级联 / 后置钩子 / 通知 / 失败语义）但 fire 路径写入虚拟账本而非链上
- 新模块 `paperTrade.ts`（~480 行）：与 `executeTrade` 平行的 `executePaperTrade(req, ctx)` — 同 result shape（status/ok/txHash/baseAmount/quoteAmount/aggregator）让 orders/schedules 引擎的 post-fire 簿记完全共享，**仅 fire 终点不同**；纯 `applyWorstCaseSlippage` + `computeOppositeAmount` 数学辅助；BigInt 余额管理（parseUnits/formatUnits）保证 18 位精度无 Number 丢精；`adjustPaperBalance` / `setPaperBalance` 用于 deposit 路径
- v24 迁移：`ALTER TABLE orders/schedules ADD COLUMN paper INTEGER NOT NULL DEFAULT 0` + 2 张新表 `paper_trades`（mirror of trades shape，带 source_type/source_id 归属）+ `paper_balances`（per (account, chain, token) 虚拟余额）+ 时间戳 / strategy 索引；现有原语 paper=0 → 行为零变化（v24 完全 backward compatible）
- 关键设计选择：**保留 engine lock（仍受全局熔断约束）但跳过资本追踪类护栏**（drawdown breaker / strategy budgets / position limits / daily USD caps）— 资本类规则跟踪真实资本，paper trade 不应消耗真预算；engine lock 是操作员意图（事故响应希望连 paper 也停）所以保留
- 最坏情况 slippage 模型：`spot × (1 ± slippageBps/10000)` 在不利方向 — BUY 单 effective 价提升、SELL 单 effective 价降低；真实路径**有时**击败 spot（router 改善路由），悲观会计告诉操作员**最差情况**下策略表现，这是 risk sizing 关心的答案
- 合成 tx hash：`paper:<id>:<timestamp>` — `paper:` 前缀打破每个 explorer-link helper 的 `0x...` 假设；下游存 fill_tx_hash 仍有值可写
- 余额强制（避免虚拟账本荒诞结果）：BUY 输入是 quote、SELL 输入是 base；不足返回 `PAPER_INSUFFICIENT_BALANCE`（distinct from on-chain `INSUFFICIENT_BALANCE` 让 dashboard / agent 能区分"需要种子虚拟账本"vs"需要给钱包打钱"）。运营商通过 `tradekit paper deposit --token X --amount N` 显式种子
- Price unavailable 处理：若 CoinGecko + DexScreener 都返回 null 抛 `PRICE_UNAVAILABLE`（HTTP 502）— paper trade **必须**用真实 spot 价才能反映真实市场，rather than silently 用陈旧价误导操作员
- 引擎集成：orders.ts / schedules.ts 在 fire 路径分支 `isPaperOrder = (row.paper ?? 0) === 1`，paper 走 `loadReadOnlyWallet`（**不解密 keystore**）+ `executePaperTrade`；real 走原 `executeTrade` 路径；post-fire 簿记（markOrderFilled / recordScheduleFire / on_fill hook / OCO cascade / 通知）100% 共享 — paper 失败也通过同 dedupKey 通知（运营商体验完全一致）
- Playbook cascade：`tradekit playbook deploy <file> --paper` 部署时级联设 paper=true 到每个 order/schedule 原语；rebalance 原语在 paper deploy 内**显式拒绝**（v1 scope，rebalance 还不 paper-aware）— silently 放过会产生真交易混在 paper 部署里烧资金，比错误更糟
- 新 CLI surface `tradekit paper <action>`：
  - `paper deposit --token X --amount N [--set]` — 种子虚拟账本（默认 credit；--set 覆写）
  - `paper trades [--account/--chain/--strategy/--source/--since/--until/--limit]` — 与 `trades` 同 filter
  - `paper balances [--account/--chain]` — per-(account, chain) 分组列出
  - `paper pnl [--strategy/--account/--chain]` — per-strategy 已实现 quote-PnL（开仓**不** mark-to-market — 文档化让操作员配合 balances + price 工具自行计算 total PnL，避免命令变 non-deterministic）
  - `paper reset [--account/--chain] [--yes]` — wipe 虚拟账本 + 交易日志，scope-less 时 wipe 一切；交互确认除非 --yes
- 每个 paper write 命令支持 `--json` 让 agent 同样可消费；reset/deposit 默认 `--yes` 前交互确认
- 测试覆盖：`paperTrade.test.ts` 24 个 case（pure 数学：BUY/SELL 滑点方向 + 0 bps 短路 / opposite amount 双向 + 双 amount/缺 amount/无效数字四种错误；DB 层：recordPaperTrade roundtrip + listPaperTrades by strategy/sourceType 过滤 + paper_balances upsert 覆写 + resetPaperState scoped/wipe 双语义；BigInt 余额：readVirtualBalance 默认 0 + set + adjust 双向 + 下溢拒绝 + 负数 set 拒绝；端到端：BUY 滑点向上 + 余额转移 + 日志行；SELL 滑点向下；PAPER_INSUFFICIENT_BALANCE / PRICE_UNAVAILABLE / INVALID_PARAMS 三种 sad path；合成 tx hash 形式；per-account 虚拟账本隔离）
- 新错误码：`PRICE_UNAVAILABLE`（HTTP 502 — 上游 oracle 故障）和 `PAPER_INSUFFICIENT_BALANCE`（HTTP 400 — 调用方可修，distinct from on-chain）
- 工作流：(1) `tradekit paper deposit --token USDC --amount 10000` (2) `tradekit playbook deploy strategy.json --paper` (3) `tradekit engine run` （引擎照常 tick + fire）(4) `tradekit paper trades` / `paper pnl` 监控 (5) 若策略表现达标，destroy + 不带 --paper 重新 deploy 上实盘
- v1 限制：rebalance 不 paper-aware（plan + targets 与 orders/schedules 路径分离，需要独立 BigInt 仓位会计 — v2 范畴）；不模拟 gas / MEV / 失败 tx（链上有 revert，paper 永远成功，由 iter16 历史回测覆盖 simulate revert 用例）；价格固定走 oracle，**不**调真聚合器（避免 paper 模式产生 router 流量）

**Phase 29 — Playbook 差异 + 原子替换（diff + replace）** ✅
- 关闭策略迭代缺口：iter1-28 累积出 create → deploy → backtest → monitor → destroy 全生命周期，但缺 update 路径。运营商改 trailPct 5%→10% 必须 destroy + redeploy，损失所有 HWM / run_count / 历史
- 新模块 `playbookReplace.ts`（~500 行）：纯 `structuralKey` 派生器（orders: `type:side:trigger:base:quote` / schedules 同少 trigger / rebalance: `type:name:sorted-targets`）+ 纯 `computePlaybookDiff` 4 桶分类器（unchanged/modified/added/removed）+ 字段级 `detectFieldChanges`（忽略 `id` 字段，operator metadata 非语义）+ 4 阶段 `replacePlaybook` orchestrator
- 结构匹配捕捉 "调参" 用例：`trailPct: 5 → 10` 在同一 (type, side, trigger, base, quote) 下匹配为 modified，不是 removed+added。同 key 多个实例按出现顺序匹配（first-occurrence-to-first）— OCO bracket 双 leg 在 (side, trigger) 不同所以 trigger 在 key 里
- Rebalance 结构 key 排序 targets 防误判：`[ETH, USDC]` 和 `[USDC, ETH]` 同 key（排序去序）
- 4 阶段原子替换：(1) parse + render via parsePlaybookSpec/template pipeline (2) 计算 diff (3) **pre-validate** 每个 added + modified 的新 primitive — resolveTradePair / 触发器特定字段校验 — 任一失败 ABORT BEFORE 触碰任何 DB 状态 (4) apply: cancel removed + modified-old (按 (type, side, base, quote) 在 listOrders/listSchedules/listRebalancePlans 找匹配活动行) + createOnePrimitive(同 deploy 共享路径) added + modified-new + updatePlaybookSpec 写新 spec_json + source_hash + deployed_at
- 关键不变量：pre-validation 在取消前完成 — 新 spec 有问题（未知 token / 缺 trailPct / 缺 price）导致整个 replace 立刻 INVALID_PARAMS，原 playbook 保持 100% 完整。测试用 BOGUS-NOT-A-TOKEN 验证：UNKNOWN_TOKEN 抛出后 active orders 数仍 = 1
- 共享创建路径：将 `createOnePrimitive` / `cancelByType` / `describeOrder` / `describeSchedule` / `describeRebalance` 从 playbooks.ts 私有 helpers 升级为 export — replace 调与 deploy 完全相同的创建路径，group namespacing (`pb<id>-<localname>`) + strategy tag (`playbook:<id>`) + 子 primitive 默认 chain/account 全部一致
- 新 DB helper `updatePlaybookSpec`（v17 表上的新 UPDATE 操作）：更新 spec_json / source_hash / source_path / deployed_at，不动 status
- v1 限制（明确文档化）：modified 桶用 cancel-and-recreate 语义，trailing HWM + schedule run_count 会丢；`willResetTrailingHwm` 标志在 diff 上突出渲染让运营商知情；状态保留留给 v2（需要 local_id 列）
- CLI: `tradekit playbook diff <id> <file>` 只读预览 + `--json` 出结构化 + 用于 CI strategy PR 评审；`tradekit playbook replace <id> <file>` 交互式确认 (`type 'replace'`) 除非 `--yes`
- 测试覆盖：`playbookReplace.test.ts` 21 个 case（structuralKey 5 种类型 + rebalance 排序去序 / pure diff 4 桶 + 同 key 实例消歧 + id 字段忽略 + 字段级变化提取 / 完整 deploy→replace 端到端 / spec_json+source_hash 持久化更新 / 取消后旧 row 留作 cancelled history / no-op 重放 / missing id / pre-validation 防止状态损坏 — BOGUS token 抛错后 active count = 1 / 拒绝 destroyed playbook 上的 replace）

**Phase 28 — 引擎全局熔断（kill switch）** ✅
- 第一个 operator-initiated 全局熔断原语 — 单命令同时停掉 orders 引擎 / schedules 引擎 / rebalance 引擎 / 手动 trade / post-fill hook 所有交易路径，事故响应 / 维护窗口必备
- 与 iter19/20 等 per-rule 防御原语正交：iter19 strategy budgets 限制单策略累计花费、iter20 drawdown breaker 响应资本曲线、iter28 engine lock 是操作员手动拉的总闸门
- v23 迁移：单行 `engine_lock` 表（`id INTEGER PRIMARY KEY CHECK (id = 1)`），含 active + reason + locked_at + locked_by + updated_at；迁移用 `INSERT OR IGNORE` 预种行让 getEngineLock 永远有行可读
- 选择 DB 表而非 config 字段：引擎持续 tick；config-based lock 需要进程重启或 hot-reload；DB 行每 tick 查询（µs 级），变更跨进程瞬时传播（CLI + engine + MCP server 共享同一状态）
- 关键设计选择：orders 引擎 LOCKED 时**继续 tick**（HWM 跟踪保鲜，last_checked 更新）但**跳过 fire 路径** — 操作员希望 trailing stop 在锁定期保持正确位置，解锁后从新鲜状态触发，而非用陈旧 HWM 误 fire
- 4 路集成：trade.ts 在 executeTrade 顶部 `assertEngineNotLocked()`（--simulate 豁免）；orders.ts 在 fire 前 setOrderError("ENGINE_LOCKED")；schedules.ts 跳过 fire 但**不推进 next_run_at**（错过的 fire 立刻在解锁后命中）；rebalance.ts 直接跳过整个 evaluation（portfolio fetch 是昂贵 RPC，能省则省）
- 新错误码 `ENGINE_LOCKED`（HTTP 403）；details 携带 lockedAt / reason / lockedBy / blockedContext；nextActions 指向 `engine_unlock` 让 agent 在自动化工作流中也能 disposition
- 新模块 `engineLock.ts`（~280 行）：pure `isEngineLockedFromRow` 谓词 + `assertEngineNotLocked` 抛错执行器 + 高阶 `lockEngine` / `unlockEngine`（带通知 + 日志副作用，幂等 re-lock/re-unlock 不重复发通知）+ `softSkipIfLocked` engine 路径用的"locked then return true with debug log"
- 2 个新通知事件：`engine.locked`（warn — 操作员应该被叫醒）和 `engine.unlocked`（info — 恢复确认）；dedupKey 含 locked_at 防同一锁定窗口重复
- CLI: `tradekit engine lock [--reason "..."] [--yes]` + `tradekit engine unlock [--yes]`，destructive 操作要求 'lock' / 'unlock' 短语确认（除非 --yes 或 --json 或非 TTY）
- MCP: `engine_lock` + `engine_unlock` 工具暴露给 agent，schema 含 z.literal(true) yes flag；加入 MCP_TOOLS Set 通过 iter589/iter877 不变量
- Status dashboard engine section 显著位置渲染锁定状态：`✕✕✕ ENGINE LOCKED ✕✕✕` + reason + lockedAt + lockedBy + 恢复命令；操作员一眼看到现状
- 测试覆盖：`engineLock.test.ts` 19 个 case（pure 谓词 / DB 单行不变量 / set+clear 幂等 / 防御性 re-seed / assertEngineNotLocked 错误 shape + nextActions / lockEngine 通知发射 + 幂等不重复 / unlockEngine 转换发射 + no-op 静默 / softSkipIfLocked 日志）

**Phase 27 — Schedule 后置钩子（post-fill hooks）** ✅
- 第一个跨原语自动化能力 — schedule 成功 fire 后自动创建后续 order（v1 仅 createOrder 类型）。解决经典工作流痛点：DCA 买入后操作员每次都得手动创建对应 amount 的 trailing-stop / OCO bracket — 现在 schedule 声明 onFill 后无人值守自我管理
- 新模块 `scheduleHooks.ts`（~340 行）：纯 `parseOnFillSpec` 结构验证 + 多错误聚合；纯 `renderOnFillSpec` 类型保留模板替换（whole-field `"{{filled.X}}"` 保留 var 类型 / embedded `"prefix-{{filled.X}}"` 字符串内插，与 iter21 playbook template 同款语义）；`validateOnFillSpec` 创建时门控 — fake fill 渲染 + downstream order spec 验证；`executeOnFillHook` fire 时执行器调用 createOrderRow
- v22 迁移：ALTER TABLE schedules ADD COLUMN on_fill_json (nullable)；现有 schedule 行 NULL → 行为零变化；新 schedule 通过 --on-fill / --on-fill-file 显式 opt in
- Fill 上下文 5 个变量：baseAmount / quoteAmount / fillPriceUsd / txHash / fireNumber — 后两个让 per-fire OCO bracket 命名成为可能（`"group": "bracket-{{filled.fireNumber}}"`）
- 创建时验证（critical for production）：fake fill 数据走 render → createOrderRow validator gates；misconfiguration 在 schedule 创建那一刻就 INVALID_PARAMS，不会等到几个月后第一次 fire 才崩
- Fire 时失败不回滚 fill：trade 已经发生在链上，部分恢复（无 follow-up）是正确语义；emit `schedule.on_fill_failed` warn 级别通知 + 错误码让操作员手动创建
- 无递归：只有 schedule 持 hook，order 不持。DCA 创建的 trailing-stop fire 时不再触发 hook → 有界
- Strategy tag 透传：onFill 创建的 order 继承 schedule 的 strategy 列。schedule tagged `playbook:1` → 产生 orders tagged `playbook:1` → playbook + budget filter 跨 DCA + auto-stop 自动覆盖
- Type-aware 替换的必要性：JSON 字符串必须类型对齐才能过 createOrderRow validator — `"price": "{{filled.fillPriceUsd}}"` 必须渲染成 `"price": 2500`（数字）而不是 `"price": "2500"`（字符串）；与 iter21 模板共用同款语义
- 引擎集成 in `runScheduleTick`：在 recordScheduleFire 后 + schedule.fired 通知前；fire report 携带 onFillOrderId / onFillError 字段供下游消费
- 2 个新通知事件：`schedule.on_fill_created`（info）和 `schedule.on_fill_failed`（warn）；都有 dedupKey 含 fireNumber 防同一 fire 重复通知
- CLI: `--on-fill '<json>'` 或 `--on-fill-file <path>` 互斥，与现有 --base/--quote/--cron 等同级
- 测试覆盖：`scheduleHooks.test.ts` 27 个 case（parseOnFillSpec 全错误路径 + 多错误聚合、renderOnFillSpec 三种类型 whole-field + embedded 内插 + 多占位符 + 未知变量错误带路径 + immutability、validateOnFillSpec 拒绝 trailing-without-trailPct + price_above-without-price + 双 amount + 未知变量、executeOnFillHook 端到端 DB 持久化 + strategy 传播 + per-fire group 命名 + 数字 price 类型保留 + 渲染失败 INVALID_PARAMS）

**Phase 26 — MCP 完整暴露 iter17-25 surface（agent integration completion）** ✅
- 14 个新 MCP 工具，覆盖 iter17 / iter18 / iter20 / iter21 / iter22 / iter23 / iter24 / iter25 全部之前 CLI-only 的能力。pre-iter26 工具暴露停留在 iter11 时代 — agent 通过 Claude Desktop / Cursor / 自定义 agent 用 tradekit 时拿不到一半的核心功能
- Strategy lifecycle（playbooks + backtests）8 个工具 in new `src/mcp/strategy-tools.ts`：
  - `playbook_validate` / `playbook_deploy` / `playbook_list` / `playbook_show` / `playbook_destroy` — 完整生命周期；接受 inline JSON spec + 可选 vars bag（agent 不需要写文件）；deploy 原子 + 幂等；destroy 需要 yes=true
  - `backtest_order` / `backtest_playbook` / `backtest_compare` — 三种 backtest 模式；inline 输入；持久化到 backtest_runs / backtest_comparisons 供后续 show 调用
- Operational observability 4 个工具 in new `src/mcp/observability-tools.ts`：
  - `status_dashboard` — iter23 多 section 仪表盘（与已有的 admin `status` 区分；admin status 是进程状态）；接受可选 sections 过滤
  - `digest_summary` — iter24 窗口活动报告 + 可选 prior-window 对比 delta
  - `order_replay` — iter25 forensic decision timeline；启用门控提示嵌入
- Backtest 历史检索 3 个工具：`backtest_list` / `backtest_show` / `backtest_compare_list` / `backtest_compare_show` — 持久化结果检索 + JSON 字段反序列化（spec / balances / fires / results）
- Safety stack 2 个工具 in extended `src/mcp/security-tools.ts`：
  - `safety_drawdown` — drawdown 熔断器状态查询（peak / current / drawdown % / tripped flag per scope）
  - `safety_reset_drawdown` — 清除 tripped + 可选 re-anchor peak；destructive 操作要求 yes=true
- 输入设计：所有工具接受结构化 JSON 对象直接（agent 不写文件、不字符串化数字）；模板渲染走 vars: { NAME: value } 接受 string|number|boolean；destructive 操作（playbook_destroy / safety_reset_drawdown）用 z.literal(true) 的 yes flag 强制确认
- 输出设计：复用 CLI --json 模式的形状；错误抛 ToolError → MCP runtime 自动 wrap 成 fail() 信封；agent 通过 ok / error.code / next_actions[] 三段式分支
- Server 注册：`createMcpServer` 在 admin/data/trade/security 之后 register 新的 strategy + observability tools；MCP_TOOLS Set 在 errors.test.ts 增加 14 个新工具名 → 通过 iter589 forward-invariant + iter877 reverse-invariant
- 测试覆盖：`src/mcp/strategy-tools.test.ts` 15 个 case（注册检查 + 8 个工具的 happy/error 路径 + 模板变量解析 + idempotency + destroy 全 lifecycle）；mock MCP server 捕获 handler 直接调用，无需 stand up real transport
- README "Agent integration" 章节扩展：MCP tool catalog 按 domain 分组列举每个工具 + 新增 iter26 章节解释 14 个新 tool 的语义
- 零业务逻辑新增：所有 14 个工具 wrap 已有 core helper（parsePlaybookSpec / deployPlaybook / simulateOrder / simulatePlaybook / gatherStatusReport / gatherDigest / replayOrder / getDrawdownState / resetDrawdownState 等）；本轮纯 surface completion

**Phase 25 — 订单决策日志 / replay（order forensic journal）** ✅
- 此前 19 轮 feature 累积下来，orders 表只存"最近一次检查"（last_checked_at / last_checked_price）；运营商问"为什么这条 trailing stop 在 $3030 触发而不是 4 小时前 ETH 首次到 $3000 时"必须翻 stdout + audit log + 推断 HWM 轨迹。这一轮加结构化的 forensic journal
- 新表 `order_check_log`（db v21）+ 复合索引 (order_id, checked_at)；7 个 decision 字面量（activation_pending / tracking_started / hwm_advanced / near_threshold / triggered_fired / triggered_skipped / error）
- 状态变化采样（cardinality 关键）：朴素"每 tick 一行"产生 ~10M 行/年（30s 间隔 × 10 active orders）；状态变化采样保留 5-20 行/订单生命周期，<0.05% 写入放大同样保留完整 forensic signal
- 纯采样谓词 `shouldLogCheck`：5 个 OR 条件触发记录（首条 / 终态决策 always-log / decision-state 变化 / HWM 变化 / proximity crossing）；其余 95%+ "still tracking unchanged" 跳过
- 纯模块 `orderJournal.ts`：`shouldLogCheck` 纯谓词 + `buildObservation`（trailing 路径走 evaluateTrailingTrigger 计算 post-tick HWM + threshold + decision；price 路径用 target_price_usd 直接）+ `recordCheckEntry` 抛错的 DB-backed enforcer + injection seam priorLookup + `replayOrder` 查询 + decisionMarker/decisionLabel 渲染辅助
- 新配置 `engine.orderJournal`：enabled (default false) + proximityPct (default 5%) + retentionDays (default 30)；操作员显式 opt-in，未启用零写入零开销
- Orders 引擎集成：在 5 个分支点调用 `recordCheckEntry`（price-fetch 失败 / 非 trailing 未 triggered / trailing 未 tracking / trailing 未 triggered / dry-run skip / fired / TX_REVERTED）；JE 关闭时函数 early-return 无开销
- 新 CLI `tradekit order replay <id> [--limit N] [--json]`：渲染 chronological timeline，每行 ts + price + HWM + threshold + 决策 emoji + 标签 + 可选 notes；启用提示 + 历史订单解释
- v21 迁移幂等 CREATE IF NOT EXISTS；现有 orders 引擎路径函数签名零变更；任何未开启 JE 的安装零行为变化
- 测试覆盖：`orderJournal.test.ts` 35 个 case（shouldLogCheck disabled 短路 / 首条 always-log / 终态 always-log / 决策变化 / HWM 变化（数值变 + null↔num） / proximity crossing 上下边界 / N/A 路径、buildObservation 终态 overrides（fired/skipped/error）+ trailing 4 种 transition、recordCheckEntry 启用门控 + injection seam + 多次 error 各自写入、replayOrder 排序 + --limit、pruneOrderCheckLog 时间过滤、end-to-end trailing 生命周期 7 ticks → 5 行采样）

**Phase 24 — 活动摘要 digest（windowed activity report）** ✅
- iter23 status（right-now snapshot）的自然补完：digest 回答"过去 N 小时/天发生了什么"；两者组成完整可观测性叙事
- 解锁日运维工作流：`tradekit digest --window 24h --format slack` 直接管道到 Slack incoming-webhook，无需中间 JSON 包装
- 新模块 `digest.ts`（~480 行）：纯 composer `gatherDigest` orchestrator + 4 个 section gatherer（trades / fires / safety / errors）+ 健康判定 `classifyVerdict` + 对照窗口 delta 计算 + `parseWindowMs` 输入解析
- 4 个 section：trades（按状态计数 + USD 总量 + 前 5 strategy 标签 + 前 5 base 符号）/ fires（窗口内 orders 终态分类 + schedules / rebalance last_run_at 计数 + 最近 5 笔 fills）/ safety（按 error_code 分类的 6 种 block + 当前 tripped drawdown scope + budget 利用率 > 80% 警告）/ errors（auditSummary 前 5 错误码 + 整体 error rate）
- 健康判定 3 级（healthy / attention / critical）+ 累积 reasons：drawdown trip 或 error rate > 25% → critical；error rate > 10% / budget util > 80% / 任何 safety block / 任何 order failed → attention；否则 healthy。所有 reasons 不丢失，渲染层挑最严重的；JSON 输出携带全部用于 agent disposition
- 3 种 format：text（终端可读多 section）/ slack（Slack mrkdwn `*bold*` `_italic_` `\`code\``，每 section 一行紧凑布局）/ json（结构化）；Slack 格式刻意不包 JSON envelope，让 cron 命令更短
- 对照窗口（`--compare`）：自动计算 immediately-prior 同长度窗口，渲染层显示 4 个核心 delta（trades / volume / fills / errors）；prior 自身也走 classifyVerdict 但 verdict 不影响 strict 退出码
- `--strict` 退出码 2（区别于通用错误 1）：cron / PagerDuty 集成对 critical 触发告警的标准模式
- 窗口范围 [1min, 90d]：超过 90d 的 audit 表太大，"top errors + recent fires" 信号衰减；操作员应分拆
- 性能：~6 个 indexed DB 查询全部 bounded by `since=window_start` predicate；sub-100ms on 百万行 audit 历史
- 纯 read-side 复用既有 helpers：recentTrades / listOrders / listSchedules / listRebalancePlans / auditSummary / recentAudit / listDrawdownStates / computeBudgetConsumption — 零新 SQL / 零新 schema / 零 RPC
- 测试覆盖：`digest.test.ts` 32 个 case（parseWindowMs 各单位 + 边界拒绝、trades 计数 + 窗口过滤 + topStrategies/topBases、fires 全 4 种终态 + 窗口外排除、safety 6 种 error code 分类 + currently-tripped、errors 排名 + rate、verdict 全升级路径 + critical-wins-over-attention、`--compare` delta math、零状态 graceful）

**Phase 23 — 运维 status 仪表盘（operational dashboard）** ✅
- 经过 17 轮迭代积累的 8+ 个独立 list 命令首次合并：操作员问"现在引擎在做什么 + 什么快触发 + 什么快爆熔断"不再需要跑 9 个命令心算拼图
- 与 `tradekit health` 明确分工：health 是财务摘要（portfolio + 7d PnL + approvals），status 是运维视图（engine workers + near-trigger orders + 下次 fire 时间 + drawdown + budget headroom）
- 新模块 `status.ts`（~440 行）：纯 composer `gatherStatusReport` orchestrator + 每 section 独立 gatherer + 纯 `computeThreshold` / `computePctToFire` 数学辅助（trailing 用 `water_mark × (1 ± trail/100)`，price_above/below 用 target_price 直接）+ `formatDurationSeconds` / `healthMarker` 渲染辅助
- 8 个 section：engine（worker 心跳 + ok/warn/stale 健康分级）/ orders（按 pctToFire 升序前 5 + stale-check 警告）/ schedules（按 next-fire 升序前 5 + overdue 检测）/ rebalance / playbooks / drawdown / budgets / activity（24h audit summary + top errors）
- 心跳健康分级：< 2× interval = ok（●）/ 2-4× = warn（◐）/ > 4× = stale（✕）/ 从未 tick = never-ticked（○）；engine status file 缺失时整体 notStarted=true 而非崩溃
- Near-trigger 算法零 RPC：用 orders 表的 last_checked_price + last_checked_at（orders 引擎每 tick 写入）；trailing 用 water_mark + trail_pct 算 threshold，距离用 `(current - threshold) / current × 100` 收敛到"还需移动多少％"
- Section 过滤：`--section orders,drawdown` 只填充指定 section，其他空（不浪费 DB 查询）；ALL_SECTIONS 默认全开
- 纯 read-side 合成：复用 listOrders / orderCountsByStatus / listSchedules / scheduleCountsByStatus / listRebalancePlans / listPlaybooks / listDrawdownStates / auditSummary / computeBudgetConsumption — 零新 SQL，零新 schema，零新 RPC
- 性能 sub-100ms：~10 个 indexed DB 查询 + 1 个 status file 读
- CLI: `tradekit status [--section S,S,...] [--json] [--watch N]`；--watch 30 适合事件响应时副终端持续观测；--json 给 cron / agent 消费
- 测试覆盖：`status.test.ts` 37 个 case（formatDurationSeconds / healthMarker、computeThreshold 全 trigger 类型、computePctToFire 上下方向 + 已过 trigger 边界、engine notStarted / ok / warn / stale / never-ticked 全分级、orders 排序 + top-5 限制 + 无 last_checked 排除 + stale-check 标记、schedules 排序 + overdue、drawdown configured/enabled/tripped、playbook 计数、activity audit 聚合、section filter 全/部分两路径、空 DB graceful）

**Phase 22 — 多场景回测对比（backtest compare）** ✅
- iter21 模板化的直接产物：操作员有了参数化 playbook 之后，最自然的下一步是参数扫描 — 同一个模板用不同 vars 跑多次，挑出赢家。pre-iter22 这意味着多次单独 `backtest playbook` + 终端输出心算对比，啰嗦到没人做
- 新模块 `backtestCompare.ts`（~340 行）：parseScenariosFile（结构+多错误聚合）+ prepareScenarios（文件解析、模板渲染、跨 scenario 同对约束）+ runComparison（共享价格序列 + 每 scenario 全新 balance 副本 + winner 计算 + 持久化）+ renderComparison（带 winner ★ 的对比表）+ runCompareFromFile orchestrator with priceFetcher 注入式 seam
- Scenarios 文件格式：`{name?, scenarios: [{name, file, vars}]}`，name 自动生成 fallback，file 路径相对 scenarios.json 目录（不是 CLI cwd）— 操作员预期 `./trail.tmpl.json` 内层指向"scenarios.json 旁边"
- 同对约束（same-pair invariant）：所有 scenario 必须引用同一个 base/quote。混对 scenarios 直接拒绝，建议拆成 per-pair 文件单独对比 — 对比是 across 策略不是 across 资产
- 鲜衬 balance 副本：每个 scenario 从同一份 initialBalance 起跑（JSON 浅拷贝够用 SymbolBalance 是 flat 字符串→数字 map），scenario 之间互不干扰；确定性 idempotent
- Winner 语义：PnL 最高的 scenario 中"至少 fired 一次"的那个；全部 halted 之前任何 fill → winner_idx=null（reporters 显示 "No winner: every scenario halted"，强行挑选会误导）
- 50 scenario 上限：comparison 是决策辅助不是大规模 sweep，超过 50 应分拆文件 — 验证器一次性聚合错误名所有违规
- 新表 `backtest_comparisons`（db v20）：name + scenarios_json + results_json + run_ids 逗号 join + base/quote/chain + window + winner_idx + created_at；个体 scenario 仍持久化为 backtest_runs 行所以 `backtest show <run_id>` 工作不变；comparison 行的 results_json 反序列化即可 re-render
- CLI 复合 dispatch：`backtest compare <file>`（运行）/ `backtest compare list`（recent）/ `backtest compare show <id>`（重渲染）— 通过 positional[2] 检查 "list"/"show"/else=file-path 分发
- 测试覆盖：`backtestCompare.test.ts` 22 个 case（parseScenariosFile 全错误路径 + 多错误聚合、prepareScenarios 模板渲染 + 缺失文件 + 混对拒绝、runComparison winner 排序 + no-winner case + balance 隔离、render winner ★ + No-winner、orchestrator end-to-end with injected fetcher + null series 错误路径）

**Phase 21 — Playbook 模板化（{{var}} 参数化）** ✅
- 新模块 `playbookTemplate.ts`（~420 行）作为 playbook 解析的纯 pre-processor：detect / parseTemplateVars / resolveVars / renderTemplate / renderPlaybookTemplate orchestrator + parseVarFlags / coerceVarsByDeclaration CLI 辅助
- 模板文件结构：vars 声明块（name → {type, default?, required?, description?}）+ 任意 string 字段内的 {{NAME}} 占位符；非模板文件（无 vars 节 AND 无 {{ 占位符）跳过整个 render，纯向后兼容
- 类型保留替换：whole-field "{{X}}" → 输出保留 var 的原始类型（number 保持 number，bool 保持 bool）；embedded "prefix {{X}} suffix" → String(var) 内插。区分必要：JSON 字符串永远是字符串，没有 whole-field 类型保留的话每个数字变量都要包裹逻辑解析器又拒绝
- 变量优先级链：defaults < --vars-file < --var；CLI --var 字符串值通过 coerceVarsByDeclaration 按声明类型晋升（"5" → 5 给 number 变量，"true"/"1" → true 给 boolean）
- 错误一次性汇总（保持与 playbook parser 同款"修一次"哲学）：parseTemplateVars 收所有非法声明、resolveVars 收所有缺失/类型错误、renderTemplate 收所有未定义变量引用（带 JSON 路径如 strategies[2].baseAmount）
- 未声明的提供变量 → warning 而非 error（typo 保护）；validate 视图把 warnings 渲染让操作员看到"--var FOOO 你是不是想说 FOO"
- 输入不被 mutate：renderTemplate 递归构造新对象，同一模板可以用不同 vars bag 调多次（A/B 测试场景）
- 共享 reader `readAndRenderPlaybookFile` 在 cli/playbooks.ts + cli/backtest.ts 之间复用 — 操作员先 backtest 再 deploy 同一个模板，两条路径错误/变量解析行为完全一致
- 新 helper `collectRepeatableFlag(argv, name)`（cli/helpers.ts）绕过 parseArgs 的单值折叠语义，让 --var X=1 --var Y=2 --var Z=3 都被采集
- CLI: validate / deploy / backtest playbook 全部支持 --var NAME=VALUE（可重复）+ --vars-file PATH（JSON object）；validate 视图额外渲染 resolved vars + warnings
- 不在 scope（v1）：条件 if/else 分支、循环、嵌套模板、--vars-file 数组语法 — 单纯变量替换够覆盖 95% 多资产模板需求
- 测试覆盖：`playbookTemplate.test.ts` 57 个 case（isTemplate 检测、parseTemplateVars 所有错误路径 + 多错误聚合、resolveVars defaults/required/类型/undeclared warning、renderTemplate whole-field 三种类型 + embedded 内插 + 多占位符 + 递归 + 严格剥离顶层 vars 节、错误路径名 JSON 位置、orchestrator passthrough 与 --var 误用、parseVarFlags / coerceVarsByDeclaration、与 parsePlaybookSpec 的端到端 round-trip、不可变性、ToolError 形状）

**Phase 20 — 资金回撤熔断（portfolio drawdown circuit breaker）** ✅
- 第一个 STATE-AWARE 安全原语 — 此前所有 guardrail（slippage / USD caps / gas budget / position limits / honeypot / strategy budgets）都是前向规则评估，不响应实际资本损失；这一层补上"资本曲线下跌就停手"的能力
- 新表 `drawdown_state`（db v19）：单行/scope（v1 仅 "global"），字段含 peak_usd / peak_at / tripped_at（null 表示未触发）/ last_value_usd / updated_at；INSERT-OR-REPLACE upsert + 局部 setDrawdownTripped 让 hot path 保持单 SQL
- 新配置 `safety.drawdownCircuitBreaker`：enabled / maxDrawdownPct（1-99）/ autoResumeAtPct（可选，null=manual reset only）/ scope（v1 literal "global"，预留 account: / chain: 变体）
- 新错误码 `DRAWDOWN_CIRCUIT_BREAKER_TRIPPED`（HTTP 403）；details 携带 scope / peakUsd / currentUsd / drawdownPct / thresholdPct / trippedAt / freshTrip；nextActions 指向 `health` + `config`
- 新模块 `drawdown.ts`（~340 行）：纯 `evaluateDrawdown` 6 种 outcome（no-state / ratchet-up / within-band / trip-now / still-tripped / auto-resume）+ 抛错 `enforceDrawdownCircuitBreaker` 真正的执行器；side-effects 严格映射 outcome → DB write
- 集成点：trade.ts step 5a-ter（position limits 之后、strategy budgets 之前），跳过 --simulate；通过 `holdingsMultiChain` 单次跨链 RPC 拿到 owner 总 USD（与 position limits 同款 fetch 形状，未来共享缓存简单）
- Ratchet up 隐式清除 tripped：portfolio 突破历史 peak 即视为完全恢复（覆盖 auto-resume 之外的"超额恢复"路径）；auto-resume 只覆盖部分恢复
- Fail-open 缺失数据：unpriced portfolio（oracle 故障、所有 token 离线）soft-skip，不触发 — 与 per-tx USD limits 同款 posture，避免外部 oracle 抖动级联导致 tradekit 全停
- Strict-less 阈值语义：drawdown >= threshold 触发（不允许等于 threshold 时仍交易）；auto-resume 用 strict less（drawdown < autoResumeAtPct 才恢复）— 边界 case 测试覆盖
- CLI: `tradekit safety drawdown` 渲染 peak / last / drawdown % / tripped at + auto-resume target USD；`tradekit safety reset-drawdown [--peak USD] [--yes]` 清 trip + re-anchor peak（默认 peak=last_value 防止立即再触发）；触发的 reset 需 'reset' confirmation 短语
- 测试覆盖：`drawdown.test.ts` 27 个 case（pure evaluator 全 6 种 outcome 含边界、ratchet 持久化、trip 持久化 + freshTrip flag、still-tripped 保留 tripped_at 不变、auto-resume 路径、ratchet 后 tripped 自动清除、resetDrawdownState 默认/显式 peak、reset 后允许交易）

**Phase 19 — 按策略 USD 预算（per-strategy spending caps）** ✅
- 新配置 `safety.strategyBudgets`：每条规则 `{tag, lifetimeUsd?, dailyUsd?, perFireUsd?}`，三种窗口任意组合，Zod refine 强制至少一个
- Tag 匹配支持精确（"arb-bot"）+ 后缀通配（"playbook:*" 匹配任意 playbook id）+ 通配根（"*" 匹配一切非空）；多条规则同 tag 匹配时全部必须通过（最严格的赢）
- 新错误码 `STRATEGY_BUDGET_EXCEEDED`（HTTP 403）；details 携带 tag / matchedRule / window / capUsd / spentUsd / predictedUsd；nextActions 指向 `strategies_list` 与 `config`
- 新模块 `strategyBudget.ts`（~340 行）：纯 `ruleMatchesTag` / `rulesMatchingTag` 选取器 + 纯 `evaluateRule` / `evaluateBudget` 阈值评估器 + 抛错 `enforceStrategyBudget` 真正的执行器 + 查询合并 `computeBudgetConsumption` 用于 CLI 视图
- 集成点：trade.ts 在 step 5a（position limits）之后、step 5b（predictive failure）之前调用 `enforceStrategyBudget`，需要 estimatedUsd（与 dailyUsdLimit 同一约束）+ req.strategy（已存在的 trade 字段）
- 持久化复用现有 `trades` 表：`usdSpentUnderStrategy(tag, sinceIso?)` SUM(quote_amount) WHERE strategy=? AND status IN ('success','pending')；v18 迁移加 `idx_trades_strategy_ts(strategy, timestamp)` 复合索引覆盖 lifetime + 24h 两种查询形状
- Hot-path 短路：未配置预算 / 未带 tag / estimatedUsd 缺失 / 非正 predictedUsd → 不查 DB；perFire-only 规则也不查 DB（只在配置了 lifetime/daily 时才发 SQL）— 多数 trades 命中 0 个规则 → 0 SQL
- Injection seam：`spentLookup` + `distinctStrategiesFn` 让测试完全离线跑（40 个 case 100ms）；生产路径走 `usdSpentUnderStrategy` + `listDistinctStrategies`
- CLI: `tradekit strategies --budget [--tag X] [--json]` — 每条规则 lifetime/24h spent + remaining + 百分比 + matched tags（wildcard 规则展开）；`--tag` 过滤到单条规则
- Pending trades 计入预算（与现有 dailyUsdVolume 同款）— 防止运营商在第一笔未确认时双花
- 测试覆盖：`strategyBudget.test.ts` 40 个 case（精确 tag / 后缀通配 / 根通配 / 多规则组合 / 三窗口边界 / perFire-first / daily-before-lifetime / 短路全路径 / 错误形状 / lookup 调用计数 + 窗口判定 / DB 集成 lifetime + 24h / computeBudgetConsumption 通配枚举 + remaining 截断）

**Phase 18 — 多策略 backtest（playbook backtest）** ✅
- 新模块入口 `simulatePlaybook` (in backtest.ts ~440 lines)：单 price series + 多个 order/schedule 共享 balance 的时间轴模拟器；复用 `isOrderTriggered` / `evaluateTrailingTrigger` / `matchesAt` 生产同源谓词
- BacktestStrategyType 联合扩展为 "order" | "schedule" | "playbook"；持久化复用现有 backtest_runs 表（spec_json 存 playbook，fires_json 每条 fire 加 strategyId + multiAction 标签）
- 多策略状态机：每个 order 独立维护 trailWaterMark + finalStatus；每个 schedule 独立维护 lastFireMinute + runCount + maxRuns；finalStatus 字面量收敛到 active / filled / cancelled / completed
- 共享 balance 顺序语义：每个 tick 内先评估所有 active orders，再评估所有 active schedules — 匹配生产引擎"orders tick 比 schedules 更频繁"的现实节奏；order 成交立即扣减 balance，同 tick 的 schedule 看到的是扣减后的余额（一次 DCA 因 trail 成交挪走 USDC 而 halt 是合规的语义）
- OCO 级联在模拟中触发：order fire 后，找同 group 的其他 active order 全部 cancel；emit `multiAction='oco_cascade'` 的合成 fire（priceUsd=0, baseDelta=0, quoteDelta=0），让操作员看清"另一条 leg 是几点几分被取消的"
- 单 base/quote 约束（v1）：所有 order + schedule 必须引用同一对 base/quote（一份价格序列）；rebalance plan 因本质多资产被显式拒绝；错误一次性汇总所有违规 + nextActions 指向单策略 `backtest order/schedule` 作为 fallback
- Order expires_at 在模拟中被尊重：过期单不会触发，状态置 cancelled
- Halt-on-insufficient-balance 不再杀整个 backtest：单条 strategy 被 park 为 cancelled，其它继续评估 — 操作员看到精确的"哪条 leg 在哪个 tick 因什么原因失效"
- Per-strategy stats：每条 strategy 的 fireCount / baseDelta / quoteDelta / finalStatus 单独汇总，渲染层按需求计算"哪条 leg 实际承载了交易"+"DCA 预算够不够撑到 trail 出场"
- CLI: `tradekit backtest playbook <file>` — base/quote 自动从 playbook 第一条非 rebalance 推断（操作员需要时通过 --base/--quote 覆盖）；reads 复用 parsePlaybookSpec；fire 行加 strategyId tag 渲染；JSON 输出携带完整 per_strategy 数组
- 测试覆盖：`backtest.test.ts` 新增 12 个 case（rebalance 拒绝 / mixed-base 拒绝 / mixed-quote 拒绝 / 多违规聚合错误 / OCO 级联 timing / 无 group 不级联 / 共享 balance trail+DCA / 单策略 halt 不影响其他 / per-strategy stats 正确性 / schedule fireCount 累积 / expiresAt 在模拟中被尊重 / 7 天端到端 smoke）

**Phase 17 — 声明式策略 playbook（declarative strategy bundles）** ✅
- 新表 `playbooks`（db v17）+ idx_playbooks_name + idx_playbooks_status；字段含 spec_json + source_hash + lifecycle status（deploying / deployed / destroyed / failed）+ deployed_at / destroyed_at
- 新模块 `playbooks.ts`：纯 `parsePlaybookSpec` 校验（结构化错误一次性汇总，避免改一处错一处的循环修复）+ `hashSpec`（canonical JSON 排序后 sha256，作为幂等性 key）+ `deployPlaybook`（4 阶段原子部署）+ `destroyPlaybook`（级联取消）+ `getPlaybookDetail`（hydrated 子原语视图）
- 4 阶段原子部署：(1) 结构校验 (2) insert deploying row → 拿到 id (3) 顺序创建每个原语，stamp `strategy=playbook:N`，OCO `group` 加 `pbN-` 前缀避免跨 playbook 误 cascade (4) commit → status=deployed；任一失败 → 已创建的全部 cancel + delete playbook row → 系统回到 pre-deploy 状态
- 幂等性：同 name + 同 hash redeploy 是 no-op（直接返回已有 id 和 alreadyDeployed=true）；同 name + 异 hash redeploy 抛 INVALID_PARAMS 指向 `playbook destroy <id>`；destroyed 状态的 playbook 同名可以干净重新部署
- 复用现有原语创建路径：`createOrderRow` / `createScheduleRow` / `createRebalancePlanRow` 一字不改；deploy 层是组合而非重新实现，原语的所有校验（trail_pct 范围、cron 合法性、targetPct 总和 100、startAt 在未来）按构造自动继承
- Tear-down 拓扑：通过 strategy=playbook:N 字符串匹配查找子原语（不用 FK，避免 3 表 join + 让 playbook 层独立演化）；已 terminal 的原语（filled / expired / cancelled / completed）分别报告但不动；单行 cancel 失败不阻塞其他行 cancel（错误收集到 errors[]）
- 字符串 tagging 让 playbook 成为 first-class 分析单元：`tradekit order list --strategy playbook:1` / `tradekit pnl --strategy playbook:1` / `tradekit trades --strategy playbook:1` 全部 work，不需要新表 / 新 SQL
- CLI: `playbook validate / deploy / list / show / destroy`；`validate` 不碰 DB 适合 CI 集成，`deploy` 输出每个子原语的 row id + 摘要 + tear-down 命令提示
- 测试覆盖：`playbooks.test.ts` 34 个 case（parser 顶层 + 各 type、`hashSpec` 稳定性 + key 顺序无关 + strategy 顺序敏感、deploy 快乐路径 + tag stamping + group namespacing、幂等性 3 路径（same/diff hash/post-destroy redeploy）、原子性回滚（中间失败 → 0 active 子原语 + 0 playbook row）、destroy 各路径（active cancel / terminal preserve / idempotent / unknown id）、playbook 间隔离（不串台 manual order / 跨 playbook OCO group 互不干扰）、完整 lifecycle smoke）

**Phase 16 — 历史策略回测（backtesting）** ✅
- 新表 `backtest_runs`（db v16）+ AUTOINCREMENT id + 持久化 spec / 初始余额 / 终末余额 / 价格序列窗口 / fire 时间轴 / 策略 PnL / hold PnL counterfactual
- 新模块 `backtest.ts`：纯时间轴 walker，无 RPC 无私钥无副作用；`fetchPriceSeries` 走 CoinGecko `/market_chart` 端点（≤1 天 5min / ≤90 天 hourly / >90 天 daily 自动分辨率）
- 完全复用现有 trigger 谓词：`isOrderTriggered`、`evaluateTrailingTrigger`、`matchesAt` — 回测行为与生产行为按构造一致；trailing 水位、cron 分钟匹配语义全部 by reference
- 两个一级子命令：
  - `tradekit backtest order` — 单一订单回测（price_below / price_above / trailing 三种 trigger，可携带 activation gate）
  - `tradekit backtest schedule` — 单一定时计划回测（cron / `--every` 简写，支持 `--max-runs` 上限）
- 余额跟踪 + halt-on-insufficient：每次 fill 实际扣减初始余额，余额不足直接发 `halt` fire 后终止策略（不静默吞 fail）
- PnL 数学：strategy 终末 USD（base × 结束价 + quote）与 initial USD（base × 起始价 + quote）的差；同时算 hold 对照（"什么都不做"）—— 算法核心问题是"我的策略相对 buy-and-hold 是否真的有 alpha"
- Fetcher 注入式 seam：`fetchImpl` 参数让测试用 vi.fn() 完全离线跑；生产路径走 retry=2 fetchWithTimeout（继承 price.ts 同款 timeout/retry 策略）
- 子命令 `list` / `show` 走持久化 row 路径，重新渲染不重新拉数据；`--json` 输出 = 序列化 row + 反序列化 fires/spec/balances 的 hydrated shape
- 显式不在 scope 的事项（文档里写清楚）：gas / slippage / safety guardrail / 多策略协同 / 跨资产篮子 — 数据分辨率 + 一次迭代体量都不支持，操作员要的是"触发器会不会 fire"的核心信号
- 测试覆盖：`backtest.test.ts` 40 个 case（`parseSinceDuration` 数值/单位/边界、`fetchPriceSeries` mock 解析 + dedupe + 非法值过滤、所有 trigger 类型的 fire 路径 + halt 路径、trailing 水位 ratchet、schedule cron 匹配 + 不重复 + maxRuns 截断、PnL 数学的 outperform/underperform、balance 大小写归一化、退化 series 边界）

**Phase 15 — 交易前自动 honeypot 探测** ✅
- 新表 `token_safety_cache`（db v15）+ 主键 `(chain, token_address)` + verdict / details_json / probe_usd / TTL
- 新配置 `safety.autoTokenCheck`：enabled / cacheTtlMs (24h 默认) / failOnSuspicious (默认 true) / probeUsd (默认 $5) / skipWhitelisted
- 集成入 trade.ts 预检流水线：`enforcePreflightSafety` 之后、aggregator HTTP roundtrip 之前 → 已知坏 token 永远不会消耗 aggregator 配额
- 双向探测：input + output 两侧都过 probe（"buy 起作用但 sell revert" 攻击两面都堵）
- 智能短路（最便宜的检查先）：disabled → native sentinel → 链 USDC/WETH/WBTC → 运营商 tokenWhitelist → cache hit → fresh probe
- Verdict → action 映射纯函数：ok=continue / honeypot=always-block / suspicious=block-when-failOnSuspicious / unknown=fail-open-warn（防止 oracle 抖动级联导致全停）
- 24h 缓存：第一笔交易承担 ~3-8s probe 成本，后续命中近零开销；新 token 列表里 grow 一行/(chain, token)
- 复用现有 `tokenSafety.checkTokenSafety`（probe 实现自始至终一个版本，CLI / auto / manual 共享）+ 探测函数注入式 seam 允许测试纯 mock
- 推送：阻断时发 `token.honeypot_blocked` 事件（critical 严重度）+ dedupKey 按 (chain, token, verdict) 防重
- 结构化错误：`TOKEN_BLOCKED` 携带 chain / side / token / verdict / fromCache / autoTokenCheck flag + nextActions[] 指向 `check_token`
- 测试覆盖：`autoTokenCheck.test.ts` 36 个 case（pure helpers / DB 缓存 TTL / verdict 映射 / 探测注入 / fail-open 路径 / nextActions 形状）

**Phase 14 — Prometheus metrics（生产级 observability）** ✅
- 三种 delivery surface 共享同一份 core：`tradekit metrics` CLI 一次性 stdout / web `/metrics` 路由 / engine `--metrics-port` 独立 listener
- 无状态 snapshot model：每次 scrape 都从持久化状态（DB row counts + 引擎 status 文件）现读现算，没有内存累积计数器、没有事件总线 instrumentation
- 标签 cardinality 严格控制：所有 label 都是有界枚举（status/chain/worker/error_code），绝不暴露钱包地址、USD 数值、token 数量、strategy tag、account label
- Top-N error-code 限流：audit_errors_total 只保留前 20 个 error_code，剩余进 "other" 桶，避免一个 runaway agent 生成的 1000 distinct codes 把 time-series index 炸掉
- 指标族（13 个 family）：trades / orders / schedules / rebalance plans / audit rows / audit errors / engine running / uptime / per-worker ticks / per-worker failures / per-worker staleness / pending trades / build_info
- 失败模式：metrics 渲染失败返回 500（Prometheus scrape-health 监控自动告警）；engine listener 端口冲突只 warn 不 crash supervisor
- 标准 HTTP 接口：`/metrics`（Prometheus 文本）+ `/healthz`（LB 探针），都是 GET，loopback 绑定为默认（运维通过反向代理 + 防火墙暴露）
- CLI smoke 验证：populated DB + 模拟 engine status 文件 → 21 个 case 涵盖标签转义、format 输出、每个 family 的 sample 形状、engine state derivation
- 测试覆盖：`metrics.test.ts` 21 个 case（escapeLabelValue、formatSample、formatPrometheus、gatherMetricsSnapshot 全部 family、renderMetricsResponse）

**Phase 13 — OCO（One-Cancels-Other）订单组** ✅
- 新列 `group_id`（db v14 增量 ALTER + 索引）+ `OrderRow` / `InsertOrderArgs` 携带
- DB 层新 helper：`findActiveGroupPeers(orderId, groupId)`、`cancelOcoPeers(firedOrderId, groupId, reason, message)` — 都是 indexed lookup，cascade 走单条 UPDATE
- 引擎集成：`runOrderTick` 在每个 engine-driven terminal transition（filled / failed / expired）后调用 `cascadeOcoIfApplicable`，对 group 内活跃 peer 一次性 cancelled，原因 `OCO_PEER_FIRED` 写入 last_error_code
- 操作员显式 cancel：默认不 cascade（手动取消是有意识的行为，cascade 会让人意外）；`--cascade` flag 选择性触发 group 清场，原因 `OCO_OPERATOR_CASCADE`（与引擎自动 cascade 区分）
- 验证：group id 字符集 `/^[A-Za-z0-9_-]+$/`、1-64 字符；CLI / MCP 层都用同一份正则
- 不会递归：cancelled 不是引擎 cascade 触发条件，3-peer 组里 #1 fired → #2 + #3 cancelled in one pass，停在 cancelled 状态
- 推送：每个被 cascade 取消的 peer 单独发 `order.cancelled_oco` 事件（info，dedup 按 cancelled-peer × fired-sibling）— 单事件粒度方便 Slack 过滤规则
- `order show <id>` 渲染 peer 列表 + 每个 peer 当前状态 + 取消原因；`order list --group X` 过滤组成员
- CLI: `--group <id>` flag on create + list；`--cascade` flag on cancel；usage 帮助包含 bracket / ladder 示例
- MCP: `order_create` schema 增 `group` (regex-validated)；`order_list` 增 `group` 过滤；`order_cancel` 增 `cascade` flag + 错误路径文档
- 测试覆盖：`orders.test.ts` 新增 16 个 case（group_id 验证全部错误路径、listOrders 过滤、findActiveGroupPeers / cancelOcoPeers 直接 unit、cancelOrderById --cascade 手动 cascade）

**Phase 12 — Portfolio rebalancing（target-weight plans）** ✅
- 新表 `rebalance_plans`（db v13）+ 全 sibling 模式（active / paused / completed / cancelled，与 orders / schedules 一致）
- 声明式 target 规范 `[{token, targetPct}]`，validate 强制 sum=100、无重复、范围合法
- 引擎 4th worker（默认 5min 间隔）— 复用 engine supervisor 全套基础设施（进程锁、状态文件、心跳、优雅停机）
- 漂移评估纯数学：`computeDrift(snapshot, targets)` → 每 target 的当前% / target% / drift% / deltaUsd
- 交易规划纯数学：`planRebalanceTrades(drift, {quoteToken, minTradeUsd})` → sells 先 / buys 后，按 USD 量大小排序，sub-min 跳过
- 失败隔离 + 部分成功：多 leg 中某 leg 失败不阻塞后续，最后整体记为 `executed`（全成功）/`failed`（部分失败）
- 所有 leg 完全复用 `executeTrade` → safety / position-limits / MEV / audit / notifications 全继承
- 配置驱动 cadence（5-field cron + 通配宏）+ 边界（start_at / end_at / max_runs）
- CLI: `tradekit rebalance create / list / show / pause / resume / cancel / run`；MCP: 7 个对应工具
- 通知事件：`rebalance.executed` / `rebalance.skipped` / `rebalance.failed`，包含 leg 级 description + tx hash + drift% telemetry
- 测试覆盖：`rebalance.test.ts` 41 个 case（validateTargets 各种异常路径、computeDrift 含边界 case、planRebalanceTrades 多 leg / sub-min / quote-exclusion、DB 完整往返、lifecycle 转换守卫、createRebalancePlanRow 各种 INVALID_PARAMS）

**Phase 11 — MEV-protected submission（private mempool）** ✅
- 新配置 `config.mev`：per-chain 私有中继 URL（Flashbots Protect / MEV Blocker / Merkle 等），全部免费 / 无 API key 强制要求
- 读写分离：reads 仍走 publicClient 多 RPC fallback；writes 走 walletClient 经 `buildSubmitTransport` 路由的私有中继
- 严格模式（默认 `fallbackToPublic: false`）：私有中继故障 → 交易 hard-fail，绝不泄漏到公共内存池；`fallbackToPublic: true` 切换到优雅降级
- viem `fallback([private])` 包裹保留单 leg 池级重试，规避瞬时 503；`fallback([private, public])` 是降级模式的链路
- 一行 wallet 集成：`loadWallet` / `loadReadOnlyWallet` 都通过新 helper 构造 walletClient transport — 所有 trade / transfer / approve / sweep / tx speedup / tx cancel 调用链自动获得保护
- doctor 探针：`mev:<chain> (<Label>) reachable in Nms`，附带 chainId 校验（误把 ethereum URL 配到 base 上立刻 fail）
- 安全：URL 在 `config show` / audit_log / MCP config 全部 host-only 脱敏（保留主机名供运维校验路由）+ `SENSITIVE_FIELDS` 新增 `privaterpc` / `private_rpcs` 等键
- 测试覆盖：`mev.test.ts` 23 个 case（config 解析、transport 选择、URL 脱敏、probeMevRpc 全套响应路径包括 chain mismatch / 网络错误）

**Phase 10 — Trailing stop-loss** ✅
- 新 trigger 类型 `trailing`：sells 跟踪 HWM、buys 跟踪 LWM；价格回撤 `trail_pct%` 即触发
- db v12 表重建迁移：扩展 orders 表（`trail_pct`、`water_mark_usd`、`target_price_usd` 改为 nullable）
- 可选 activation gate：`target_price_usd` 在 trailing 语义下变成"达到该价才开始跟踪"，例 "ETH 涨到 $3500 才启动 5% trailing stop"
- water mark 每 tick 改善时立刻落库（`updateOrderWaterMark`），引擎崩溃/重启后从最高/最低点继续跟踪 — 状态持久
- pure 逻辑层 `trailingStop.ts`：`evaluateTrailingTrigger` / `validateTrailingCreate` / `describeTrailingState`；CLI / MCP / engine 都消费同一份纯函数
- 复用现有 executeTrade 流水线 → safety / audit / notifications 全部继承（fill 通知 payload 额外携带 trailWaterMarkUsd + trailPct）
- CLI: `tradekit order create --trigger trailing --trail-pct 5 [--price <activation>]`；MCP: `order_create` 扩展 trigger="trailing" + trailPct + activationPriceUsd
- 别名 friendly：`--trigger trail` / `trailing-stop` / `trailing_stop` 都解析为 trailing
- 测试覆盖：`trailingStop.test.ts` 32 个 case（HWM/LWM 进展、阈值数学、激活门、边界）+ `orders.test.ts` 新增 7 个 case（trailing 创建验证、DB 往返）

**Phase 9 — Portfolio-aware 仓位限制（position limits）** ✅
- 新安全护栏：`safety.positionLimits[]` 给单个 token 的组合占比设上下限（`maxPctOfPortfolio` / `minPctOfPortfolio`）
- 跨链通配：`chain: "*"` 自动跨所有链聚合同 symbol/address 的余额
- Symbol + address 双重匹配；native 哨兵 `"NATIVE"` 与 ETH/BNB/POL 符号互通；EIP-55 大小写无关
- 触发时机：trade.ts 第 5a 步（紧跟 enforceSafety 之后、gas budget 之前）+ transfer.ts 对称位置 — 所有写交易都被这层覆盖
- 死锁防御：min-floor 已经低于阈值时不阻塞"不更差"的交易 — 否则一次手动漂移会永久卡住 DCA / 自动化流
- 价格缺失双策略：默认 soft-skip（oracle 故障不会导致工具完全不可用），`positionLimitsFailOnUnpriced: true` 切到 hard-fail
- 错误码 `POSITION_LIMIT_EXCEEDED`：details 字段精确给出哪个 token、当前 %、预测 %、目标 band — agent 单次重试即可纠正
- 性能路径：`positionLimits` 为空时零开销（无组合查询、无 RPC roundtrip），feature 完全 opt-in
- 测试覆盖：`positionLimits.test.ts` 37 个 case（delta 数学、apply 应用、限额评估、wildcard、async 包装、错误路径、holdings 转换桥接）

**Phase 8 — 统一 Engine Supervisor**（生产部署单元）✅
- 单进程守护 `tradekit engine run` 同时驱动 orders / schedules / reconcile 三个 worker，各自独立 cadence（30s / 60s / 60s 默认）
- 启动只解密一次 keystore → 三个 worker 复用；之前要起三个守护进程，现在一个 systemd unit 搞定
- 进程锁（复用 `processLock.withLock`）：第二个 `engine run` 立刻拿到 holder pid 失败，配合 stale-lock cleanup 处理崩溃恢复
- 优雅停机：SIGINT/SIGTERM 设置 stopRequested → 调度循环每≤1s polling → 正在执行的 tick 一定跑完再退出（绝不杀单中途的交易）
- Worker 错误隔离：一个 worker 抛出/返回 ok=false 不影响其它 worker，错误轨迹写入状态文件 lastError 字段
- 状态文件 `~/.tradekit/.engine.status.json` 每 tick 写入，`tradekit engine status` 跨 shell 读取（不需要 IPC）+ 派生 staleness 字段供监控脚本告警
- 心跳通知 `engine.heartbeat`（默认 1h）+ `engine.started` / `engine.stopped` 生命周期事件，复用之前 Phase 6 webhook 基础设施
- `--workers reconcile`（只读）跳过密码要求；`--dry-run` 全静默；`--once` 单轮（cron 友好）
- CLI: `tradekit engine run / status`；MCP: `engine_run` / `engine_status`
- 测试覆盖：`engine.test.ts` 23 个 case（调度、错误隔离、状态持久化、进程锁碰撞 + 释放、密码要求、worker 过滤、多轮假时钟）

**Phase 7 — DCA / 定时执行（recurring schedules）** ✅
- 持久化 `schedules` 表（db v11）+ 四态生命周期（active / paused / completed / cancelled）
- 自研 5-field cron 解析器（src/cron.ts，零外部依赖）：`*`、范围、列表、步长、`@hourly/@daily/@weekly/@monthly` 宏；POSIX dom/dow OR 语义
- 时长简写：`--every 30m/1h/6h/1d/7d`（编译为标准 cron 后入库，统一管道）
- 引擎 `runScheduleTick` 通过索引化 `next_run_at <= now` 查询拉取到期行，逐条 fire；每次 fire 后立即重算 `next_run_at`，杜绝同分钟重复触发
- 完全复用 `executeTrade`：safety / audit / 通知 / structured error 全部继承
- 边界：`--start-at`（早于此跳过）/ `--end-at`（终结 → completed）/ `--max-runs N`（次数上限）
- 失败处理：transient 与 terminal 都推进 `next_run_at` 但留在 active；错误轨迹写入 `last_error_*`，DCA 每个 cron 占位独立评估
- 运行遥测：`run_count` / `total_base_filled` / `total_quote_spent` / `last_run_tx_hash` — 一眼看到 "我累计买了多少 ETH"
- 通知事件：`schedule.fired` / `schedule.failed` / `schedule.completed`，复用上一阶段 webhook 基础设施
- CLI: `tradekit schedule create / list / show / pause / resume / cancel / run`；MCP: 7 个对应工具
- 测试覆盖：`cron.test.ts` 41 个 case（parser + nextRun + 闰年 + dom/dow OR + 时长简写）+ `schedules.test.ts` 25 个 case（DB 往返 + 验证 + 生命周期）

**Phase 6 — 推送通知 / Webhook 告警** ✅
- 配置式渠道：`config.notifications.channels[]`，按 URL host 自动检测 Slack / Discord / Telegram / 通用 JSON 四种格式
- 内置事件：`order.filled` / `order.failed` / `order.expired` / `trade.failed` / `approval.infinite`
- 每渠道过滤：`events[]` 白名单 + `minSeverity`（info / warn / critical）阈值
- 去重窗口：默认 60s 同 `(channel, dedupKey)` 抑制 — 失败循环不会刷屏
- 不变量：webhook 发送绝不抛出/绝不阻塞交易 — Slack 挂了不影响成交，错误只进 server.log
- 安全：webhook URL 在 `notify list` / `config show` / audit_log / MCP `notify_list` 全部 path-mask；仅磁盘 config (0600) 持有完整 URL
- CLI: `tradekit notify list / test`；MCP: `notify_list / notify_test`
- 测试覆盖：`notify.test.ts` 41 个 case（格式分发、Slack/Discord/Telegram payload、过滤、去重、并行 dispatch、HTTP 失败吞咽）

**Phase 5 — 条件单 / 限价单** ✅
- 持久化 `orders` 表（db v10）+ 五态生命周期（active / filled / cancelled / expired / failed）
- 五种 trigger × side 组合覆盖 limit-buy / limit-sell / stop-loss / take-profit
- 引擎 `runOrderTick` 复用 `executeTrade` 全流程 → 所有 safety guardrail + audit + structured error 自动继承
- transient vs terminal 错误分类：RPC blip / 限频留 active 下轮重试；revert / 政策违规直接 failed
- CLI: `tradekit order create | list | show | cancel | run` + 5 个 MCP 工具（order_create / order_list / order_show / order_cancel / order_run）
- 部署三种模式：长驻 daemon（`order run --watch`）/ cron 一次性（`order run --once --strict`）/ agent 调度（MCP `order_run`）
- 实测覆盖：`orders.test.ts`（pure predicate + DB roundtrip + validation 共 ~20 个 test case）

---

## Roadmap

按依赖关系分为三个阶段。同一阶段内的需求可以并行推进，跨阶段存在依赖关系。

### Phase 1 — 基础设施

后续所有功能依赖这一层，必须先完成。

**1. 配置文件系统**
- 使用配置文件（建议 `~/.tradekit/config.{toml,yaml}`）作为唯一的配置真相源
- 支持通过 `tradekit config` 子命令和后续 web 页面对配置进行修改
- 提供 schema 校验，启动时验证配置合法性

**2. SQLite 持久化层**
- 存储历史交易、audit log、持仓快照、token 元数据缓存等
- 数据库迁移（migration）机制，方便后续 schema 演进
- 路径默认 `~/.tradekit/tradekit.db`，可在配置中覆盖

**3. 助记词与多账户管理**
- 支持一套 BIP-39 助记词派生多个地址，并在地址之间切换
- 私钥/助记词在磁盘上加密存储（沿用现有 keystore 方案）
- 兼容当前的单私钥模式作为 fallback

**4. 多链支持**
- 至少支持 Ethereum / Arbitrum / Optimism / Base / BNB Chain / Polygon
- 抽象出 **chain profile**：chainId、RPC 列表、原生币、常用 token 地址、区块浏览器、聚合器支持情况
- **多 RPC failover**：使用 Ankr / LlamaNodes / 公共节点等免费 endpoint，自动切换不可用节点，识别并退避 rate limit

**5. MCP 工具设计规范（贯穿全部工具，是工程基线）**
- **结构化错误码**：例如 `INSUFFICIENT_LIQUIDITY` / `SLIPPAGE_EXCEEDED` / `NEEDS_APPROVAL` / `RPC_RATE_LIMITED` / `SAFEGUARD_TRIGGERED`，Agent 可基于错误码做条件分支
- **`next_actions` 提示字段**：每个工具返回值附带后续建议操作（例如返回 `NEEDS_APPROVAL` 时附带建议调用的 approve 工具及参数）
- **单位明确**：参数与返回值的文档中明确单位（wei vs ether、bps vs 百分比、秒 vs 毫秒），杜绝 LLM 在单位上犯错

### Phase 2 — 核心交易能力

依赖 Phase 1 的配置、SQLite、多链 profile。

**6. DEX 聚合器集成**
- 集成 1inch / 0x / OpenOcean / KyberSwap 等聚合器的免费 quote API
- 自动跨多个 DEX 寻找最佳价格、自动多跳
- 不重复实现 Uniswap V2/V3/V4 路由
- 聚合器选择可配置，支持 fallback（首选不可用时自动切换）

**7. 交易 simulation / dry-run**
- 所有写操作（swap / approve / bridge 等）支持 `simulate=true` 参数
- 通过 `eth_call` 或 Tenderly 免费额度模拟执行
- 返回预期的 token 余额变化、gas 消耗、滑点、revert 原因
- 这是 Agent 调用交易工具时的第一道护栏

**8. Agent 安全护栏**

所有项必须可在配置文件中开关与调参：
- 每日 / 单笔交易金额上限（按 USD 计价）
- Token 白名单 / 黑名单（按链分别配置）
- 合约白名单：只允许调用已知的 DEX / Router / Aggregator 合约
- 滑点上限（防止 Agent 把滑点设到离谱的值）
- 所有 Agent 操作的 audit log，写入 SQLite 独立表，包含调用方、参数、模拟结果、最终交易 hash、成功/失败原因

### Phase 3 — 数据展示与可视化

依赖 Phase 2 的交易数据与聚合器报价。

**9. 持仓与 PnL 追踪**
- **成本基础（cost basis）**：从历史交易记录推导每个持仓 token 的平均买入价
- **实时 PnL**：结合 K 线 / 聚合器报价计算未实现盈亏与已实现盈亏
- **Gas 累计支出**：按链统计原生币消耗及对应 USD 价值
- 可选：Uniswap V3 LP NFT 持仓追踪

**10. 链上数据查询工具（独立 MCP 工具）**
- 任意地址的多链 token 持仓查询（用于调研或 copy trading 参考）
- 新建池 / trending token 数据（DexScreener / GeckoTerminal 等免费 API）
- 钱包交易历史（优先用 Etherscan 等区块浏览器的免费层，超额时 fallback 到 RPC 扫描）

**11. Web 模式**
- 启动一个 web 页面查看配置、持仓、钱包信息、历史交易等
- 允许通过页面修改配置、发起交易
- 使用 OKX 等公开币价 API 提供 K 线数据，使用 TradingView 渲染 K 线视图
- 与 CLI / MCP 共享同一份配置与数据库

---

## 约束条件

- **生产级代码**：注重工程化、模块化、易维护
- **EVM only**：不做 Solana、SUI 等非 EVM 链
- **零付费依赖**：尽量不引入需要付费 API Key 的第三方服务
- **端到端测试**：所有功能必须实际跑通——不是只写单元测试，而是实际运行 CLI 命令、调用 MCP Server 工具，验证完整链路

---

## 测试环境

- 已完成钱包初始化，在 Base 链上存入了少量测试资金
- `.env` 中包含初始钱包的访问配置
- 也可直接使用 `.env` 中的私钥操作钱包
