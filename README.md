# tradekit

一个生产级的 CLI / MCP / Web 框架，供 AI 智能体在 EVM DEX 上交易 ERC-20 代币。

- **聚合器优先（Aggregator-first）** 的兑换路由 —— KyberSwap / OpenOcean 免费；0x / 1inch 可选。可配置 `mode: first|best`（竞速取最优价 vs 取最低延迟）。若模拟交易回滚，会自动回退到下一个聚合器（报价与实际调用之间的池子漂移是真实存在的）。
- **MEV 保护提交** —— 配置后，写入类交易会通过私有中继（Flashbots Protect、MEV Blocker、Merkle Private RPC 等）提交，而非走公开内存池（mempool）。可在主网缓解三明治攻击；在未配置中继的链上行为不变。读取仍走公开 RPC（多数中继会先把交易私下缓冲若干区块再传播）。`doctor` 每次运行都会探测中继的可达性与 chainId，从而在交易发生之前就暴露错误或失效的 URL。
- **条件订单（Conditional orders）** —— 通过一个轮询式的链下引擎实现限价单（limit）、止损（stop-loss）、止盈（take-profit）与 **移动止损（trailing-stop）**。`tradekit order create --side buy --trigger price_below --price 2900 --quoteAmount 100` 注册一个长期挂着的意图；移动止损用 `--trigger trailing --trail-pct 5` 来跟踪高水位（卖出时）或低水位（买入时），并在回撤/反弹时触发。`tradekit order run`（一次性或 `--watch`）让被触发的订单走与手动兑换**完全相同**的 `executeTrade` 路径，因此每一道安全护栏（guardrail）与审计记录都原样适用。具备持久化与可恢复性：引擎每个 tick 都把水位写入磁盘，重启后可从中断处继续跟踪。
- **Prometheus 指标端点** —— Web 服务器上的 `/metrics` 路由、引擎上的 `--metrics-port`，或作为一次性 CLI 的 `tradekit metrics`。按状态暴露交易/订单/定时任务(schedule)/再平衡(rebalance)的计数、审计错误明细、引擎运行状态与运行时长，以及每个 worker 的 tick 数 + 失败数 + 陈旧度（staleness）指标。无状态快照模型：每个指标都在抓取时从既有的 DB 状态 + 状态文件读取，不做内存计数器记账。标签是有界枚举（不含钱包地址、不含美元金额），可安全地在私有网络上暴露而不泄露运维细节。
- **OCO（One-Cancels-Other，一撤销全）订单组** —— 用 `--group <id>` 将两个或多个订单关联起来，当任一同组订单触发时，引擎自动撤销其余订单。可实现止盈或止损括弧单、多级止盈阶梯、"三选一退出价"等模式。级联在引擎驱动的终态转换（filled / failed / expired）时触发；手动撤销则通过 `--cascade` 主动启用。每个被撤销的同组订单都会带上原因 `OCO_PEER_FIRED` 或 `OCO_OPERATOR_CASCADE` 以便取证追溯，且每撤销一个同组订单都会触发一条 `order.cancelled_oco` 通知。
- **投资组合再平衡（Portfolio rebalancing）** —— 声明式的目标权重计划。`tradekit rebalance create --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]'` 注册一个计划；引擎周期性评估投资组合的漂移，当漂移超过配置阈值时通过 `executeTrade` 触发纠偏交易。每个计划覆盖一条链 + 一个账户；交易通过一个报价锚（默认是该链的 USDC）路由。会跳过低于阈值的交易腿，避免在微小纠偏上白烧 gas。可与以下功能组合：仓位上限（再平衡会遵守它）、MEV 保护（纠偏交易通过私有 RPC 路由）、统一引擎主管（supervisor）（作为第 4 个 worker 与 orders/schedules/reconcile 一同运行）。
- **定时/周期性交易（DCA）** —— 条件订单引擎的 cron 驱动兄弟功能。`tradekit schedule create --side buy --every 7d --quoteAmount 100` 注册一个每周定投；`tradekit schedule run` 通过 `executeTrade` 触发到期的交易。完整支持 cron 表达式（`0 10 * * 1`）、`@hourly`/`@daily`/`@weekly`/`@monthly` 宏、`--max-runs N` 生命周期上限，以及暂停/恢复/取消的生命周期管理。每次触发会发出一条 `schedule.fired` 通知。
- **统一引擎主管（supervisor）** —— `tradekit engine run` 在单个进程中并行展开 orders + schedules + reconcile 三类 worker。启动时只解密一次 keystore，进程级加锁（第二次调用会立即失败并报出持锁者的 pid），优雅停机会排空进行中的 tick，每小时推送一次 `engine.heartbeat` 以便监控确认存活。这是天然的生产部署单元 —— 用一个 systemd 服务/容器替代三个独立守护进程。
- **推送通知（Push notifications）** —— 将运维上值得关注的事件（`order.filled`、`order.failed`、`trade.failed`、`approval.infinite`）通过 Slack / Discord / Telegram / 通用 webhook 投递。格式会根据 webhook 主机自动检测。采用尽力而为（best-effort）方式，内置去重，避免某个卡住的订单刷爆你的频道。
- **多链（Multi-chain）** —— Ethereum、Base、Arbitrum、Optimism、BNB、Polygon，并具备多 RPC 故障转移（viem `fallback`，每条链覆盖 4 个公开端点）。
- **钱包（Wallet）** —— 加密的单私钥 keystore 密钥库，或 BIP-39 HD 助记词（mnemonic）并支持多账户（标签 + 索引）。地址簿（`tradekit address`）用于命名的收款人别名。
- **长期授权（Standing approvals）** —— `allowances` + `allowances audit`（带风险评分：无限额度授权给未知 spender、大额美元敞口、陈旧授权）+ `approve` / `revoke` / `revoke-all`。一等公民级别的 CLI + MCP 工具，让智能体可以独立于兑换之外审计并清理代币敞口。
- **安全护栏（Safety guardrails）** —— 单笔/每日美元限额、代币与合约白名单、滑点上限、gas 预算（按交易额的 % + 每条链的原生币上限）、每账户限速，以及 **投资组合感知的仓位上限**（将某代币的权重限制为投资组合的百分比 —— "ETH 最多 70%"、"USDC 至少保留 10%"；会用一个预测交易后组成的检查来校验该笔交易），还有 **交易前自动貔貅（honeypot）探测**（每个长尾代币在交易触发前都会做一次买入+卖出的往返模拟；按 (chain, token) 缓存 24 小时以摊薄成本）。被触发的护栏返回稳定的错误码（`SAFEGUARD_TRIGGERED`、`AMOUNT_EXCEEDS_LIMIT`、`GAS_BUDGET_EXCEEDED`、`POSITION_LIMIT_EXCEEDED`、`TOKEN_BLOCKED` 等）并附带 `next_actions` 提示。
- **模拟运行（Dry-run）** —— 每个写入类工具都支持 `simulate=true`（通过 `eth_call` + `estimateGas` 感知回滚）；模拟回滚时聚合器自动回退。`trade preview` / `trade preflight` 用于执行前的检视。
- **持久化（Persistence）** —— 使用 Node 22 内置的 `node:sqlite`，位于 `~/.tradekit/tradekit.db`（无需原生编译步骤）。五张表：`trades`、`audit_log`、`portfolio_snapshots`、`sync_bookmarks`、`schema_version`。
- **盈亏（PnL）** —— 基于加权平均成本基准，从你的交易历史计算已实现 + 未实现盈亏。多窗口（1d/7d/30d）、可按策略切分（`--strategy DCA`）、感知陈旧度（标记超过 48 小时的同步书签 sync bookmark）。
- **运维面板（Operator dashboard）** —— `tradekit health` 组合呈现投资组合 + 7 天 PnL + 交易质量 + 长期授权 + 结构化的 `recommendedActions[]`，供智能体调度。`--summary` 生成一行式、适合 cron/Slack 的摘要。
- **链上回填（On-chain backfill）** —— `tradekit trades sync` 扫描链上 Transfer 日志，导入在 tradekit 之外完成的交易（Uniswap UI、MEV 机器人、自定义路由器）。按 tx_hash 幂等；跨 cron 运行用书签续传。
- **卡住交易恢复（Stuck-tx recovery）** —— `tradekit pending` 对每一笔待处理交易做诊断（gas 定价过低 / nonce 被阻塞 / 陈旧）并给出结构化裁定；`tradekit tx speedup` / `tx cancel` 用于在相同 nonce 上做替换。
- **审计日志（Audit log）** —— 每一次 MCP / CLI / web 调用都会落入 `audit_log`，记录调用方、参数、结果、tx hash。用 `tradekit audit` / `tradekit audit summary` 检视。
- **Web UI** —— 配置、持仓、交易、PnL、回测（风险指标 + 策略 vs 持有的权益曲线）、执行质量（按聚合器/规模划分的滑点 + 建议）、审计，以及由 OKX 公开数据支撑的 TradingView Lightweight Charts K 线图。
- **面向智能体的结构化错误 + 结构化操作** —— 每个失败都有稳定的 `code` + `next_actions`；每个监控/诊断的成功结果都有 `severity` + `recommendedActions[]`，便于一目了然地分支处理。
- **对 cron 友好的监控** —— 在 health、doctor、verify、reconcile、trades sync 中均支持 `--summary`（一行式摘要）+ `--strict`（处于需采取行动的状态时以退出码 1 退出）+ `--watch N`（每 N 秒重跑一次，在 `--json` 下输出 JSONL 流）。
- **加密备份（Encrypted backup）** —— `tradekit backup export/restore` 用于全量状态归档；仅限 CLI（出于安全考虑不暴露给智能体）。
- **默认安静** —— CLI 默认只显示结果；`--verbose` 输出完整 DEBUG，`--quiet` 仅输出非 ok 的行。文件日志位于 `~/.tradekit/server.log`（在 `TRADEKIT_LOG_ROTATE_BYTES` 处轮转，默认 5MB）。

要求 Node ≥ 22.5.0（使用内置的 `node:sqlite`）。

## 目录

- [安装](#安装)
- [快速开始](#快速开始)
- [命令](#命令) — [钱包与账户](#钱包与账户) · [配置](#配置) · [交易](#交易) · [授权额度](#授权额度安全关键) · [数据与运维](#数据与运维) · [健康检查](#健康检查) · [全局标志](#全局标志) · [MCP 服务器](#mcp-服务器) · [Web 模式](#web-模式)
- [密码解析](#密码解析)
- [支持的链](#支持的链) — [自定义链](#自定义链)
- [安全护栏](#安全护栏)
- [Agent 集成](#agent-集成) — [错误结构](#错误结构) · [成功结构](#成功结构) · [预聚合摘要字段](#预聚合摘要字段) · [安装状态检查](#安装状态检查) · [单位](#单位)
- [数据存储](#数据存储)
- [测试](#测试)
- [许可证](#许可证)

## 安装

```bash
npm install -g tradekit
# or
npx tradekit help
```

## 快速开始

```bash
# 引导式一次性安装（钱包 + 活跃链 + 安全护栏 +
# 生产可观测性预设：决策日志、DB 保留策略、
# 带初始规则的告警监视器 —— 一个 Y 回答，可幂等重复运行）
tradekit init

# 运维面板 —— 投资组合 + 7 天 PnL + 长期授权 + nextActions
tradekit health

# 查看所有已配置链上的持仓
tradekit holdings

# 获取报价（不发送交易）
tradekit quote --chain base --direction sell --base ETH --quote USDC --baseAmount 0.001

# 模拟一次买入
tradekit trade buy --chain base --quoteAmount 10 --simulate

# 执行（省略 --simulate）
tradekit trade buy --chain base --quoteAmount 10

# 对 cron 友好的监控（单行输出，出问题时以退出码 1 退出）
tradekit doctor --summary --strict        # 配置 + RPC + 钱包完整性 + 运维卫生（保留策略、paper 账本、告警覆盖、引擎存活）
tradekit health --summary --strict        # 投资组合 + PnL + 告警
tradekit pending --summary --strict       # 卡住交易分诊
tradekit reconcile --summary              # 确认待处理交易的回执
```

`tradekit init` 会引导你在 hd 与 keystore 两种钱包之间做选择，并给出合理的默认值 —— 选 `[h]d`（默认）得到一个支持多账户的 12 词 BIP-39 助记词，或选 `[k]eystore` 得到单个加密的私钥。已经清楚自己想要什么？跳过 `init`，直接运行 `tradekit wallet create` 或 `tradekit account create-mnemonic`。

## 命令

### 钱包与账户

```bash
tradekit wallet create | import | export | view [--chain <name>]
tradekit account create-mnemonic | import-mnemonic | list
tradekit account add <label> [--index N] | use <label>
tradekit address list | add <name> <0x-addr> [--note "..."] | remove <name>
# 地址簿（iter614）：用于 `transfer --to <name>` 的命名收款人别名。
# 降低转账时的粘贴笔误风险 —— iter614 之前每次转账都要
# 粘贴完整的 0x 地址，而这是头号自伤式资损来源。
```

### 配置

```bash
tradekit config show
tradekit config get  <dotted.path>          # 例如 safety.perTxUsdLimit
tradekit config set  <dotted.path> <value>  # 值会尽可能按 JSON 解析
tradekit config push <dotted.path> <item>   # 追加到数组（例如 safety.tokenBlacklist.base）
tradekit config drop <dotted.path> <item>   # 从数组中移除
tradekit config validate                    # 对磁盘上的配置重新运行 schema 校验
tradekit config path                        # 打印配置文件路径
```

### 交易

```bash
tradekit quote --chain <name> --direction buy|sell \
  --base ETH|<addr> --quote USDC|<addr> \
  --baseAmount|--quoteAmount <decimal> [--slippage <bps>] [--auto-slippage]

tradekit trade buy|sell --chain <name> [--base ...] [--quote ...] \
  --baseAmount|--quoteAmount <decimal> [--slippage <bps> | --auto-slippage] [--strategy TAG] [--simulate]

# 执行前检视：展示安全裁定 + 模拟的余额/价格/滑点，但不提交
tradekit trade preview  buy|sell --chain X --base ETH --quote USDC --baseAmount 0.01 [--strict] [--json]
tradekit trade preflight buy|sell --chain X --base ETH --quote USDC --baseAmount 0.01 [--strict] [--json]
# preview = 完整预览，含余额 + 价格冲击 + 安全预检（只读 RPC，无交易）
# preflight = 仅安全预检裁定（go / no_go / warn）。在 `trade buy` 之前接入一道门。

# 报价 → 复核 → 带价格锁定的买入（iter641）：若实时重新报价偏离超过 N bps 则拒绝
tradekit quote --chain base --direction sell --base ETH --quote USDC --baseAmount 0.1 --json | \
  jq -r .amountOut | xargs -I{} tradekit trade sell --chain base --baseAmount 0.1 \
    --expected-out {} --max-deviation-bps 50
```

**`--auto-slippage`**（iter641）—— 从该规范交易对的已实现滑点历史推导滑点上限（中位数 + 安全余量）。需要 ≥5 个先前样本；否则回退到 `--slippage` / 配置默认值。当你宁愿让工具根据你的数据来调整滑点、而不是凭空猜一个数字时使用。

**`--strategy TAG`**（iter648）—— 用一个自由格式的标签给交易打标（例如 `DCA`、`swing`、`mev-arb`）。之后：`tradekit pnl --strategy DCA` 将 PnL 切分到某一个打了标的活动；`tradekit strategies` 列出所有出现过的标签。

**`--simulate`** 通过 `eth_call` + `estimateGas` 跑完整条流水线而不提交。若模拟回滚，聚合器会自动回退到下一个首选提供方（报价与实际调用之间的池子漂移是真实存在的）。

**聚合器选择（Aggregator selection）** —— 通过配置控制由哪个 DEX 聚合器（KyberSwap / OpenOcean / 0x / 1inch）来服务每次报价：

```bash
tradekit config set aggregator.preferred '["kyberswap","openocean"]'
tradekit config set aggregator.mode "best"           # iter602：并行竞速所有首选项，取最高的 amountOut
# 或：
tradekit config set aggregator.mode "first"          # 默认 —— 按顺序尝试，返回第一个成功的报价
```

**`mode: "first"`** 延迟最低，但当排在后面的聚合器报出更好的价格时会让你白白损失价格。**`mode: "best"`** 通过 `Promise.allSettled` 让所有符合条件的提供方一起竞速，返回最优报价，并把落败者放进 `result.alternatives[]` 中，使价差可审计。延迟 = 最慢提供方的响应时间。在波动大或流动性薄的交易对上用 `best`；在熟悉的交易对上（省下 200ms 比省几个 bps 更重要）用 `first`。

质量驱动的调优：`tradekit trades analyze --json`（iter623 聚合器统计）会带一个 `recommendedAggregator` 字段 —— 智能体通过将它与 `config.aggregator.preferred[0]` 比较来检测配置漂移。

### 条件订单

长期挂着的意图，当 base 代币的实时美元价格满足某个谓词时触发。引擎让被触发的订单走与手动兑换相同的 `executeTrade` 路径 —— 每一道安全护栏（单笔/每日美元上限、滑点限制、gas 预算、代币与合约白名单、限速）都原样适用，且每次成交都会落入 `trades` + `audit_log`，并在备注上盖戳 `[order #N]`。

```bash
tradekit order create --side buy --trigger price_below --price 2900 \
  --base ETH --quote USDC --quoteAmount 100 --slippage 50 --expires-in 7d
# → Created order #3   ○ active
#     Trigger: ETH ≤ $2900  (price_below)
#     Intent:  buy ETH for 100 USDC on base (account: main)
#     Expires: 2026-06-06T...

tradekit order list                                 # 默认只列活跃订单
tradekit order list --status all --json
tradekit order show 3
tradekit order cancel 3                             # 在 TTY 上交互式确认
tradekit order run --once                           # 单次 tick（对 cron 友好）
tradekit order run --strict --json                  # 守护进程：默认 watch=30
```

映射到五种经典订单类型：

| 类型          | `--side` | `--trigger`     | 必填项              | 使用场景                       |
|---------------|----------|-----------------|--------------------|--------------------------------|
| limit-buy     | `buy`    | `price_below`   | `--price`          | 抄底买入                       |
| limit-sell    | `sell`   | `price_above`   | `--price`          | 逢强卖出                       |
| stop-loss     | `sell`   | `price_below`   | `--price`          | 跌破阈值止损                   |
| take-profit   | `sell`   | `price_above`   | `--price`          | 涨破阈值锁定收益               |
| trailing-stop | `sell`   | `trailing`      | `--trail-pct`      | 在价格上涨时锁定利润 —— 当峰值回撤 N% 时触发 |
| trailing-buy  | `buy`    | `trailing`      | `--trail-pct`      | 买入反弹 —— 当低点反弹 N% 时触发                  |

**移动止损（Trailing stops）**（`--trigger trailing`）跟踪一个动态的高水位（卖出）或低水位（买入），当价格从该水位回撤 `--trail-pct N` 时触发。与静态的 `price_below` 止损不同，跟踪线会随价格向上移动 —— 每创一个新高，触发阈值就按相同比例抬升，因此一波上涨能在不可避免的回撤触发卖出之前捕获更多收益。

```bash
# 在高水位下方 5% 处跟踪，无激活门槛（立即开始跟踪）
tradekit order create --side sell --trigger trailing --trail-pct 5 \
  --base ETH --quote USDC --baseAmount 0.5

# “在 ETH 触及 $3500 之后才开始跟踪” —— 通过 --price 设置激活门槛
tradekit order create --side sell --trigger trailing --trail-pct 5 --price 3500 \
  --base ETH --quote USDC --baseAmount 0.5
```

`order show <id>` 和 `order list` 会渲染当前状态：一旦开始跟踪，会显示 `HWM $3500 → fires at $3325`。状态是持久的 —— 水位在每次刷新时都会写入磁盘，因此引擎重启后会从最近看到的高点恢复，不会丢失跟踪。

**订单决策日志 —— `tradekit order replay <id>`（iter25）。** 当 `engine.orderJournal.enabled=true` 时，orders 引擎会在每个**改变状态**的 tick（HWM 抬升、跨越接近度、触发、错误）上向 `order_check_log` 写入一行。朴素的"每个 tick 都记一条"在 30 秒间隔 × 10 个活跃订单下每年会产生约 1000 万行；而按状态变化采样通常将其降到每个订单整个生命周期 5-20 行，同时保留完整的取证信号。

**崩溃安全的触发记账（v33）—— 引擎绝不重复买入。** 过去有两个时间窗会导致重复触发：(1) 引擎在 tx 发送与 `recordScheduleFire` 之间崩溃 —— 重启后该 schedule 仍处于"到期"状态并重新触发；(2) 一笔被 `TX_TIMEOUT` 的交易（已发送、未确认）在 v32 的重试退避期间确认 —— 重试会重新提交该次发生（occurrence）。现在引擎在每次触发前都会跑一道**崩溃窗口守卫（crash-window guard）**：真实触发会把 `[schedule #<id>]` 盖进交易备注，paper 触发则带上 `source_type/source_id`，因此守卫可以问"是否已存在可归因于这一次发生的交易？"（时间戳 ≥ 该次发生原本的到期时间 —— 对于重试时段，窗口会回溯到已消耗的退避之前）。若证据存在（`pending` 或 `success`；回滚的行不算 —— 兑换没有成交），该次发生会**从证据交易记账**（金额 + txHash 就在该行上）：`run_count` 推进、累计额累加、`next_run_at` 前移，一条 `schedule.recovered` 警告通知解释发生了什么，日志记录 `recovered`。什么都不会被重复触发；恢复时会刻意跳过 on_fill 钩子（通知中会说明）。来自已正确记账的过去触发的交易总是早于当前的 `next_run_at`，因此绝不会误匹配。再平衡获得对称的守卫：来自被中断运行的**未确认交易腿**会推迟评估（`skipped_pending_legs`，不消耗配额、不盖失败戳），因为快照尚未反映它们 —— 一旦它们确认，漂移会从交易腿之后的投资组合重新计算，重新评估在结构上是安全的。

**订单补全了这个三角** —— 而对它们来说，这道守卫修复的是一个真实存在的线上 bug，不只是崩溃窗口：一笔 `TX_TIMEOUT` 会让订单保持 ACTIVE 以待下一个 tick 重试，因此一笔超时但实际已上链的交易会在六十秒后被重新触发。订单一生只触发一次，所以证据窗口是订单的整个生命周期（`created_at`）：任何盖了 `[order #<id>]`（或 paper source id）的 pending/success 交易都会从证据行记账成交（`fill_tx_hash`、`fill_price`、金额），日志记录 `recovered`（`order replay` 显示 ♻），一条 `order.recovered` 警告通知给出解释，并且 —— 关键在于 —— **OCO 级联仍会执行**：被记账的止盈会像真实成交一样精确地撤掉它的止损腿，因此不会留下孤立的退出单。恢复时跳过 on_fill 钩子，与 schedule 相同。

**瞬时失败重试（v32）—— 一个糟糕的 RPC 瞬间不再让每周一次的 DCA 损失整整一周。** 在 v32 之前，**任何**触发失败都会把 `next_run_at` 推进到下一个自然 cron 时段 —— 对终态失败（护栏违规或余额不足在重试时会同样失败）来说是正确的，但对瞬时失败（RPC 抖动、限速、聚合器打嗝）来说是一次静默的发生丢失。现在引擎会对失败分类：瞬时错误码把该行停泊到一个指数退避的重试时段（`engine.fireRetry` —— 默认 5m → 10m → 20m，3 次尝试；行上 `last_run_status='retry_pending'`、`retry_count`），而终态错误码立即推进。两道硬边界让重试保持安全：重试时段绝不跨越**下一个自然发生**（届时重试会重复触发 —— 下一个发生取而代之），也不跨越 `end_at`。预算耗尽则落回旧的推进并记录路径，并附带一条升级为 critical 的"N 次尝试后发生 LOST"通知 —— 单次重试尝试只发警告。成功、终态失败和耗尽都会重置计数器。同一机制也守卫再平衡评估（快照/钱包失败会重试；单腿失败不会 —— 已完成的交易腿绝不能重复执行）。在两个 replay 日志中都记为 `retry_scheduled` 决策；当 `next_run_at` 是一个重试时段时，`schedule show` / `rebalance show` 会标注出来。通过 `engine.fireRetry.enabled=false` 关闭。

**Schedule + rebalance 决策日志（v29）—— 三个引擎的取证一致性。** `engine.scheduleJournal.enabled` / `engine.rebalanceJournal.enabled` 把另外两个引擎的决策记入 `schedule_check_log` / `rebalance_check_log`，通过 `tradekit schedule replay <id>` / `tradekit rebalance replay <id>`（MCP：`schedule_replay` / `rebalance_replay`）回放。Schedule 记录每一次 fired / fire_failed / retired（end_at、max_runs）/ locked-skip / on_fill 钩子结果，附带运行编号和 tx hash —— "我的 DCA 今早为什么没触发？"变成一条命令。Rebalance 记录**每一个**被评估的发生 *包括处于带内（in-band）的*，并附 `max_drift_pct`：漂移历史本身就是重点 —— 运营者可以看着漂移逐渐逼近阈值，而不是被触发打个措手不及。两个引擎都是到期驱动的，所以基数天然有界（一个 6 小时 cron 计划每天写 ≤4 行）；唯一的重复情形 —— 引擎锁导致每个 tick 跳过重新评估 —— 在写入端去重。这些日志还会喂给统一时间线（`--kinds schedule.journal,rebalance.journal`），且 `schedule show` / `rebalance show` 会内联打印最近决策的尾部。可通过 `db.retention.scheduleCheckLogDays` / `rebalanceCheckLogDays` 修剪。

```bash
# 启用日志记录（选择性启用，默认关闭）
tradekit config set engine.orderJournal '{"enabled":true,"proximityPct":5,"retentionDays":30}'

# 经过若干 tick 之后，回放决策历史
tradekit order replay 14
```

示例输出：

```
Order #14  sell 1 ETH  trailing 5% (activation $3000)
  Status:        filled
  Chain:         base
  Created:       2026-05-01T12:00:00Z
  Filled:        2026-05-02T20:00:00Z

Decision timeline (5 entries):

  2026-05-01 12:00:00 UTC    $2800.00                                    ○ waiting for activation
  2026-05-01 14:00:00 UTC    $3050.00  HWM $3050.00 thr $2897.50         ⚙ tracking started, HWM seeded
  2026-05-01 18:00:00 UTC    $3200.00  HWM $3200.00 thr $3040.00         ⚙ HWM advanced
  2026-05-01 19:00:00 UTC    $3100.00  HWM $3200.00 thr $3040.00         ⚠ near threshold
  2026-05-01 20:00:00 UTC    $3030.00  HWM $3200.00 thr $3040.00         🔥 FIRED
```

**九种决策状态：**
- `activation_pending` ○ —— 移动订单正在等待激活门槛
- `tracking_started` ⚙ —— 激活后的首个 tick；HWM 已初始化
- `hwm_advanced` ⚙ —— 水位移动
- `near_threshold` ⚠ —— 价格首次进入触发阈值的 `proximityPct` 范围内
- `triggered_fired` 🔥 —— 引擎触发了订单
- `triggered_skipped` ⏸ —— 触发条件满足但引擎拒绝执行（dry-run、引擎锁、限速、余额、安全）；备注中带有原因
- `error` ✕ —— 引擎路径错误（取价失败、钱包加载失败、交易异常 —— 瞬时**与**终态皆有；备注中带有错误码，因此回放能回答"这个订单为什么翻成 failed？"）
- `edited_by_operator` ✎ —— 订单被原地编辑；备注中带有字段差异
- `expired` ⌛ —— 引擎退役了该订单（当前已 ≥ `expires_at`）；回放时间线会显式结束，而不是只是停止。也会由触发前的过期复查写入（一个在取价/keystore 解密期间越过 `expires_at` 的订单会被退役而非触发）

**采样决策**（`shouldLogCheck`）：当满足以下**任一**条件时，一个 tick 产生一条日志行：
1. 该订单的首条记录
2. 终态决策（`triggered_fired` / `triggered_skipped` / `error` / `expired`）—— 始终记录，以保留取证上下文
3. 决策状态相比上一条记录发生变化
4. 水位抬升（或 null↔数值 的转换）
5. 价格首次跨入阈值的 `proximityPct` 范围内

例行的"仍在跟踪、无变化"的 tick 会被完全跳过 —— 运营者不会损失任何信号，因为每一次有意思的转换都会得到一行记录。

**回放能回答现有界面回答不了的问题。** "这个移动止损为什么在 $3030 触发，而不是在四小时前 ETH 首次到 $3000 时触发？"日志显示 HWM $3200 是在 18:00 的尖峰时设定的 → 阈值变成 $3040 → 20:00 的回落跨过了它。没有这份日志，运营者只能看到 `fill_price: $3030`，还得去翻日志考古 HWM 的轨迹。

**基数成本。** 对一个活跃的移动订单，在 30 天、30 秒 tick 间隔下：86,400 个 tick。典型情况：5-20 行日志。相比朴素记录，这是 <0.05% 的写放大。

**修剪。** `pruneOrderCheckLog(beforeIso)` 已暴露出来，供 doctor 驱动的保留策略使用。v1 不会自动修剪；运营者可以把它接入自己现有的审计修剪 cron。

**OCO（One-Cancels-Other）组。** 用 `--group <id>` 关联多个订单。当任一同组订单经由引擎转入终态（filled / failed / expired）时，引擎自动撤销同组内其余处于活跃状态的订单。

```bash
# 经典的止盈或止损括弧单：任一先触发，就撤销另一个。
tradekit order create --side sell --trigger price_above --price 4000 \
  --base ETH --quote USDC --baseAmount 0.5 --group eth-exit

tradekit order create --side sell --trigger price_below --price 2700 \
  --base ETH --quote USDC --baseAmount 0.5 --group eth-exit

# 三级止盈阶梯 —— 任一级先触发，就撤销其余几级。
for price in 3500 4000 4500; do
  tradekit order create --side sell --trigger price_above --price $price \
    --base ETH --quote USDC --baseAmount 0.2 --group tp-ladder
done

# 手动撤销 —— 默认不级联（单腿更新是刻意为之）。
tradekit order cancel 42

# 手动撤销并级联 —— 把组内其余订单也一并撤销。
tradekit order cancel 42 --cascade
```

**组 id 格式：** 字母数字 + 短横线 + 下划线，≤ 64 字符。由运营者提供；除语法外 tradekit 不强制任何形状约束（组可以跨不同的方向、不同的触发器，甚至不同的链 —— 关联靠的是字符串匹配）。

**为什么同时要自动 + 手动级联？** 在终态转换上的自动级联（`OCO_PEER_FIRED`）是规范的 OCO 语义 —— "触发其一，撤销其余"。不带级联的手动撤销适用于"更新一条腿、保留其余"这种常见情形；在手动时也级联会让运营者意外。`--cascade` 标志用于主动表达"我想放弃整个组" —— 同组订单会带上原因 `OCO_OPERATOR_CASCADE`，以便事后审计能区分运营者意图与引擎动作。

**`order show <id>` 渲染同组状态** —— 当订单带有 `group_id` 时，show 的输出会列出组内每一个同组订单及其当前状态，以及（对已撤销的同组订单）撤销原因。免去为了解括弧单状态而另跑一次 `order list --group X`。

**引擎生命周期。** 订单只在 `tradekit order run`（或等价的 `order_run` MCP 工具）被调用时才会触发。三种部署模式：

1. **长驻守护进程** —— 在 systemd / Docker / `pm2` 下运行 `tradekit order run --strict --json --watch 30`；每个 tick 发出一条 JSONL 记录。
2. **Cron** —— `* * * * * tradekit order run --once --strict --json >> /var/log/tradekit-orders.log`（每分钟一个 tick，退出码作为告警门槛）。
3. **智能体驱动** —— 一个 MCP 智能体（例如在 Claude Desktop 内）按自己的节奏调用 `order_run`。

每个 tick 都会通过 CoinGecko → DexScreener 回退（与 `tradekit price` 相同的预言机栈）为每个活跃订单的 base 代币定价，评估触发器，并在每一行上盖戳 `last_checked_at` + `last_checked_price`，无论是否触发 —— 因此 `order list` 让你无需开启 DEBUG 日志就能确认引擎确实在运行。

瞬时错误（RPC 抖动、CoinGecko 限速）会让订单保持**活跃**，以待下一个 tick 重试。终态错误（回滚、护栏触发、余额不足）会把该行翻成 `failed`，这样一个配置错误的订单就不会在数百个 tick 里持续烧 gas。这一权衡在订单的 `last_error_code` 列中按错误码逐一记录。

### 引擎（统一引擎 supervisor）

生产部署单元。`tradekit engine run` 是单个进程，按各自独立的节奏轮询订单（order）+ 定时任务（schedule）+ 对账（reconcile）。它取代了原先三个独立的 `* run` 守护进程，统一为一个 systemd 服务 / 一个容器 / 一个健康检查 / 启动时一次 keystore 解密。

```bash
# 守护进程模式 —— 永久运行，每个 worker 按自己的间隔轮询
WALLET_PASS=$(cat ~/.wallet-pass) tradekit engine run

# 一次性执行（适合 cron，跑完一轮 tick 即退出）
tradekit engine run --once --strict --json >> /var/log/tradekit-engine.log

# 子集部署 —— 只跑只读的 reconcile worker（无需密码）
tradekit engine run --workers reconcile

# 模拟运行（dry-run）—— 评估触发条件 + 推进记账，但不发送 tx
tradekit engine run --dry-run --once

# 从另一个 shell 查看正在运行的 engine
tradekit engine status              # 人类可读
tradekit engine status --json | jq  # 供监控脚本使用
```

**Workers**（可通过 `config.engine.workers.*` 配置）：

| Worker | 默认间隔 | 需要密码？ | 说明 |
|---|---|---|---|
| `orders` | 30s | 是（dry-run 除外） | 价格触发的条件订单 |
| `schedules` | 60s | 是（dry-run 除外） | Cron 驱动的定投（DCA）/ 周期性交易 |
| `reconcile` | 60s | **否**（只读） | 待确认 tx 的回执扫描 |
| `rebalance` | 300s | 是（dry-run 除外） | 投资组合漂移纠正（目标权重计划） |
| `digest` | 300s | **否**（只读） | v31：通过通知渠道推送每日摘要（在 `notifications.digest.enabled` 启用前为 no-op） |

**进程锁。** supervisor 在启动时获取一个文件系统咨询锁（`~/.tradekit/.lock.engine`）。第二次调用 `engine run` 会立即失败，返回 `WALLET_LOCKED` + 持锁者的 pid + 运行时长。陈旧锁清理机制会处理上一次崩溃留下的运行。它与现有的钱包/账户锁配合，让 engine 能与一次性的 `wallet create` / `account add` 命令和谐共存。

**优雅关停。** `SIGINT` / `SIGTERM` 会设置一个停止标志；调度循环在每次休眠间隙（≤ 1s）轮询该标志。正在进行的 tick **总是允许跑完** —— 绝不在交易中途杀死一个 tick。在进行中的 tick 返回后，supervisor 写入最后一次状态更新、释放锁、发出 `engine.stopped` 并退出。

**心跳。** 每隔 `config.engine.heartbeatIntervalMs`（默认 1h），supervisor 通过通知系统发出 `engine.heartbeat`。载荷包含运行时长 + 每个 worker 的 `_ticks` / `_failures` 计数。监控渠道无需解析日志即可确认“engine 仍存活”。设为 0 可禁用。

**状态文件。** 每次 tick 时 supervisor 都会写入 `~/.tradekit/.engine.status.json`，包含每个 worker 的计数、最近 tick 的时间戳和最近的错误消息。`tradekit engine status` 读取该文件并补充时效性信号（距每个 worker 上次 tick 的秒数 + supervisor pid 是否仍存活）。监控脚本可通过 `--json` 输出对停滞的 worker 告警。

**全局 kill switch（iter28）。** 一条命令即可为事件响应停掉所有交易路径：

```bash
tradekit engine lock --reason "investigating tx revert spike"
# 现在所有交易路径都会以 ENGINE_LOCKED 拒绝。

tradekit engine unlock
# 交易在下一个 tick 恢复（手动交易则立即恢复）。
```

engine 被锁定时哪些会被阻断：

| 面向 | 锁定时的行为 |
|---|---|
| 手动交易（`trade.ts`） | 在 `executeTrade` 顶部以 `ENGINE_LOCKED` 硬拒绝 |
| 订单引擎 | **继续轮询**（HWM 跟踪、last_checked 更新）但**跳过触发成交路径**。移动止损保持正确定位以便恢复。 |
| 定时任务引擎 | 跳过触发成交；`next_run_at` 不推进（因此错过的那次触发会在解锁后立即发生）。 |
| 再平衡引擎 | 完全跳过漂移评估（不抓取投资组合 —— 省下昂贵的多 token RPC）。 |
| Post-fill hooks | 跳过 —— 纵深防御（其父级触发成交本就会先被跳过）。 |
| `--simulate` 交易 | 豁免 —— 只读，不改状态。 |
| 只读命令（status、holdings、portfolio…） | 始终允许。 |

**为什么订单继续轮询却跳过触发成交。** 运维人员希望移动止损在锁定期间保持已定位状态。如果上锁时某条移动止损的 HWM 是 $3500，而锁定窗口内 ETH 涨到 $3800，那么 HWM 应推进到 $3800，这样当运维人员解锁时阈值是最新的。完全跳过 tick 会让该移动止损停留在陈旧状态，恢复时可能误触发。

**跨重启持久化。** 锁状态保存在 `engine_lock` 数据库表中（单行）。重启后的 engine 在启动时读取该行并尊重既有的锁。CLI + engine + MCP server 共享同一份状态。

**错误形态。** `ENGINE_LOCKED` 携带 `details.{lockedAt, reason, lockedBy, blockedContext}` 以及指向 `engine_unlock` 的 `nextActions[]`，供在自动化工作流中遇到该拒绝的 agent 使用。`status` 仪表盘会在 engine 区块顶部醒目地展示锁定状态。

**通知事件。** 在 unlocked→locked 转换时发出 `engine.locked`（warn）；反向转换时发出 `engine.unlocked`（info）。幂等的重复上锁/解锁不会重复通知。这对寻呼类渠道很有用 —— 密钥泄露场景应当既锁定 engine，又在运维人员手机上发出通知。

**systemd 模板**，对应生产部署模式：

```ini
[Unit]
Description=tradekit engine
After=network-online.target

[Service]
Environment=WALLET_PASS=...
ExecStart=/usr/local/bin/tradekit engine run --json
Restart=on-failure
RestartSec=10
KillSignal=SIGINT          # 优雅关停 —— 排空进行中的 tick
TimeoutStopSec=60          # tick 超时 + 少量缓冲

[Install]
WantedBy=multi-user.target
```

`tradekit order run` 和 `tradekit schedule run` 仍是一等公民 —— 想做按功能拆分部署的运维人员（每个 worker 用不同主机、各自独立的密码环境等）可以继续使用它们。

### 投资组合再平衡

声明式的目标权重计划，把投资组合拉回到运维人员定义的配置比例。每个计划周期性地评估实时的投资组合构成；当最大漂移超过阈值时，engine 通过与手动兑换相同的 `executeTrade` 流水线触发纠正性交易。

```bash
# 创建一个“core”60/40 的 ETH/USDC 计划，每 6 小时评估一次。
tradekit rebalance create --name core-folio \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --drift-threshold 5 --min-trade-usd 10 \
  --chain base --account main

tradekit rebalance list                        # 活跃计划
tradekit rebalance show 1                      # 详情，含上次运行的遥测
tradekit rebalance run --once --dry-run        # 评估但不触发成交
tradekit rebalance pause 1                     # 暂停期间 engine 忽略它

# 原地重新配权 —— run_count / max_runs 记账 + 上次运行遥测
# 得以保留（cancel+create 会重置它们）。与
# `order edit` / `schedule edit` 同样的编辑纪律；冻结项：chain、account、quote token、start-at。
tradekit rebalance edit 1 --targets '[{"token":"ETH","targetPct":70},{"token":"USDC","targetPct":30}]' \
  --drift-threshold 8

# Paper 变体：漂移以虚拟账本为基准衡量，纠正性
# 腿在其中成交 —— 不读链、不用 keystore、不做真实交易。先注资。
tradekit paper deposit --chain base --token ETH  --amount 0.5
tradekit paper deposit --chain base --token USDC --amount 1000
tradekit rebalance create --name paper-folio --paper true \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --chain base --account main
```

**漂移如何计算。** 对每个目标 token：`currentPct = tokenUsd / portfolioUsd × 100`。当 `max(|currentPct - targetPct|) ≥ driftThresholdPct` 时计划触发成交。纠正性交易的计算方式如下：
1. 对每个超配的目标：把超出的美元额度卖出兑成 `quoteToken`。
2. 对每个欠配的目标：用 `quoteToken` 买入不足的美元额度。
3. 先执行卖出，以提升可用于买入的 quote 余额。
4. 单腿交易低于 `minTradeUsd` 的跳过 —— 避免在微小纠正上烧 gas。

quote 锚定（计划的 `quoteToken`，默认为链上 USDC）被排除在交易列表之外 —— 它的权重会通过这些交叉交易自然结清。

**配置旋钮：**

| 字段 | 默认值 | 作用 |
|---|---|---|
| `targets[]` | — | 必填。`{token, targetPct}` 列表。必须正好加总为 100（±0.01）。 |
| `driftThresholdPct` | 5 | 触发成交所需的最小漂移（任一目标的 `|current% - target%|`）。 |
| `minTradeUsd` | 10 | 单腿最小交易规模。低于阈值的腿跳过。 |
| `quoteToken` | 链上 USDC | 路由锚定（symbol 或 address）。 |
| `cron` | `0 */6 * * *` | 评估节奏（5 字段 UTC cron；接受 macro）。 |
| `slippageBps` | 配置默认值 | 单笔交易滑点上限（其上限受 `safety.maxSlippageBps` 封顶）。 |
| `startAt` / `endAt` / `maxRuns` | — | 可选边界。 |

**引擎集成。** 再平衡是统一引擎 supervisor 中的第 4 个 worker（与 orders / schedules / reconcile 同级），默认 tick 间隔 5 分钟。该 worker 默认启用；不需要它的部署可设置 `engine.workers.rebalance.enabled: false`。当没有配置任何计划时，tick 是一个廉价的 no-op（在 `dueRebalancePlans` 为空时提前返回）。

**生命周期。** 与 schedule 相同：`active → paused → active` 循环，终态为 `completed`（达到 max_runs 或超过 end_at）+ `cancelled`。失败的触发成交保持 active，等待下一个 tick 重试。通知事件：`rebalance.executed`（info，body 中含腿级结果）、`rebalance.skipped`（info —— 带内或 dry-run）、`rebalance.failed`（warn）。全部可与其他 engine 事件使用相同的 Slack/Discord/Telegram 渠道组合。

**与其他安全原语组合。** 一笔再平衡交易走的是与手动买入相同的安全流水线：单 tx 美元上限、每日美元上限、滑点上限、gas 预算、token 与合约白名单、仓位上限。如果再平衡交易会把 ETH 推过 `safety.positionLimits[].maxPctOfPortfolio`，则该交易以 `POSITION_LIMIT_EXCEEDED` 拒绝（下一条腿继续执行）。如果该链配置了 MEV 保护，再平衡交易会通过私有 relay 路由。

### 策略剧本（playbook，声明式策略包）

playbook 是一个 JSON 文件，把一套完整的交易策略声明为一组原语 —— 订单、定时任务、再平衡计划 —— 它们被原子化地一起部署、一起拆除。在有 playbook 之前，部署一个真实策略意味着手敲 4-6 条独立的 CLI 命令、毫无事务安全性；部署中途失败会留下一个半成品策略处于活跃状态，而拆除则要靠记住该取消哪些 ID。playbook 让原子性、幂等性、拆除这三件事都变得显式且可复现。

```bash
tradekit playbook validate ./eth-strategy.json    # 解析 + 结构检查；不写 DB
tradekit playbook deploy   ./eth-strategy.json    # 原子化全量创建；任何失败都回滚
tradekit playbook list                            # 所有已部署的 playbook
tradekit playbook show 1                          # 每个原语的部署状态
tradekit playbook destroy 1                       # 取消每一个由它拥有的原语
```

**示例 spec。** 移动止损 + OCO 括号单（止盈+止损）+ 每周定投（DCA），全部以同一 chain/account 计价：

```json
{
  "name": "eth-bracket-with-dca",
  "description": "trailing stop with bracket + weekly DCA",
  "chain": "base",
  "account": "main",
  "strategies": [
    { "id": "trail", "type": "order", "side": "sell", "trigger": "trailing", "trailPct": 5, "baseAmount": 1, "base": "ETH", "quote": "USDC" },
    { "id": "sl",    "type": "order", "side": "sell", "trigger": "price_below", "price": 2700, "baseAmount": 1, "base": "ETH", "quote": "USDC", "group": "bracket" },
    { "id": "tp",    "type": "order", "side": "sell", "trigger": "price_above", "price": 4000, "baseAmount": 1, "base": "ETH", "quote": "USDC", "group": "bracket" },
    { "id": "dca",   "type": "schedule", "side": "buy", "every": "7d", "quoteAmount": 100, "base": "ETH", "quote": "USDC",
      "onFill": { "type": "createOrder", "spec": { "side": "sell", "trigger": "trailing", "trailPct": 5,
                  "base": "ETH", "quote": "USDC", "baseAmount": "{{filled.baseAmount}}" } } }
  ]
}
```

**Post-fill hooks 是一等的 spec 字段。** 上面的 `dca` 条目内联声明了 iter27 的 `on_fill` hook：每次每周触发都会在刚买入的那一份额度上自动创建一条移动止损。在此之前，声明式格式无法表达“DCA + 自动括号单”——这是最常见的复合策略——运维人员只能先部署，再用 `schedule edit --on-fill` 逐个手改每个定时任务。Hook 的 `{{filled.X}}` 占位符是小写点分形式，因此它们能原封不动地穿过（仅识别大写的）playbook 模板渲染器 —— 一个模板可以用 `{{TRAIL}}` 参数化 hook 的 `trailPct`，同时把 `{{filled.baseAmount}}` 留给 engine。`playbook replace` 把 `onFill` 当作可原地编辑的字段（hook 变更后运行计数器得以保留）；`backtest playbook` 会**模拟**这些 hook —— 每次定时任务触发都会通过生产环境的 `renderOnFillSpec` 渲染器（含带类型的 `{{filled.X}}` 替换）派生出后续订单，按模拟成交规模定大小，并从下一个数据点开始评估，与实时 engine 完全一致。完整的 DCA+括号单复合策略可端到端回测。

**4 阶段原子部署。**
1. *校验*：解析 JSON，对每个 strategy 条目做结构校验，将 chain/account/token 符号对照实时配置解析。不写 DB —— 失败时在一条消息里列出全部错误，让运维人员一次性把文件改对。
2. *插入 playbook 行*，`status='deploying'`。此时已存在行 id 可用于策略标签盖戳。
3. *顺序创建原语*，走与手动 CLI 命令相同的 `createOrderRow` / `createScheduleRow` / `createRebalancePlanRow` 路径。每个原语都在既有的 strategy 列上盖戳 `strategy = "playbook:<id>"`。OCO 的 `group` 名称会加上 `pb<id>-` 前缀，这样两个本地 group 同名的 playbook 不会通过 OCO 级联意外地互相取消。
4. *提交*，将 status 翻转为 `deployed`。任何失败时：取消本次调用中已创建的每一个原语 + 删除 playbook 行 → 让系统回到部署前状态。错误信息包含底层的 `INVALID_PARAMS` 码，以及 `details.rolledBack` 中已回滚原语的数量。

**幂等性。** 每个 playbook spec 会被规范化（对象 key 按字母序排序）并做 SHA-256 哈希。用**相同名称**重新部署**相同哈希** → no-op（返回既有 playbook id，`alreadyDeployed=true`）。用相同名称重新部署**不同哈希** → INVALID_PARAMS 错误，提示先执行 `playbook destroy <id>`。一个先前已被销毁、同名的 playbook 可以干净地重新部署（查找范围限定在未销毁的行）。

**拆除（`playbook destroy <id>`）。** SELECT 出每个 `strategy = 'playbook:<id>'` 的原语，走与手动取消相同的 `cancelOrderById` / `cancelScheduleById` / `cancelRebalancePlanById` 路径逐个取消。已处于终态的原语（filled / expired / cancelled / completed）会在 `alreadyTerminal` 中报告并保持不动。个别行的取消错误不会中止整体 —— 它们收集进 `errors`，这样一个损坏的 OCO 对端不至于妨碍销毁包里的其余部分。

**可组合性。** 由于原语都盖戳了 `strategy=playbook:<id>`，所有现有的策略标签过滤器都能作用于整个包：

```bash
tradekit order list      --strategy playbook:1
tradekit schedule list   --strategy playbook:1
tradekit rebalance list  --strategy playbook:1
tradekit trades          --strategy playbook:1     # 归属到该 playbook 的历史成交
tradekit pnl             --strategy playbook:1     # 按 playbook 聚合的 PnL
```

它能与每一个已接受策略过滤器的可观测性原语（`pnl`、`strategies`、`pairs`、`audit`）组合 —— playbook 无需改动那些表，就成为一等的分析单元。

**默认即版本控制。** 一个 `.json` 文件存在 git 里；`git log eth-strategy.json` 就是这套策略的历史。CI 可以对每个变更的文件运行 `tradekit playbook validate` 来把关合并。

**数据库面。** 新增 `playbooks` 表（v17 迁移）：`id`、`name`、`source_path`、`source_hash`、`spec_json`、`status`（`deploying`/`deployed`/`destroyed`/`failed`）、`deployed_at`、`destroyed_at`。它与原语表之间没有外键 —— 拥有关系靠对 `strategy` 列做字符串匹配，这让 playbook 层能在不触碰 orders/schedules/rebalance_plans schema 的情况下演进。

#### Diff + replace（iter29）—— 不丢状态地迭代策略

对一个已部署策略做迭代（把 `trailPct` 从 5% 改成 10%、加第 4 条 DCA 腿、删掉一个 SL 括号）的运维人员，过去只能 `destroy + deploy` —— 丢失全部运行中状态，没有原子性，也没有预览。iter29 增加了两个操作：

```bash
# 只读预览 —— 会改什么？
tradekit playbook diff 1 ./eth-strategy-v2.json

# 原子化应用 —— 取消“被移除/被修改的旧版” + 创建“新增/被修改的新版”
tradekit playbook replace 1 ./eth-strategy-v2.json --yes
```

**Diff 分类。** 每个原语最终落入四个桶之一：
- `unchanged` —— spec 完全相同，无动作
- `modified` —— 结构形态相同（订单按 `(type, side, base, quote)` + trigger 匹配），但至少有一个字段不同
- `added` —— 新原语，在旧版中无结构匹配
- `removed` —— 旧原语，在新版中无结构匹配

**结构匹配**能覆盖常见情形：把移动止损上的 `trailPct: 5 → 10` → 归类为 **modified**（而非 removed+added）。字段级的变更会被展示出来，让运维人员看清自己到底在应用什么。

**原子化 replace** 分 4 阶段运行：
1. **解析 + 渲染新 spec**，走既有流水线（模板、校验关卡）
2. **计算 diff**，对照当前状态 —— 每个 `modified` 条目还会按**应用模式**分类：`edit`（原地）vs `recreate`（取消 + 创建）
3. **预校验**每个原语 —— 编辑走 `order edit`/`schedule edit` 使用的相同校验器，创建走部署校验器；如果有任何一个会失败（未知 token、无效 trigger、缺少必填字段），就在触碰状态**之前**中止
4. **应用**：取消“被移除 + modified-recreate”，原地编辑 modified-edit，创建“新增 + modified-recreate 的新版”；更新 playbook 行的 `spec_json` + `source_hash` + `deployed_at`

**失败语义。** 预校验在任何取消动作之前就抓住最常见的失败（chain 解析、token 解析、缺字段），因此一个有缺陷的新 spec 不会让 playbook 处于半成状态。应用过程中途的 DB 错误会带着诊断上下文上抛，提示运维人员用 `tradekit playbook show <id>` 检查状态。

**状态保留（v2）。** 一个 `modified` 原语，若其变更全部是可原地编辑的（price、trailPct、amounts、slippage、expiry/endAt、maxRuns、cadence、note），就走与 `tradekit order edit` / `schedule edit` 相同的编辑机制：它保留自己的行 id、移动止损的 **HWM 水位**、`run_count` / `max_runs` 记账，并新增一条 `edited_by_operator` 日志行 —— 完整的取证连续性。只有对冻结身份字段（OCO `group`、`chain`、`account`、schedule `startAt`/`name`）的变更才会强制 cancel+recreate —— 即便如此，重新创建的 schedule 和再平衡计划也会**带着它们的运行计数器**（`run_count`、`last_run_at`、成交总计）迁到新行，使 `max_runs` 记账得以保留。再平衡计划也获得了原地编辑能力（`rebalance edit`）：目标重新配权、漂移阈值、最小交易、节奏、各类上限都原地编辑；只有 quote-token / startAt 变更才强制 recreate（带计数器迁移）。diff 预览会按条目显示应用模式；`willResetTrailingHwm` 现在只在一条移动止损确实必须被重新创建时才触发。`--fresh-state` 退出所有保留行为（v1 行为：重新创建一切，重置 HWM + 计数器）—— 在运维人员*想要*跟踪重新开始时很有用。

**Paper 保留（v2）。** `deploy --paper` 不会记录在 spec 里，所以 replace 会从 playbook 拥有的行中**推断** paper 属性：如果它拥有的每个原语都是 paper，那么重新创建 + 新增的原语也都创建为 paper。在 v2 之前这是个真实的漏洞 —— 替换一个 paper playbook 会悄悄把新原语创建成真实交易的。API 上一个显式的 `paper` 参数可覆盖该推断。

**CI 集成。** `playbook diff` 是只读的 —— 非常适合“拿本 PR 的策略 spec 对照已部署状态做 diff”的把关。`--json` 输出给出结构化的字段级变更，供自动化审查：

```bash
tradekit playbook diff 1 ./pr.json --json | jq '.diff.summary, .diff.willResetTrailingHwm'
```

#### 策略报告（iter31）—— 统一可观测性

在 iter31 之前，回答“我的策略表现如何？”需要运行 7+ 条独立命令（`playbook show`、`order list --strategy`、`schedule list --strategy`、`trades --strategy`、`pnl --strategy`、`slippage --strategy`……）。数据本就都在；缺的是一个单一、可组合的视图。`tradekit strategy report` 把每个角度都收拢进一次调用。

```bash
# 纯数字解析为 playbook:N
tradekit strategy report 1

# 自由形式的标签用法相同
tradekit strategy report dca-eth

# 快速 tick 检查 —— 只取 agent 通常轮询的几个区块
tradekit strategy report 1 --sections id,forward --no-prices --json

# 给性能区块加窗口
tradekit strategy report 1 --window 7d
tradekit strategy report 1 --window all
```

**七个区块**，各自独立，且可通过 `--sections` 子选：

| 区块       | 它展示什么                                                                |
|---------------|---------------------------------------------------------------------------------|
| `identity`    | playbook 名称 + 部署元数据 + 存续时长 + 模式（real/paper）                  |
| `composition` | 拥有的每个 order/schedule/rebalance，含生命周期计数                     |
| `performance` | 成交数、成功率、已实现 PnL、滑点 p50/p95/max（按窗口）             |
| `position`    | 跨所有成交的净 `(chain, token)` 累计                              |
| `risk`        | 策略预算消耗（lifetime/daily/perFire）+ 每策略回撤   |
| `activity`    | 最近的成交 + 失败 + 订单日志条目，最新优先                  |
| `forward`     | 下一次定时任务触发 + 每个活跃订单的距触发距离 + `wouldFireNow` 标志 + 每个计划的再平衡漂移接近度（持久化遥测，不调用 oracle） |

**Paper 感知。** 模式自动检测：如果每个活跃原语都有 `paper=1`（或唯一的交易历史是 paper），报告就切到 paper 模式，并从 `paper_trades` 拉取 performance / position / activity。对模糊情形可用 `--mode real` / `--mode paper` 覆盖。

**Forward 信号**调用 engine 使用的相同触发谓词（`isOrderTriggered`、`evaluateTrailingTrigger`），因此报告与 engine 在“某物此刻是否会触发”上绝不分歧。移动止损会展示其 HWM + 计算出的回撤阈值。实时现货价格会尽力抓取（用 `--no-prices` 退出，供离线使用）；调用 MCP 版本的 agent 默认得到一个确定性、无网络的响应。

**MCP 工具。** `strategy_report` 把同一面向暴露给 agent —— 一次调用取代 iter31 之前的 7+ 次调用。想做近实时 tick 检查的 agent 传入 `sections: ["identity", "forward"]` 即可跳过较重的聚合路径。

**v1 局限。**
- ~~报告本身不对未平仓位做盯市~~ —— 已解决：`strategy report <id> --mtm` 增加一个可选的 VALUATION 区块，按实时 oracle 价格对成本基础仓位盯市（已实现 / 未实现 / 合计 / 逐仓明细），两种模式皆可，复用 `paper pnl --mtm` 的同一核心。real 模式注意：不含 gas —— 完整投资组合记账归 `tradekit pnl` 管。
- 回撤只在每策略范围（`strategy:<tag>`）展示；`global` 投资组合熔断有自己的面向，见 `safety drawdown`。

#### 策略告警（iter32）—— 主动通知

策略报告（iter31）给运维人员提供了很好的 PULL 面向 —— 但生产环境里他们需要 PUSH。`tradekit strategy alerts` 是一个规则驱动的监视器，当某策略的健康度越过运维人员定义的阈值时发出通知。它复用既有的通知栈（Slack / Discord / Telegram / 通用 webhook）；8 种规则类型覆盖运营上重要的失败模式 —— 包括 `drift_proximity`，它读取每个再平衡计划持久化的上次运行漂移，并在其达到该计划自身阈值的可配置百分比时触发（这是“再平衡即将交易”的提前预警，且不调用 oracle）。

```bash
# 在 config 中启用 safety.strategyAlerts 之后：
tradekit strategy alerts show-rules           # 哪些规则已配置 + 它们匹配哪些策略
tradekit strategy alerts run --once           # 立即评估；在 OK↔active 转换时发出通知
tradekit strategy alerts run --watch 60       # 守护进程模式（每 60s）；Ctrl-C 停止
tradekit strategy alerts list --active-only   # 当前正在触发的告警有哪些
tradekit strategy alerts reset --tag dca-eth  # 为某个策略重新武装规则
tradekit strategy alerts history --tag dca-eth --event fired --limit 50
                                              # v28：完整的触发/解除历史（持久日志）

# 内联在报告中：
tradekit strategy report 1 --alerts

# 盯市：按实时价格的成本基础仓位（real + paper 皆可）：
tradekit strategy report 1 --mtm
```

**持久转换日志（v28）。** 每次 fired/resolved 转换在通知发出的那一刻也会向 `alert_events` 表落一行 —— 精确时间戳、被违反的数值、以及（对 resolve 而言）告警持续时长。`strategy alerts history`（CLI）和 `alert_history`（MCP）对其翻页；`timeline_query` 读取它以获取 `alert.fired` / `alert.resolved` 事件（仅对 v28 之前的窗口才回退到状态行重建）。与 `alerts list`（展示当前状态）不同，该日志保留完整历史：一个反复抖动、触发又解除五次的告警会显示全部十次转换。可通过 `db.retention.alertEventsDays` 修剪。

**配置**位于 `~/.tradekit/config.json` 的 `safety.strategyAlerts`：

```json
{
  "safety": {
    "strategyAlerts": {
      "enabled": true,
      "rules": [
        { "type": "staleness",          "thresholdSeconds": 172800 },
        { "type": "slippage_trend",     "baselineBps": 50, "alertMultiplier": 1.5, "minSampleSize": 5 },
        { "type": "success_rate_drop",  "minRate": 0.8, "minSampleSize": 10 },
        { "type": "failure_streak",     "alertCount": 3, "action": "pause" },
        { "type": "budget_approach",    "warnPct": 0.8 },
        { "type": "drawdown_threshold", "alertPct": 10 },
        { "type": "trigger_proximity",  "alertDistancePct": 2, "appliesTo": ["playbook:*"] },
        { "type": "drift_proximity",    "alertPctOfThreshold": 80 }
      ]
    }
  }
}
```

**十种规则类型**：

| 规则                  | 触发条件……                                                              |
|-----------------------|------------------------------------------------------------------------------|
| `staleness`           | ≥ `thresholdSeconds` 没有成交（DCA 卡住 / 预算静默耗尽）    |
| `slippage_trend`      | 平均滑点 ≥ `baselineBps × alertMultiplier`（行情切换 / 流动性枯竭） |
| `success_rate_drop`   | 成交成功率跌破 `minRate`（滑点设得太紧 / token 出问题）  |
| `failure_streak`      | 连续 `alertCount` 次终态失败（紧急 —— 可能是新 bug）    |
| `budget_approach`     | 任一匹配的预算消耗 ≥ `warnPct`（相对硬上限的提前预警）         |
| `drawdown_threshold`  | 每策略回撤 ≥ `alertPct`（相对投资组合熔断的提前预警）    |
| `trigger_proximity`   | 任一活跃订单距触发在 `alertDistancePct` 以内（提前知会）             |
| `drift_proximity`     | 任一拥有的再平衡计划的上次漂移 ≥ 其阈值的 `alertPctOfThreshold`% |
| `funding_runway`      | 策略的支出 token 余额在 `thresholdDays` 内耗尽（预测）  |
| `position_cap_approach` | 净敞口达到仓位上限的 ≥ `warnPct`（在买入被弹回之前就听到风声） |

每条规则支持一个可选的 `appliesTo` 过滤器（`["playbook:*", "dca-eth"]`），用以按策略限定阈值范围；`note` 用于自由文本理由，会随通知 body 一同发出；`action` 用于选择一次触发**做什么**（见下文的熔断）。

**每次转换只触发一次。** 状态持久化在 `strategy_alert_state`（v25 迁移）。当一条规则由 OK→active 转换时，监视器只发一次通知；下一个 tick 识别到该状态行后保持沉默。当条件清除时，会发出配对的 `strategy.alert.resolved.<rule_type>` 事件，携带该告警的存续时长。不会有通知风暴。

**不适用的规则保持沉默。** 当一条规则无法被评估（样本量不足、`trigger_proximity` 没有实时价格、未配置每策略回撤）时，它既不触发也不解除 —— 既有的状态行原样留给下一个 tick。这同时避免了误报（一次糟糕的成交触发 slippage_trend）和漏报（评估失败被静默标记为“已解除”）。

**运营模式。** 把 `strategy alerts run --watch 60` 作为 engine supervisor 的 sidecar 运行。该监视器是读侧进程 —— 它构建廉价的、按区块过滤的 `StrategyReport`，评估规则，派发通知，并写入去重状态。它从不提交交易；它唯一能触碰的 engine 状态，是熔断规则触发时那次非破坏性的 pause 翻转。失败模式有界：监视器崩溃绝不影响交易 engine，反之亦然。

**无后果地调阈值（v37）。** `strategy alerts run --dry-run` 评估每条适用的规则并打印逐规则的判定（`✗ dca-test / slippage_trend — avg 200bps ≥ 75bps`），且**零副作用** —— 不发通知、不写状态行、不记日志，关键是不触发熔断。在 config 里改一条规则、dry-run、立刻看清此刻会触发什么；因为什么都没记录，下一次真实运行仍会看到那条全新的 ok→active 边沿。

**确认后重置。** 当运维人员已调查并处理了某条告警后，`tradekit strategy alerts reset --tag X --rule Y` 会清掉状态行，使该规则重新武装。下一次违反会发出一条全新的触发通知 —— 在底层问题日后被再次触发时很有用。

#### 紧急停止 — `tradekit panic`

当出现异常时——怀疑密钥泄露、策略失控、交易所全局混乱——操作者不应该还要记住四条命令外加一个标签清单。一条命令就把各项安全原语组合到一起：

```bash
tradekit panic --reason "key may be leaked"
# → engine LOCKED (every fire path gates on the lock from the next tick)
# → every active order / schedule / rebalance plan PAUSED — tagged or untagged
tradekit panic --cancel-orders --yes      # 终态变体：订单被撤销，而非暂停
tradekit panic release                    # 解锁；一切保持暂停以便选择性恢复
tradekit panic release --resume-all       # 虚惊一场 —— 恢复全部（定时任务会重新计算 next_run_at）
```

这两层设计是刻意为之：引擎锁(engine lock)起效最快，而暂停让停止**在解锁之后依然持久有效**，并在每个列表视图里都明确可见。release 默认只解锁，因为 panic 决策往往是在高压下做出的——恢复运行则是冷静后才该做的决定（`strategy resume <tag>` / `order resume <id>`）。`--cancel-orders` 始终要求显式加上 `--yes`（在高压下弹出交互式确认，反而容易在两个方向上都出错）。一条关键级别的 `engine.panic` 通知（其严重级别足以穿透静默时段）会记录下相关计数。**不通过 MCP 暴露**——与 backup 相同的“仅限 CLI”安全边界：一个代理（agent），或一个被提示注入(prompt injection)劫持的代理，绝不能批量撤销订单，也不能解除一次由人工发起的 panic。

#### 仓位上限——第三条风险轴线 (v38)

此前安全栈有两条轴线：**回撤熔断**（投资组合价值从峰值下跌 X%）和**策略预算**（累计支出）。两者都无法表达最符合直觉的那条风险陈述——*“策略 X 持有的 WETH 不得超过 2 个（或成本基础不得超过 $5,000）”*。预算统计的是总支出，所以卖出永远不会腾出空间；一个反复买进卖出（churn）的策略会在什么都没持有的情况下耗尽预算。

```jsonc
{ "safety": { "positionCaps": [
  { "pattern": "playbook:*", "token": "WETH", "maxBaseAmount": 2, "maxCostQuote": 5000 }
] } }
```

仓位上限统计的是**净敞口**，使用与每一处盈亏(PnL)界面相同的加权平均模型（上限永远不会与 `strategy report` 显示的内容相矛盾）：买入累加，卖出按比例释放成本后扣减——减仓后空间就回来了。在两条执行路径中都会在报价后(post-quote)执行检查（真实的 `executeTrade` 和 `executePaperTrade`——模拟运行(dry-run)的拒绝时机与真实执行完全一致），并抛出 `POSITION_CAP_EXCEEDED`，附带当前值/新增值/上限值。三条刻意的规则：**卖出永不被阻挡**（因为敞口“太高”而拒绝退出会带来实质性危险）、无标签的手动交易绕过此检查（它们受操作者级别的 USD 限额约束），作用范围是按 (tag, token) **跨链**——你限制的是对某项资产的整体敞口，而不是逐链记账。策略报告(strategy report)的风险部分会在预算旁边显示上限利用率，`position_cap_approach` 告警规则会在买入开始被拒**之前**就发出提醒（`warnPct: 0.8` = 在利用率 80% 时告警——硬性拒绝的前置预警孪生版），而 Web 端的 Strategy 标签页会渲染一张确定性的已实现盈亏卡片（来自 `GET /api/gains` 的累计成本基础收益——纯粹的成交回放，因此契合 Web 界面“零预言机(zero-oracle)”的原则）。

#### 熔断器——会行动的告警，而不只是通知

凌晨三点的一条通知，只有在有人醒着读它时才有用。任何告警规则都可以携带 `"action": "pause"`——当它触发时，监视器不只是发通知：它会**批量暂停该策略拥有的每一个原语**（订单、定时任务、再平衡计划），并发出一条关键级别的 `strategy.alert.circuit_breaker` 通知，明确列出被暂停的内容。系统先保护自己，操作者则在更人道的时间去排查。

```jsonc
{ "type": "failure_streak", "alertCount": 3, "action": "pause", "appliesTo": ["playbook:*"] }
```

**为什么暂停（而非撤销）适合自动化且安全。** 暂停是完全可逆的：运行计数器、移动止损的高水位标记、OCO 分组以及 `next_run_at` 语义都会留存。一次误报的熔断器跳闸顶多让你错过几次触发成交，绝不会破坏状态。撤销则仍然是人工决定。

**仅在触发跳变时动作。** 熔断器只在规则由 OK → 违规跳变时行动，绝不会在 `still_active` 的轮询拍上行动。排查之后，`tradekit strategy resume <tag>` 会把一切恢复——而仍处于违规状态的规则**不会**立即再次触发暂停（你的恢复是一次刻意的覆盖决定）。只有当该规则先解除、再重新触发时，熔断器才会再次行动。

**暂停态语义**（其设计确保一次熔断器跳闸不会让危险状态被搁置）：
- 被暂停的**订单**仍会在其 `expires_at` 时到期（时间界定的是有效性，而非活动状态），也仍会因 OCO 同组成员触发成交而失效——一个被暂停的止损单会在它的止盈孪生单成交那一刻被撤销，因此之后再恢复它，也不会为一个已平仓的仓位重新装上退出单。
- 被暂停的**定时任务 / 再平衡计划**会在恢复时以当前时间重新计算 `next_run_at`——错过的窗口被跳过，不做补跑。
- 移动止损的水位标记在暂停期间冻结；如果价格在此期间下跌，导致止损单在恢复时立即触发成交，这正是正确的止损行为。

**手动孪生版。** `tradekit strategy pause <tag>` / `strategy resume <tag>`（MCP：`strategy_pause` / `strategy_resume`）用手动方式运行同一套机制——一条命令就让整个策略下线供你排查，而不必逐个手动暂停 12 个订单、2 个定时任务和 1 个再平衡计划。单个订单也获得了对等的暂停/恢复能力：`order pause <id>` / `order resume <id>`（MCP：`order_pause` / `order_resume`）。

**失败升级。** 如果暂停操作本身出错，告警仍会触发，但会升级发出一条 `strategy.alert.circuit_breaker_failed` 关键通知——操作者必须知道系统**没能**保护住自己。熔断器跳闸会被记入 `alert_events`（`event: "breaker_paused"`，附带被暂停的 id），并在统一时间线中以 `alert.breaker` 事件的形式呈现。

#### 权益曲线——“我的投资组合总价值是怎么变动的？” (v37)

操作者最想要的一张图。`portfolio_snapshots`（iter618）此前已经存储了时点总额，但只在手动运行 `tradekit snapshot` 时才记录——所以曲线没有数据来源。v37 新增了**引擎快照工作器**（`engine.workers.snapshot`，由 init 的可观测性预设启用）：它每小时轮询一拍，但只有在最新的 `engine-auto` 快照早于 `engine.snapshotEveryHours`（默认 24）时才记录——每天一次完整的多链 RPC + 价格扫描，而非每小时一次。手动快照会贡献到曲线上，但不会重置自动节奏（你下午查看一下投资组合，不应该让今晚的数据点被跳过）。

```bash
tradekit equity --since 90d
#   ▁▂▂▃▅▄▆▇█▇█  2026-03-12 → 2026-06-10 · 90 points
#   now $12,840.21 · start $10,002.10 · change +$2,838.11 (+28.4%)
#   peak $13,102.55 on 2026-06-02 · max drawdown 9.3%
```

**范围纪律**：一条曲线只在单一扫描范围内（`accounts_key × chains_key`）才有意义——混合范围会让曲线因*覆盖范围*变化而跳动，而非因价值变化。未指定范围的查询默认采用快照最多的范围（在返回中以 `scopeSource: "defaulted"` 回显）；`availableScopes` 列出其余范围。在所有提供它的地方都是纯 DB 读取：CLI 的 `tradekit equity`、MCP 的 `equity_curve`、Web 的 `GET /api/equity`，外加 PnL 标签页上的一张内嵌 90 天图表（上涨青色 / 下跌红色，无需任何图表库依赖）。

#### 资金续航——“我的自动化会不会把钱花光，又会在什么时候？”

最常见的自动化故障总在最糟糕的时刻被发现：一个定时任务触发了，余额却不够，操作者从一条 `fire_failed` 通知里才得知——这是反应式的，每次后续触发都会重演，且常常发生在凌晨三点。`tradekit runway` 把它变成一份预测：

```bash
tradekit runway                       # 所有账户/链，90 天展望
tradekit runway --strategy playbook:7 --days 30
tradekit runway --json | jq '.buckets[0]'
```

```
USDC  ·  default/base
  ✗  runs out 2026-07-06 (26.0d) — covers 3/12 fires
  balance 350  ·  one-shot reserved 0  ·  burn/30d 400
    schedule #4 (dca-weekly): 100 per fire, cron "0 0 * * 1"  [playbook:7]
```

**它如何计算。** 遍历每个 ACTIVE 定时任务即将到来的 cron 触发时刻（尊重 `end_at` 以及剩余的 `max_runs` 预算），把每个 ACTIVE 订单的一次性支出预先预留出来（订单可能在任何时刻触发成交），然后按时间顺序对照每种支出代币的当前余额进行回放——模拟交易(paper)原语用 paper 账本，真实原语用链上 `balanceOf`（只读；不接触密钥库）。各个桶(bucket)以 (account, chain, paper, token) 为键：一个 paper 定投永远不会计入真实钱包。

**无需价格、且精确。** 买入消耗报价代币（每次触发 `quote_amount`）；卖出消耗基础代币。若原语以*相反*计价方式定量（如一笔以基础数量指定的买入），其支出在没有价格预言机的情况下无从得知——它们被列在 `skipped` 之下，而不是被悄悄猜测。再平衡计划在设计上不在统计范围内：它们的交易取决于偏移，且卖出为买入提供资金——不存在固定的消耗速率。

**Gas 也是燃料 (v34.5)。** 每一次真实触发都会消耗原生 gas，与支出代币无关——一个 USDC 充裕但 ETH 见底的钱包，每次触发都会失败，而这是最常见的新手故障。报告的 `gas` 部分把真实定时任务 + 活跃订单按 (account, chain) 分组，依据**最近 50 笔成功交易的历史平均值**（`gas_cost_native`）估算每次触发的 gas，并对照原生余额回放同一串触发时刻流：`⛽ default/base · gas runs out ~2026-07-02 (21d) — covers 53/90 fires · ~0.0004/fire (n=37)`。诚实原则：没有交易历史 → 不给估算、不下结论（敞口仍会列出）；gas 价格会变动，因此 `exhaustsAt` 只是数量级；paper 触发不消耗任何东西，永不出现；再平衡评估被排除（每次触发 0..N 条腿）。`funding_runway` 告警规则会同时考虑 gas 桶和代币桶——**最短的引线说了算**——所以“5 天内 gas 耗尽”会和“5 天内 USDC 耗尽”一样准确地发出告警。

**推送，而非轮询。** `funding_runway` 告警规则闭合了这个环路：

```jsonc
{ "type": "funding_runway", "thresholdDays": 7 }
```

当任何支出代币被预测将在一周内见底时触发——配合 `"action": "pause"`，熔断器会让策略停止向必然失败的方向触发，直到它被重新注资。该规则读取选择性启用的 `runway` 报告部分（`strategy report <tag> --sections identity,runway`），因此只有在规则被配置时才会发生余额读取。余额获取失败的桶会被跳过，绝不猜测——一个挂掉的 RPC 绝不该把谁吵醒。MCP：`runway` 工具为代理返回同一份报告。

#### DB 生命周期 (iter40)——完整性 / 保留(清理) / 自动备份

经过 12 个 iter 的能力累积，这个 SQLite 文件已成为一项关键的长期资产：50 万+ 条审计行、10 万+ 条订单日志、模拟交易、告警状态、引擎事件。在 iter40 之前，它无限增长，且只有在操作者记得运行 `tradekit backup export` 时才会被备份。iter40 加入了一劳永逸的 DB 卫生维护。

```bash
# 可观测性 —— 哪些数据正在累积？
tradekit db stats
tradekit db stats --json | jq '.stats.rowCounts'

# 周期性健康检查（对 cron 友好 —— 发现损坏时以退出码 1 退出）
tradekit db integrity-check

# 应用保留策略（在你配置好之后）
tradekit db prune --dry-run     # 预览截止点，不执行 DELETE
tradekit db prune                # 应用

# 一次性手动备份
tradekit db backup                                   # 数据目录中带时间戳的文件
tradekit db backup --dest /external/drive/snap.db   # 显式指定目标

# 轮转自动备份目录
tradekit db rotate --retain 14
```

**三项相互独立的能力**——全部默认禁用，需通过配置选择性启用：

1. **完整性检查**——把 `PRAGMA integrity_check` 包装成一个带类型的结果。CLI / MCP / 引擎工作器共用同一条路径。

2. **保留清理**——按表设置以天为单位的截止点。**成功的交易永不被自动清理**（税务记录）。只有 `failed`/`reverted` 终态交易才可被触及，且仅在显式启用时。

3. **自动备份**——通过 `VACUUM INTO` 进行的原子 SQLite 复制。带时间戳的文件名 + FIFO 轮转。

**配置**（显示的是默认值——所有启用开关默认为 false）：

```json
{
  "db": {
    "retention": {
      "enabled": false,
      "auditLogDays": null,          // 显式为 NULL = 永不清理 audit_log
      "paperTradesDays": null,
      "orderCheckLogDays": null,
      "engineEventsDays": null,
      "alertEventsDays": null,
      "scheduleCheckLogDays": null,
      "rebalanceCheckLogDays": null,
      "failedTradesDays": null
    },
    "backup": {
      "enabled": false,
      "intervalHours": 24,
      "destDir": "backups",
      "retainCount": 7
    },
    "integrityCheck": {
      "enabled": false,
      "intervalHours": 24
    }
  }
}
```

要在后台运行这三项，启用 `db_maintenance` 引擎工作器：

```bash
tradekit config set engine.workers.db_maintenance.enabled true
tradekit config set db.retention.enabled true
tradekit config set db.retention.auditLogDays 90
tradekit config set db.retention.orderCheckLogDays 30
tradekit config set db.backup.enabled true
tradekit config set db.integrityCheck.enabled true
# 下一个引擎 tick 会通过 iter35 的热重载接收这一切。
```

**只读工作器。** `db_maintenance` 属于 iter33 的 `READ_ONLY_WORKERS` 集合——无需解密密钥库即可运行。如果你只想做 DB 卫生维护而不交易，可以用 `tradekit engine run --workers db_maintenance --dry-run` 单独把它跑起来。

**取证轨迹。** 每个子任务的成功/失败都会发出一条 iter39 引擎事件：
- `db.integrity_failed`（关键）——检测到损坏
- `db.prune_failed`（警告）——保留清理 SQL 抛出异常
- `db.backup_failed`（关键）——VACUUM INTO 失败
- `db.backup_ok`（信息）——备份成功，附带大小 + 耗时

```
$ tradekit engine events --types db.backup_ok,db.backup_failed --since 7d
Engine events (7 rows, since 2026-05-24T...):
  · 2026-05-24 03:00:00Z db.backup_ok      destPath=~/.tradekit/backups/tradekit-20260524030000.db sizeBytes=2400000 durationMs=85
  · 2026-05-25 03:00:00Z db.backup_ok      ...
  ...
  ✕ 2026-05-29 03:00:00Z db.backup_failed  error=ENOSPC: no space left on device
  ...
```

操作者能确切看到备份是从何时、因何故停止工作的。

**stats 输出示例：**

```
$ tradekit db stats
DB stats: /Users/me/.tradekit/tradekit.db

  Disk:    main 47.3MB · WAL 4.1MB · SHM 32.0KB · total 51.4MB

  Row counts:
    audit_log                234,521
    order_check_log          12,847
    trades                   3,210
    engine_events            1,402
    paper_trades             892
    orders                   145
    schedules                23
    strategy_alert_state     8
    drawdown_state           1
    engine_lock              1
    (empty: portfolio_snapshots, sync_bookmarks, rebalance_plans, ...)

  Retention preview:
    audit_log                would prune rows older than 2026-03-01T12:00:00Z
    order_check_log          would prune rows older than 2026-05-01T12:00:00Z
    paper_trades             skipped (db.retention.paperTradesDays=null (unset))
    engine_events            skipped (db.retention.engineEventsDays=null (unset))
    alert_events             skipped (db.retention.alertEventsDays=null (unset))
    schedule_check_log       skipped (db.retention.scheduleCheckLogDays=null (unset))
    rebalance_check_log      skipped (db.retention.rebalanceCheckLogDays=null (unset))
    trades                   skipped (db.retention.failedTradesDays=null (unset))

  Run `tradekit db prune --dry-run` to see actual counts; `tradekit db prune` to apply.
```

**MCP** 为实现自动化 DB 卫生监控的代理暴露了 `db_stats` + `db_integrity_check`。

**与 `backup export` 的共存。** 现有的 iter28+ `tradekit backup export` 会生成加密的多资产备份（钱包密钥库 + 配置 + 可选 DB），用于灾难恢复 / 跨主机迁移。iter40 的 `db backup` 只针对 SQLite——一种简单、快速、原子的快照，供自动备份路径以及同主机快速回滚使用。两者都保留。

**v1 限制。**
- 保留清理仅基于时间（“保留最近 90 天”）。v1 没有“保留最近 N 行”的选项。
- 自动备份使用 VACUUM INTO——原子，但产出的是完整副本（非增量）。对于小于 1GB 的 DB 这没问题；多 GB 的 DB 可能需要外部的生命周期策略。

#### 引擎事件 (iter39)——持久化的引擎状态跳变

在 iter39 之前，引擎的生命周期 + 工作器韧性 + 配置重载等跳变只以**瞬态通知**（iter28+）的形式呈现。每次进程重启它们都会消失。要回答“我的引擎上周是什么时候重启的？”“orders 工作器这个月降级过多少次？”“三天前是谁重载了配置、改了什么？”的操作者，只能去 grep 已轮转的 Slack 历史。

iter39 新增了一张 v26 `engine_events` 表，它会**并行地**持久化每一次发出通知的跳变。现有监控继续保持不变；新增的是这条持久化的取证轨迹。

```bash
# 默认：最近 24 小时的引擎事件
tradekit engine events

# 上周的 worker 韧性事故
tradekit engine events --since 7d --types worker.degraded,worker.recovered

# 仅 critical 事件（配置重载失败、致命停机、加锁）
tradekit engine events --severity critical --since 30d

# 按 worker 过滤，做有针对性的调试
tradekit engine events --worker orders --types worker.degraded

# 供机器消费
tradekit engine events --since 24h --json | jq '.events[] | select(.event_type=="worker.degraded")'
```

**持久化的事件类型**（共 8 种——心跳刻意不持久化；它高基数，操作者用 `engine status` 查看存活状态）：

| 事件类型                | 何时                                                       | 严重级别                |
|------------------------|----------------------------------------------------------|-------------------------|
| `engine.started`       | 主管(supervisor)启动（获取锁之后）                          | info                    |
| `engine.stopped`       | 主管退出                                                   | info / critical (fatal) |
| `engine.lock`          | 操作者启用 iter28 紧急开关                                  | warn                    |
| `engine.unlock`        | 操作者解除 iter28 紧急开关                                  | info                    |
| `worker.degraded`      | iter33 韧性：连续 N 次失败越过阈值                          | warn                    |
| `worker.recovered`     | iter33 韧性：降级连续失败后的首次成功                       | info                    |
| `config.reloaded`      | iter35 SIGHUP 成功                                         | 与预检影响一致           |
| `config.reload_failed` | iter35 SIGHUP 发现配置无效                                  | critical                |

**与通知交叉引用。** 每个 `dedup_key` 都与对应的 iter28+ 通知 dedupKey 相匹配。把 Slack 历史 + DB 行配对的操作者可以按 key 关联。

**输出示例：**

```
$ tradekit engine events --since 24h

Engine events (8 rows, since 2026-05-30T14:00:00Z):
  2 critical · 3 warn · 3 info

  · 2026-05-30 14:00:00Z engine.started         pid=12345 workers=orders,schedules,reconcile,rebalance,alerts
  ⚠ 2026-05-30 16:30:00Z worker.degraded        [orders] consecutive=3 effective=60000ms
  · 2026-05-30 16:33:15Z worker.recovered       [orders] after=3 fails
  ⚠ 2026-05-30 18:00:00Z engine.lock            locked by cli: oracle outage investigation
  · 2026-05-30 19:30:00Z engine.unlock          unlocked by cli
  ✕ 2026-05-30 23:15:00Z config.reload_failed   Zod: safety.maxSlippageBps must be number
  ⚠ 2026-05-30 23:18:00Z config.reloaded        diff=5 critical=2 warn=1
  ✕ 2026-05-31 02:00:00Z engine.stopped         uptime=43200s fatal=RPC pool exhausted
```

整个故事端到端地自行讲述出来：引擎运行了 12 小时，在 16:30 遇到一次瞬态 RPC 降级（3 分钟后恢复），操作者在 18:00 手动加锁以排查一个预言机问题，19:30 解锁，随后在 23:15 写错了一处配置（重载干净地失败，没有影响交易），23:18 修好并重载，最终在 2 小时后因 RPC 连接池耗尽而死掉。每一步都被持久化记录。

**时间线集成。** `tradekit timeline`（iter36）现在直接从这张表读取引擎事件，而不再从 audit_log 推断。此前的启发式做法完全漏掉了 `worker.degraded` / `worker.recovered` / `config.reload*`——这些原本只有通知。统一时间线现在以精确数据呈现它们。

**容错持久化。** 每个构造器都把 `insertEngineEvent` 包在 try/catch + `logger.warn` 里。在写 `engine.stopped` 时若 DB 出问题，**绝不能**让主管的关停过程崩溃——通知仍是必须同步的路径；DB 层是持久但尽力而为的伴随者。

**MCP** 暴露了 `engine_events`，过滤项集合相同。驱动自主事件响应的代理只需查询这张表一次，而不必编排 4 个以上独立的通知历史查询。

**v1 限制。**
- 心跳不持久化（高基数；用 `engine status` 查看存活状态）。
- `engine_events` 刻意只限定于*引擎*事件，不涉及按策略划分的领域。按策略的这一空缺在 v28 中补上：`alert.fired` / `alert.resolved` 现在会持久化到它们自己的 `alert_events` 表（见*策略告警*）。
- 无自动清理——操作者可通过 `doctor` 或 cron 调用 `pruneEngineEvents(beforeIso)`。

#### 价格层大改 (iter38)——批量获取 + 提供方统计

生产规模化瓶颈：一个运行 5+ 个已部署策略的操作者会撞上 CoinGecko 免费档的速率限制（约 30 次/分钟），因为订单引擎在缓存冷启动那一拍会为 N 个不同的基础代币发起 N 次独立的 HTTP 调用。iter38 把它压缩成一次批量调用（CoinGecko 的 `/simple/price?ids=...,...` 支持逗号分隔的批量——我们之前只是没用上），并加入了按提供方的可观测性，让操作者能去调试速率限制事件，而不是靠猜。

```bash
# 查看你的 API 调用都去了哪里
tradekit price stats
tradekit price stats --json | jq '.providers[] | select(.lastErrorCode!=null)'

# 在两次监控抓取之间重置
tradekit price stats --reset
```

**三项协同改动：**

1. **`getCurrentPrices(addresses, logger)`**——新的批量入口。缓存查找 → 进行中(in-flight)去重 → 按提供方分组 → 每个不超过 250 个代币的分块发一次 CoinGecko 调用 → 其余的并行走 DexScreener 回退。CoinGecko 失败的代币会按单个代币自动回退到 DexScreener。同时提供单代币便捷版 `getCurrentPriceBatched`。

2. **引擎预取。** `runOrderTick` 现在会在遍历活跃订单**之前**调用 `getCurrentPrices(distinctBaseTokens)`。一拍中有 15 个不同代币，现在是一次 HTTP 调用，而不是 15 次顺序调用。逐订单循环从热缓存中读取。

3. **按提供方统计**（`priceStats.ts`）。每次对 CoinGecko / DexScreener 的调用都会记录一条 `ProviderCall`（延迟、ok 标志、错误码、请求代币数 vs 返回代币数）。`tradekit price stats` 把它们呈现出来——调用次数、命中率、延迟 p50/p95/max、每个提供方的最近一次错误。

**向后兼容。** `getCurrentPrice(token, logger)` API 保持不变——旧的单代币路径为每个现有调用方保留。只是现在两条路径都会记录统计。60s 成功 / 15s 空值 TTL 的缓存（iter132）保持不变；两条路径通过新的 `priceCacheShared.ts` 模块共享它们（无循环导入）。

**stats 输出示例：**

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

拿到这份快照的操作者能看出：CoinGecko 有 2 次失败（其中一次是最近的——14:32 的 `HTTP_429`——确认他们正撞上速率限制），命中率 91%（一些不在 CoinGecko 上的代币落到了 DexScreener），p95 延迟 1.1 秒表明速率限制窗口正在限速。一条命令给出可据以行动的信号。

**错误分类。** `classifyFetchError` 把未知的抛出错误映射到 8 个已知码：`HTTP_429`、`HTTP_5xx`、`HTTP_4xx`、`TIMEOUT`、`NETWORK_ERROR`、`PARSE_ERROR`、`UNKNOWN_ERROR`。它同时检查 `Error.name` 和 `Error.message`，因此 `SyntaxError`（其判别符携带在 `name` 中）会被归类为 `PARSE_ERROR`。

**韧性。** 统计仅在内存中，绝不会阻塞价格路径。CoinGecko 分块失败 → 这些代币逐个回退到 DexScreener。DexScreener 失败 → 缓存空值 15s，下一拍重试。单个坏分块绝不会毒化这一拍的其余部分。

**MCP** 暴露了 `price_stats`，带可选的 `reset: true`，供希望获得“自上次抓取以来的增量”语义的监控脚本使用。

**v1 限制。**
- DexScreener 没有批量端点——回退仍是逐代币，通过 `Promise.allSettled` 并行化。
- 统计仅在内存中。需要历史遥测的生产部署应抓取 `/metrics`（引擎 `--metrics-port`），或等待未来 iter 导出到 Prometheus。
- CoinGecko 的 250 个代币分块上限是一个保守的 URL 长度防护；真实限制更高，但 250 能让 URL 保持在 5KB 以内。

#### 批量操作 (iter37)——按范围的停止 / 恢复

它处于 iter28 engine_lock（全局急停——暂停每个策略的每一条交易路径）与逐原语的 `order cancel` / `schedule pause`（当你有一个含 12 个活跃原语的已部署策略时太过细碎）之间的中间地带。在事件响应期间，操作者想要的是“在我排查时把所有打了 `dca-eth` 标签的东西都停掉”——一条命令、原子、一条通知，且执行前有预览。

```bash
# 先预览再确认的流程（最安全的默认方式）
tradekit bulk halt --strategy dca-eth                    # 打印计划，提示“输入 halt 以确认”
tradekit bulk halt --strategy dca-eth --dry-run          # 仅出计划，绝不改动
tradekit bulk halt --strategy dca-eth --yes              # 跳过提示（对脚本友好）

# 按链 / 账户 / 多项过滤
tradekit bulk halt --chain arbitrum
tradekit bulk halt --account alice
tradekit bulk halt --strategy dca-eth --chain base --types orders

# 恢复可逆的部分（被撤销的订单是终态 —— 请通过 `order create` 重建）
tradekit bulk resume --strategy dca-eth
tradekit bulk resume --strategy dca-eth --types schedules

# 供机器消费（JSON，自动确认）
tradekit bulk halt --strategy dca-eth --json | jq '.applied'
```

**计划/执行分离。** `bulk halt` 分两个阶段——一个纯粹的规划器，把每个匹配到的原语分类为 `cancel` / `pause` / `skip`（带原因）；以及一个原子执行器，在单个 DB 事务内运行已分类的计划。CLI 会在提示前先渲染计划；`--dry-run` 在出计划后即停止。

**停止语义：**

| 类型        | 操作      | 是否可逆？ |
|-------------|-----------|-------------|
| orders      | cancel    | 否（终态——必须重建） |
| schedules   | pause     | 是（`bulk resume`） |
| rebalances  | pause     | 是（`bulk resume`） |

已处于终态的原语（已成交订单、已完成的定时任务）会被分类为 `skip` 并附带清楚的原因——让操作者看到它们并未被忽略。

**范围是必需的。** 若不带 `--strategy` / `--chain` / `--account`（或显式的 `--all`），bulk halt 会拒绝运行并返回 `INVALID_PARAMS`。无范围的情形会触及每条链上、每个账户的每一个原语——太容易误伤。真正的全局急停开关是 `engine lock`。

**原子 + 审计一致。** 所有变更都在一个 `BEGIN/COMMIT` 内运行。按时间戳读取 `audit_log` 的操作者会看到一个批量批次，而不是 N 条错开的行。一条批量级别的 `bulk.halt` 通知发往 Slack/Discord——而非 N 条逐原语的撤销。逐行的失败会被收集（而非抛出），这样批次中途的竞态不会把已成功的操作回滚掉。

**输出示例：**

```
$ tradekit bulk halt --strategy dca-eth

Bulk halt plan: strategy=dca-eth

  Would affect 5 primitive(s):
    orders     to cancel: 3
    schedules  to pause:  1
    rebalances to pause:  1
  Skipped (already terminal): 2
    already filled: 2

  orders:
    ✕ cancel  #42    SELL 1 ETH/USDC  ≤ $1900       (active → cancel)
    ✕ cancel  #43    SELL 1 ETH/USDC  ≥ $3000       (active → cancel)
    ✕ cancel  #44    BUY 100 ETH/USDC trailing 5%   (active → cancel)
    · skip    #21    SELL 1 ETH/USDC  ≤ $1900       (already filled)
    · skip    #22    SELL 1 ETH/USDC  ≥ $3000       (already filled)
  schedules:
    ⏸ pause   #5     BUY 100 ETH/USDC  @ 0 10 * * *  (active → pause)
  rebalances:
    ⏸ pause   #2     rebal-q1 (4 targets, drift 5%)  (active → pause)

Type 'halt' to confirm halting 5 primitive(s): halt

Bulk halt: 5 applied, 2 skipped, 0 error(s).
```

**MCP** 暴露了 `bulk_halt` + `bulk_resume`，过滤项集合相同，外加 `dryRun` 参数。驱动自主事件响应的代理（例如一个在 iter32 告警越过阈值时触发 halt 的监视器）能获得同样的“先计划再执行”安全语义。

**幂等。** 连续运行两次相同的 `bulk halt` 是安全的——第二次运行会发现每个此前受影响的行都已处于终态或已暂停，将它们全部分类为 `skip`，并报告 `0 applied, N skipped`。

#### 取证时间线 (iter36) —— 统一的按时间排序事件视图

可观测性这把三脚凳的第三条腿。iter31 的策略报告回答的是"策略 X 现在状态如何？"（状态视角，按策略）。iter32 的策略告警回答的是"X 出问题时通知我"（推送视角，按阈值）。iter36 的时间线回答的则是"13:55 到 14:05 之间发生了什么？"（时间视角，跨策略）。

```bash
# 默认：最近 4 小时，所有事件，最新优先
tradekit timeline

# 只看近期失败
tradekit timeline --severity critical

# 过去一小时 Base 上出了什么问题？
tradekit timeline --since 1h --chain base --severity warn

# 告警密集爆发期间的事故分诊
tradekit timeline --since 30m --kinds trade.failure,audit.error,alert.fired

# 按策略调查
tradekit timeline --strategy dca-eth --since 1d

# 便于管道处理
tradekit timeline --since 4h --json | jq '.events[] | select(.severity=="critical")'
```

**事件来源** —— 全部汇入同一条按时间排序的事件流：

| 类型                | 来源                                           | 严重度推断规则                                   |
|---------------------|------------------------------------------------|--------------------------------------------------|
| `trade.fill`        | `trades` 中 status=success 的记录              | info                                             |
| `trade.failure`     | `trades` 中 status=failed/reverted 的记录      | critical                                         |
| `trade.pending`     | `trades` 中 status=pending 的记录              | warn                                             |
| `paper.fill`        | `paper_trades`                                 | info                                             |
| `order.journal`     | `order_check_log`（触发决策、错误）            | 视情况而定（error=critical, fired=warn 等）       |
| `order.edited`      | `order_check_log` 中 decision="edited_by_operator"| info                                          |
| `schedule.journal`  | `schedule_check_log`（v29 —— 触发、失败、退役、钩子） | fire_failed=critical, locked/hook_failed=warn, 其余 info |
| `rebalance.journal` | `rebalance_check_log`（v29 —— 含 in_band 漂移读数） | failed/partial=critical, fired/locked=warn, in_band=info |
| `audit.tool`        | `audit_log` 中没有 error_code 的行             | 高权限工具（engine_lock, revoke 等）为 warn       |
| `audit.error`       | `audit_log` 中设置了 error_code 的行           | critical                                         |
| `alert.fired`       | `strategy_alert_state` 的 first_triggered_at   | 按规则（drawdown_threshold=critical 等）          |
| `alert.resolved`    | `strategy_alert_state` 的 last_evaluated_at    | info                                             |

**智能过滤** —— iter25 的 `tracking_started` / `hwm_advanced` 日志事件（逐 tick 的状态机面包屑）被刻意排除在时间线之外。一个 4 小时窗口里只要有几个移动止损，就会为每个订单产生数十条这类记录；它们属于 `order replay <id>`（按订单的取证视图），而不属于跨策略的时间线。

**示例输出：**

```
$ tradekit timeline --since 1h --severity warn

Timeline (8 events, since 1h ago):

  3 critical · 4 warn · 1 info

  ✕ 2026-05-31 14:02:15Z trade.failure    TRADE FAILED SELL 1 ETH: insufficient liquidity for SLIPPAGE 50bps
  ✕ 2026-05-31 14:01:55Z trade.failure    TRADE FAILED SELL 1 ETH: insufficient liquidity for SLIPPAGE 50bps
  ⚠ 2026-05-31 14:01:30Z alert.fired      ALERT FIRED dca-eth: success_rate_drop
  ⚠ 2026-05-31 14:00:45Z order.journal    ORDER #42 triggered_fired @ $2850 (HWM 3000, -5%)
  ✕ 2026-05-31 13:58:12Z audit.error      AUDIT trade: SLIPPAGE_EXCEEDED — slippage 850bps > cap 500bps
  ⚠ 2026-05-31 13:57:00Z audit.tool       AUDIT engine_lock (tx 0x…)
  ⚠ 2026-05-31 13:55:30Z order.journal    ORDER #51 near_threshold @ $2855
  · 2026-05-31 13:50:00Z order.edited     ORDER #42 edited by operator — {"trailPct":[3,5]}
```

整个故事不言自明：操作员在 13:50 编辑了一个订单以放宽移动止损区间，但没有帮助；13:55 的 near_threshold 是警告信号；13:57 触发了 engine_lock（很可能是操作员的应对动作）；13:58 一笔手动交易撞上了上限；策略在 14:01 进入 success_rate_drop 告警，并伴随两笔连续的交易失败。

**过滤器设计。** 每个过滤条件都会下推到各来源的 SQL 查询中，这样就不必把所有行都加载进内存再过滤。limit 在全局合并 + 排序之后才生效，所以 `--limit 50` 取的是跨所有来源的全局最新 50 条 —— 而不是"每个来源取 50 条再截断"。

**稳定的排序。** 时间戳降序，其次按类型名称，再次按 id 降序作为打破平局的依据。同一时刻执行的同一查询总是以相同顺序返回行 —— 这对 CI 快照 diff 和 JSON 尾部管道处理很重要。

**MCP** 暴露了 `timeline_query`，过滤条件集与此相同。调查事故的智能体只需发起一次 MCP 调用，而无需编排 6 个以上独立查询 —— 并且拿到的是类型统一的 `TimelineEvent[]`，可以驱动自主修复流程。

**v1 的局限 —— 两个都已解决。**
- ~~`alert.resolved` 检测是一种启发式推断~~ —— v28 新增了 `alert_events` 表：每一次 fired/resolved 转换都会在 watcher 发出通知的那一刻被记入日志，因此时间线读取的是精确时间戳和完整的重复历史（一条 fired+resolved 触发了 5 次的告警会显示全部 10 次转换；而启发式推断会把它们各自折叠成一条）。基于状态行的启发式推断仅作为针对早于该迁移的窗口的回退方案保留。
- ~~引擎锁定/解锁的转换通过 `audit_log` 体现~~ —— iter39 新增了专用的 `engine_events` 表。

#### 配置热重载 (iter35) —— SIGHUP + 影响预检

在 iter35 之前，每次配置变更都需要完整重启引擎 —— 重新解密 keystore（scrypt 的开销是实打实的）、丢失进行中的 tick 状态、短暂使交易处于无保护状态。Unix 守护进程早在 1991 年就用 `SIGHUP` 解决了这个问题。iter35 把同样的模式带给了 tradekit，并搭配了结构化的影响分析，在操作员按下回车之前就摆出"这个变更会破坏 23 个活跃订单"。

```bash
# 1. 改动前先预检 —— 这会破坏我正在运行的策略吗？
tradekit config preflight --file ./new-config.json
tradekit config preflight --file ./new-config.json --strict --json  # CI 关卡

# 2. 做出变更 —— 引擎会通过 SIGHUP 自动接收
tradekit config set safety.maxSlippageBps 200
# stderr: [engine: SIGHUP sent to pid 12345 — config reload in flight]

# 3. 手动强制重载（例如手工编辑文件之后）
tradekit config reload
```

**预检规则覆盖范围**（11 个分析器，每个约 50 行）：

| 字段                                               | 收紧判定                   | 对活跃状态的影响                              |
|----------------------------------------------------|----------------------------|----------------------------------------------|
| `safety.maxSlippageBps`                            | 数值更小 = 更紧            | `slippage_bps > new` 的订单/定时任务         |
| `safety.perTxUsdLimit`、`dailyUsdLimit`            | 更小 = 更紧                | warn 级别（在触发前无从得知每笔交易的影响）   |
| `safety.tokenBlacklist`                            | 新增即收紧                 | 引用了被列入黑名单代币的基元                   |
| `safety.tokenWhitelist`                            | 启用 / 移除代币            | 不在白名单内的基元                            |
| `safety.strategyBudgets`                           | 新增规则 / 降低上限        | warn（消耗量在交易时检查）                    |
| `safety.drawdownCircuitBreaker.maxDrawdownPct`     | 更小 = 更紧                | 已经越过新阈值的回撤范围                       |
| `engine.workers.*.{enabled,intervalMs}`            | 禁用 / 修改间隔            | 信息提示                                      |
| `safety.strategyAlerts.{enabled,rules}`            | 禁用 / 新增或移除规则      | 信息提示                                      |
| `engine.resilience.enabled`                        | 禁用 = 更松                | warn（退避层消失）                            |
| `defaultSlippageBps`                               | 更小 = 更紧                | 信息提示（仅影响新交易）                      |

每条警告都带有一个严重度：
- **critical** —— 当前状态违反新规则；操作员必须处理
- **warn** —— 未来的触发可能会被阻止
- **info** —— 可观察但无害

```
$ tradekit config preflight --file ./tighter.json
Config preflight: 5 change(s).
  2 critical · 1 warn · 2 info
  Affected primitives: 3 order(s), 1 schedule(s)

Diffs:
  [tightened] safety.maxSlippageBps  500 → 200
  [added    ] safety.perTxUsdLimit   null → 500
  [tightened] safety.strategyBudgets[playbook:1]  ...
  [changed  ] engine.workers.orders.intervalMs  30000 → 60000
  [tightened] safety.tokenBlacklist  +1 token

Warnings:
  ✕ [critical] safety.maxSlippageBps tightened 500 → 200; 3 active primitive(s) carry a higher per-row slippage and will block on next fire.
      → order #42: slippage_bps=300 exceeds new cap 200
      → order #51: slippage_bps=400 exceeds new cap 200
      → schedule #7: slippage_bps=250 exceeds new cap 200
  ✕ [critical] 1 token added to safety.tokenBlacklist; 1 active primitive references it.
      → order #88: references blacklisted token
  ⚠ [warn] safety.perTxUsdLimit added at $500. Trades estimated above this will block.
  · [info] safety.strategyBudgets[playbook:1] tightened: lifetimeUsd $5000 → $3000.
  · [info] Engine worker "orders" interval 30s → 60s.
```

**热重载流程**（SIGHUP 时发生了什么）：
1. `loadConfig()` 从磁盘重新读取 `~/.tradekit/config.json`。
2. `configSchema.parse()` 校验新的结构。解析失败 → 发出 `config.reload_failed` 通知（critical），保留旧配置，supervisor 继续以旧配置运行。不会静默回退。
3. `computeConfigImpact()` 针对活跃状态运行 —— 与 `config preflight` 完全相同的代码路径。
4. `ConfigRef.set(newConfig)` 原子性地完成切换。在下一个 tick 读取配置的 worker 会看到新配置；进行中的 tick 则用旧配置跑完。
5. 发出 `config.reloaded` 通知，其严重度与最高级别的预检警告匹配，正文则汇总 critical/warn 警告。

**变更时自动触发。** `tradekit config set / push / drop` 在写入磁盘后会自动向正在运行的引擎发送 `SIGHUP`。没有引擎运行时则为空操作。操作员永远不必记着去重启。

**从构造上即可避免竞态。** `ConfigRef` 是一个单写入者容器；SIGHUP 处理函数是唯一的写入者；worker 都是只读的。tick 内部的一致性：每个 `worker.tick()` 在开头读取一次配置，并在整个过程中沿用它。tick 中途的重载是不可见的 —— 该 tick 完全使用旧配置；下一个 tick 完全使用新配置。不存在半切换状态。

**原子性。** 校验发生在切换之前。格式错误的配置永远不会替换正在运行的配置 —— 它会停留在上一个有效状态，并附带一条 `config.reload_failed` 警告。

**MCP** 暴露了 `config_preflight`（一种内联的 `proposed` 结构，带有可选的 `merge` 标志用于部分覆盖）。以编程方式调整安全参数的智能体可以在写入磁盘前先预检。`config_reload` 被刻意不予暴露 —— 跨进程信号是宿主的特权；智能体通过写入文件并调用宿主的 CLI 来触发重载。

#### 原地编辑 (iter34) —— 修改订单 + 定时任务而不丢失状态

在 iter34 之前，调整一个已部署的基元意味着 `cancel` + `create` —— 丢失移动止损的 HWM、尝试计数器、定时任务的 run_count、日志连续性。对移动止损来说这尤其痛：HWM 已经追踪了数小时/数天，却仅仅因为操作员想把止损区间收紧 2 个点就被丢弃。iter34 新增了原地编辑，可保留所有由引擎管理的状态。

```bash
# 收紧移动止损的回撤幅度 —— HWM 得以保留
tradekit order edit 42 --trail-pct 7

# 修改 DCA 周期；run_count + total_base_filled 都保留
tradekit schedule edit 5 --every 12h

# 延长订单的过期时间
tradekit order edit 42 --expires-in 30d

# 把一个定时任务切到 paper 模式跑几个周期
tradekit schedule edit 5 --paper true

# 通过 JSON 批量调参
tradekit order edit 42 --slippage-bps 75 --note "tightened after volatility spike"
tradekit order edit 42 --json
```

**状态保留不变式。** DB 的 UPDATE 语句只触及操作员可编辑的那部分列。由引擎管理的列（`water_mark_usd`、`attempts`、`last_checked_at`、`last_checked_price`、成交数据）永远不会出现在 SET 子句里。两个写入者，零列重叠，零竞态窗口。

**可编辑 vs 冻结。**

| 可编辑                                                                | 冻结（请改用 cancel+create）           |
|-----------------------------------------------------------------------|-----------------------------------------|
| target_price, trail_pct, base/quote amount, slippage, auto-slippage   | side, chain, account                    |
| expires_at, strategy, note, paper                                     | base/quote token, trigger type          |
| （定时任务）cron/every, end_at, max_runs, on_fill spec                | （定时任务）start_at, OCO group         |

**编辑 cron 会自动重新计算 next_run_at。** 操作员的意图是"在新 cron 的下一个自然时点触发" —— 保留旧的 next_run_at（它是根据旧 cron 算出来的）会变成过期数据。

**max_runs 不能降到低于 run_count。** 把定时任务推入"已经超过上限"的状态会让它成为孤儿。如果想在下一次触发后退役，请把 max_runs 设为等于 run_count。

**原子且无竞态。** 该 UPDATE 受 `status='active'`（订单）或 `status IN ('active','paused')`（定时任务）守护。如果在读取与写入之间，某个并发的引擎 tick 已经把这一行翻转为 filled/failed/expired，编辑会以一个清晰的 `INVALID_PARAMS` 中止，并报告当前状态。不会有静默覆盖。

**取证日志的连续性。** 每次成功的编辑都会追加一条 `order_check_log` 记录，其 `decision="edited_by_operator"`，并附带 JSON 编码的字段 diff。当订单最终触发时，`tradekit order replay <id>` 会把操作员的编辑与引擎的 tick 内联展示 —— 完整的生命周期历史。

```
$ tradekit order replay 42
 ✓ 2026-05-20T14:00:00Z  tracking_started  HWM seeded @ $2450
 ⚙ 2026-05-21T03:15:00Z  hwm_advanced       HWM → $2500
 ✎ 2026-05-22T09:30:00Z  edited_by_operator {"trailPct":[5,7]}
 ⚙ 2026-05-23T14:20:00Z  hwm_advanced       HWM → $2620
 🔥 2026-05-25T08:45:00Z  triggered_fired    @ $2436 (HWM 2620, -7%)
```

**空操作编辑是免费的。** 传入与已存储值相同的值：空 diff → 不写日志，不更新 `updated_at`。幂等重试代价低廉。

**MCP** 暴露了 `order_edit` + `schedule_edit`，字段契约相同。对策略进行迭代的智能体（例如根据近期已实现统计来调整滑点的自动调参器）能一次性获得同样的状态保留语义。

#### 引擎韧性 (iter33) —— 退避、tick 计时、把告警当作一个 worker

生产环境的守护进程会以一些典型方式出故障：某个 RPC 挂掉一小时、价格预言机限流、链发生重组（reorg）。在 iter33 之前，引擎会以基础间隔持续猛敲 —— 浪费负载、引发通知风暴，也无从看出"这个 worker 是否随时间变慢了？"。iter33 用三项协同改进弥补了这个缺口。

**把告警当作头等的 worker。** iter32 的策略告警 watcher 现在内置于 `tradekit engine run`。不再需要管理一个边车进程。它是只读 worker（单独运行 `--workers alerts` 时无需钱包密码）。

```bash
# 现在单个进程就能同时做 orders + schedules + reconcile + rebalance + alerts：
tradekit engine run

# 针对特定部署形态运行子集：
tradekit engine run --workers orders,alerts          # 只跑 orders + alerts
tradekit engine run --workers alerts --dry-run        # 仅告警的守护进程（无需密码）
```

**按 worker 的指数退避。** 当一个 worker 累积了 `thresholdFailures` 次连续失败（默认 3 次），它的有效 tick 间隔便几何级增长 —— 此后每次失败都 `interval × backoffMultiplier`，上限为 `maxBackoffMs`（默认 10 分钟）。首次成功后：完全重置回基础间隔。每次转换都会发出一条结构化通知：

- `engine.worker.degraded`（warn）—— 首次跨入退避。字段包含连续失败次数、新的有效间隔、最后一次错误。
- `engine.worker.recovered`（info）—— 一段退化序列后的首次成功。字段包含恢复前经历了多少次失败。

通知按 worker 去重，因此一段漫长的退避不会刷爆 Slack。

**滑动窗口 tick 计时。** 每个 tick 的耗时都被记录在一个有界环形缓冲区里（默认最近 20 个）。`engine status` 为每个 worker 展示 `avg / p50 / p95 / max`：

```
Engine ● RUNNING
  pid: 12345    started: 2026-05-31T10:00:00Z  (uptime 4h)
  status file last updated: 2s ago

Workers (5):
  ● orders     interval=30s  ticks=480  ok=478  fail=2 (0.4%)  last=2s ago  next=in 28s
    tick time: avg 180ms · p50 165 · p95 410 · max 920
  ● schedules  interval=60s  ticks=240  ok=240  fail=0 (0.0%)  last=12s ago  next=in 48s
    tick time: avg 45ms · p50 40 · p95 90 · max 180
  ⚠ reconcile  interval=60s  ticks=240  ok=235  fail=5 (2.1%)  last=4s ago  next=in 8m
    BACKOFF: 5 consecutive failures → effective interval 480s
    tick time: avg 2.3s · p50 1.8s · p95 5.1s · max 9.4s
  ● rebalance  interval=300s  ticks=48  ok=48  fail=0 (0.0%)  last=2m ago  next=in 3m
    tick time: avg 1.2s · p50 1.1s · p95 1.8s · max 2.4s
  ● alerts     interval=300s  ticks=48  ok=48  fail=0 (0.0%)  last=2m ago  next=in 3m
    tick time: avg 110ms · p50 100 · p95 180 · max 240
```

**配置** 位于 `~/.tradekit/config.json` 的 `engine.resilience`：

```json
{
  "engine": {
    "resilience": {
      "enabled": true,
      "thresholdFailures": 3,
      "backoffMultiplier": 2,
      "maxBackoffMs": 600000,
      "tickTimingWindow": 20
    }
  }
}
```

**默认值刻意保守。** 退避启动前要先连续失败 3 次（单次 RPC 抖动不会触发警报）。2× 乘数（熟悉的指数模式）。10 分钟上限（正在调查事故的操作员仍想要一些信号，而不是一个彻底停摆的 worker）。

**不变式：**
- 乘数本身被限制在 `maxBackoffMs / baseIntervalMs`，因此在有效间隔已经触顶之后它永远不会无限增长。否则的话，`still_active` 转换会因乘数持续越过可见上限而永远不停地发通知。
- alerts worker 在它的 tick 不抛异常地完成时报告 `ok=true` —— *触发一条告警本身就是成功的结果*。若用 `ok=!alertsFired`，那么真实告警一旦触发，alerts worker 就会退化 —— 而那恰恰是操作员最需要它的时候。

**JSON 输出**（`engine status --json`）原封不动地展示每个新字段 —— Prometheus 抓取和仪表盘无需解析散文就能获得完整可见性。

#### 模拟交易 paper (iter30)

针对**实时**市场条件（实时价格、真实波动、真实触发）验证策略，**而不**冒真实资本的风险。它弥合了历史回测（`tradekit backtest` —— 过去的数据，可能错过行情体制的变化）与实盘部署（真金白银）之间的鸿沟。同一个引擎、同一套触发、同样的通知 —— 只有 FIRE 这一步是写入虚拟账本，而不是提交一笔链上交易。

```bash
# 1. 给虚拟账本注入种子资金（paper 买入会强制校验虚拟余额）
tradekit paper deposit --chain base --token USDC --amount 10000

# 2. 以 paper 模式部署一个 playbook
tradekit playbook deploy ./eth-strategy.json --paper

# 3. 照常运行引擎 —— paper 订单/定时任务与真实的并排 tick
tradekit engine run --once

# 4. 查看 paper 成交 + 盈亏
tradekit paper trades
tradekit paper balances
tradekit paper pnl          # 仅已实现（确定性）
tradekit paper pnl --mtm    # + 按当前价格对未平仓持仓做标记

# 5. 如果策略看起来不错，就原地把它晋升为真实交易 ——
#    移动止损的 HWM、运行计数器和漂移遥测全部保留
#    （销毁 + 重新部署恰恰会重置 paper 跑出来的那些状态）。
tradekit playbook promote 1
```

**晋升 / 降级。** `playbook promote <id>` 通过与 `order edit` / `schedule edit` / `rebalance edit` 相同的原地编辑机制，把每个活跃基元在 paper 和真实之间翻转：一个在 paper 里追踪了 $3,500 HWM 的移动止损，在变为真实的那一刻仍从 $3,500 起继续保护，并且该翻转会在订单日志里落下一条 `edited_by_operator` 记录。`--to paper` 把一个实盘策略降级回沙盒（例如经历了一次配置惊魂之后）—— 对称、且状态保留。处于终态的基元会被跳过并给出原因；晋升为真实需要交互式确认（或 `--yes`）。**资金预检 (v36)。** 在翻转之前，晋升会向运行时长（runway）机制问出此刻唯一要紧的问题：*如果这些基元现在就是真实的，实际钱包能否为它们提供资金？* paper 基元被假定为真实（`assumeReal`）地分桶，花费代币以及 gas 估算都会与链上余额核对，发现项以最坏者优先打印：`✗ USDC cannot fund even ONE fire` / `⚠ covers 3/4 fires — runs out ~Jul 6` / `gas: no trade history`。默认仅为建议性 —— `--require-funded`（MCP 中为 `requireFunded: true`，强烈建议用于由智能体驱动的晋升）会在出现"连一次触发都无法提供资金"的发现项时以 `INSUFFICIENT_BALANCE` 中止。诚实原则：一个挂掉的 RPC 会报告 `balance UNKNOWN` 并发出警告，但绝不阻止（一次故障不应卡住操作员想做的晋升）；`--skip-preflight` 则完全禁用预检。MCP：`playbook_promote` 在 `yes: true` 时会在结果中返回预检信息。

**按基元的标志。** `--paper` 在 `order create` / `schedule create` / `rebalance create` 上也可用，用于一次性的 paper 基元。`playbook deploy --paper` 会把该标志级联到 spec 中的每一个 order/schedule/rebalance 条目。

**与真实模式完全一致的部分。** 触发谓词、移动止损水位、OCO 级联、定时任务的 cron / `next_run_at` 推进、成交后钩子、通知、引擎锁定（`tradekit engine lock` 同样会暂停 paper）、错误码（瞬时 vs 终态分类）。一笔失败的 paper 交易会用与真实失败相同的 dedupKey 模式发出 `order.failed` / `schedule.failed` 通知 —— 操作员的工作流不变。

**不同之处（刻意为之）。**
- **不解密 keystore。** paper 订单走只读钱包路径；一个纯 paper 的部署完全无需加载加密私钥即可运行。
- **跳过资本追踪类安全护栏。** 回撤熔断、策略预算、每日美元上限、仓位上限 —— 全部跳过。这些追踪的是*真实*资本；paper 交易不应消耗真实预算。引擎锁定仍然生效。
- **最坏情况滑点模型。** 在对交易者不利的方向上取 `spot × (1 ± slippageBps/10000)`。真实成交有时会**优于**现价（路由找到了更好的路径）；悲观记账告诉操作员，当流动性与你作对时策略表现如何 —— 这才是对风险敞口定额真正要紧的答案。
- **合成 tx hash。** 格式：`paper:<id>:<timestamp>`。`paper:` 前缀打破了每个浏览器链接辅助函数对 `0x..` 的假设，因此不会有任何东西试图去 Etherscan 上查看一笔 paper "交易"。
- **无 gas。** paper 交易免 gas。那些只有在 gas 便宜时才盈利的策略，仍应通过 `tradekit backtest` 针对历史 gas 进行验证。

**虚拟账本 schema。** 两张新表（v24 迁移）：
- `paper_trades` —— 镜像 `trades` 的结构；携带 `source_type`（order / schedule / rebalance / manual）+ `source_id` 用于归因。建有 `(strategy, timestamp)` 索引，让按策略的查询保持快速。
- `paper_balances` —— 按 `(account, chain, token)` 维护的虚拟余额流水。`paper deposit` 写入此处；`executePaperTrade` 读取并原子更新。

**已有基元不受影响。** v24 迁移给 `orders` 和 `schedules` 各加了一个 `paper INTEGER NOT NULL DEFAULT 0` 列（v27 将其扩展到 `rebalance_plans`）。每一行已有记录都保持 `paper=0`，并走未经改动的真实交易路径。

**再平衡计划也是 paper 感知的 (v27)。** `rebalance create --paper true` 注册一个计划，其漂移会针对**虚拟**账本来评估 —— `paper balances` 就是投资组合，而不是链上钱包。纠偏腿通过 `executePaperTrade` 触发并回填到同一个虚拟账本，这正是计划得以收敛的原因：一次纠偏落地后，下一个 tick 重新读取（现已纠偏的）账本，看到漂移已回到阈值之内。`playbook deploy --paper` 在 spec 中带有再平衡条目时，会像对 orders/schedules 一样级联该标志 —— v27 之前那个快速失败的 INVALID_PARAMS 已不复存在。先用 `paper deposit` 给账本注入种子资金；一个空的虚拟账本会被视为空投资组合而跳过，而不是报错。paper 计划走只读钱包路径（不解密 keystore），它们的成交以 `source_type='rebalance'` 落入 `paper_trades`。

**已实现轨迹 (v31)。** 每份 MTM 摘要还携带 `realizedTimeline` —— 每次实现盈亏的卖出对应一个累计点位，完全确定性（不涉及任何标记）。CLI 在 `paper pnl --mtm` 和策略报告的估值部分里把它渲染成一条迷你火花线（`▁▂▄▆█`）：同样的 +\$500 总额，呈现为稳步攀升和先冲高再回吐，读起来完全是两回事，而现在你能看出自己拿到的是哪一种。

**按市价计值是可选的 (`--mtm`)。** 默认情况下 `paper pnl` 只报告**已实现**盈亏（收到的 quote 之和 − 花费的 quote 之和）—— 这是成交流水的一个确定性纯函数，脚本化的消费方可以跨运行做 diff。`paper pnl --mtm`（或 MCP `paper_pnl` 工具上的 `mtm: true`）则加上完整的按市价计值视图：从流水中用与真实交易 `pnl` 报告**相同的**加权平均成本基础模型重建持仓，再按当前预言机价格对未平仓持仓做标记 —— 已实现、未实现、总额、未平仓价值，以及每个持仓的明细。每个不同的持有代币只做一次记忆化的预言机调用；原生代币哨兵通过该链的 WETH 计价（与 paper 再平衡漂移相同的约定）。

有两条值得了解的记账规则：
- **存款是资本，不是盈亏。** `paper deposit` 写入一笔没有流水记录的余额，因此由存款注入的存货没有成本基础。卖出它*不实现任何*盈亏 —— 其收益按持仓单独报告（`untrackedSellBase` / `untrackedSellQuote`），而不会虚增已实现盈亏。这与券商对账单采取的立场一致。
- **只有以稳定币计价的成交才进入成本基础。** 一笔以波动性资产计价的成交（例如 PEPE/WETH）在交易时没有美元锚；这类成交仍计入现金流字段，但被排除在成本基础之外，并通过 `skippedNonStableQuote` 展示 —— 这正是真实交易 pnl 报告所采用的规则。

#### 模板化 (iter21)

playbook 文件可以用 `{{NAME}}` 替换来参数化。一个模板覆盖多个部署 —— 操作员不必再为"同一模式在不同资产/阈值/钱包上"维护 N 个几乎相同的文件。

```json
{
  "name": "{{ASSET}}-bracket-dca",
  "description": "trailing + bracket + DCA for {{ASSET}}",
  "chain": "base",
  "vars": {
    "ASSET":       { "type": "string", "required": true, "description": "Base token symbol" },
    "QUOTE":       { "type": "string", "default": "USDC" },
    "TRAIL_PCT":   { "type": "number", "default": 5 },
    "TP_PRICE":    { "type": "number", "required": true },
    "SL_PRICE":    { "type": "number", "required": true },
    "BASE_AMOUNT": { "type": "number", "required": true },
    "DCA_USD":     { "type": "number", "default": 100 }
  },
  "strategies": [
    { "id": "trail", "type": "order", "side": "sell", "trigger": "trailing",
      "trailPct": "{{TRAIL_PCT}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}" },
    { "id": "tp", "type": "order", "side": "sell", "trigger": "price_above",
      "price": "{{TP_PRICE}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}", "group": "bracket" },
    { "id": "sl", "type": "order", "side": "sell", "trigger": "price_below",
      "price": "{{SL_PRICE}}", "baseAmount": "{{BASE_AMOUNT}}",
      "base": "{{ASSET}}", "quote": "{{QUOTE}}", "group": "bracket" },
    { "id": "dca", "type": "schedule", "side": "buy", "every": "7d",
      "quoteAmount": "{{DCA_USD}}", "base": "{{ASSET}}", "quote": "{{QUOTE}}" }
  ]
}
```

用 `--var NAME=VALUE`（可重复）或 `--vars-file PATH`（JSON 对象）部署变体：

```bash
# 用内联变量做一次 ETH 部署
tradekit playbook deploy ./asset-bracket.tmpl.json \
  --var ASSET=ETH --var TP_PRICE=4000 --var SL_PRICE=2700 --var BASE_AMOUNT=1

# 从变量文件做一个 WBTC 变体
echo '{"ASSET":"WBTC","TP_PRICE":130000,"SL_PRICE":80000,"BASE_AMOUNT":0.1}' > wbtc.vars.json
tradekit playbook deploy ./asset-bracket.tmpl.json --vars-file wbtc.vars.json

# 在变量文件之上覆盖单个变量（优先级：--var > --vars-file > 默认值）
tradekit playbook deploy ./asset-bracket.tmpl.json --vars-file wbtc.vars.json --var DCA_USD=250

# 用同一个模板针对历史价格做回测
tradekit backtest playbook ./asset-bracket.tmpl.json \
  --balance '{"ETH":1,"USDC":3000}' --since 30d \
  --var ASSET=ETH --var TP_PRICE=4000 --var SL_PRICE=2700 --var BASE_AMOUNT=1
```

**类型感知的替换。** `"trailPct": "{{TRAIL_PCT}}"`（整字段占位符）渲染为 `"trailPct": 5`（数字），而不是 `"trailPct": "5"`（解析器会拒绝的字符串）。`"name": "{{ASSET}}-bracket"`（嵌入式占位符）通过 String() 强制转换渲染为 `"name": "WBTC-bracket"`。之所以采用不同策略，是因为 JSON 字符串就是字符串 —— 若没有整字段的类型保留，每个数值型模板变量都将需要解析器会拒绝的包裹逻辑。

**校验流水线。**
1. `--vars-file` 的 JSON 被解析；非对象内容报错。
2. `--var NAME=VALUE` 标志被解析；非大写 / 语法错误的名称报错。
3. 合并优先级：默认值 < `--vars-file` < `--var`。
4. 把字符串类型的值（来自 CLI 的总是字符串）强制转换为声明的类型（对数字型变量 `"5"` → `5`）。
5. 解析：未提供值的必填变量报错；类型不匹配报错；未声明的变量变为警告（捕捉拼写错误）。
6. 渲染：遍历 JSON 树并替换；未知变量引用以 JSON 路径报错（`strategies[2].baseAmount: references undefined variable "AMOUNT"`）。
7. 输出传给 `parsePlaybookSpec` —— 在结构上与手写的 v1 playbook 完全相同。

错误会收集进同一条消息 —— 操作员一遍就能修完所有模板问题，与 playbook + 安全校验器的 UX 一致。

**向后兼容。** 既无 `vars` 又无 `{{...}}` 替换的 playbook 会完全跳过渲染。已有的 v1 文件不变照用。对一个非模板文件提供 `--var` / `--vars-file` 是一个显式错误（操作员八成是想用模板）。

**`playbook validate` 会显示已解析的变量。** 在 CI 中很有用：解析模板，用占位符变量渲染，校验输出 —— 在不触碰 DB 的情况下对模板 / spec 错误快速失败。

### 回测（历史策略模拟）

针对一段 CoinGecko 历史价格序列 + 一个起始余额，回放单个订单或定时任务。它会精确告诉你**你的策略本会在何时触发**、触发价格是多少、本会产生多少累计 PnL —— 全程不动用真金白银。驱动模拟的正是实盘引擎所用的同一批触发谓词（`isOrderTriggered`、`evaluateTrailingTrigger`、`matchesAt`），因此回测行为在构造上就与生产行为一致。

```bash
# 过去 30 天里对 1 ETH 做 5% 移动止损卖出，从 1 ETH + 0 USDC 起步。
tradekit backtest order \
  --chain base --base ETH --quote USDC \
  --side sell --trigger trailing --trail-pct 5 \
  --baseAmount 1 \
  --balance '{"ETH":1,"USDC":0}' \
  --since 30d

# 过去 6 个月里每周 $100 的 ETH 定投（DCA），从 3000 USDC 起步。
tradekit backtest schedule \
  --chain base --base ETH --quote USDC \
  --side buy --every 7d --quoteAmount 100 \
  --balance '{"USDC":3000}' \
  --since 6m

# 多资产：过去一年里 60/40 的 ETH/USDC 配 5% 漂移阈值，
# 是否本会跑赢 HODL —— 又会触发多少次纠偏？
tradekit backtest rebalance \
  --targets '[{"token":"ETH","targetPct":60},{"token":"USDC","targetPct":40}]' \
  --drift-threshold 5 --every 6h --since 365d

tradekit backtest list                   # 近期运行，最新优先
tradekit backtest show 7                 # 含触发时间线的完整明细
```

**再平衡回测（多资产）。** 单交易对的模拟器无法对目标权重计划建模，因此 `backtest rebalance` 拥有自己的引擎：每个目标代币一条 CoinGecko 序列（已识别的稳定币会合成一条恒为 $1 的平直序列，而不是浪费一次 API 调用），在 cron 的各个时点评估，并采用早于或等于当前时刻的价格查找（对采样时间戳不对齐的情况具有鲁棒性），以及实盘引擎的腿机制 —— 卖出先为 quote 锚补充资金，买入则从中抽取，按腿的 `minTradeUsd` 跳过，锚资金不足时进行 CLAMP（夹紧）而非凭空印钱。默认的起始账本是 `--initial-usd`（默认 $10k），在窗口起始价格下按目标权重拆分，这使得 `PnL − hold-PnL` 成为纯粹的**再平衡 alpha**：在趋势性行情中通常为负（再平衡过早卖掉赢家），在均值回归的震荡中为正（它系统性地买在低点）。可选的 `--slippage-bps` 对每条腿施加 paper 交易的最坏情况模型，以执行成本来对 alpha 施压。

**参数扫描。** 紧接着的问题 —— *这个交易对的哪个阈值/周期最优？* —— 只需一次网格运行：任意 `--sweep-thresholds 1,3,5,10` / `--sweep-cadences 1h,6h,1d` / `--sweep-min-trades 10,100` 标志都会针对**同一**已抓取序列为每个组合重跑纯模拟器（零额外 CoinGecko 调用），按 PnL 给各变体排名并标出 ★ 冠军，把每个变体持久化为一条 `backtest_runs` 记录，并把整个网格持久化为一条 `backtest_comparisons` 记录 —— `tradekit backtest compare show <id>` 之后可重新渲染该表，MCP 的 `backtest_rebalance` 工具也接受相同的 `sweep_*` 数组。每个网格上限 60 个变体。

**你能得到什么。** 策略 PnL + 一个反事实的 `hold` PnL（如果你什么都不做，你的起始余额会值多少），外加每一次模拟触发的时间线，含时间戳、价格和余额变动。`--json` 输出与持久化记录反序列化得到的结构相同，因此 `backtest show <id>` 返回的数据结构与原始运行相同。

**精度。** 与 CoinGecko 免费档的 `market_chart` 端点绑定：≤1 天 → 5 分钟采样，≤90 天 → 每小时采样，>90 天 → 每日采样。一个带有亚小时级回撤的移动止损，在超过 90 天的范围里无法被准确测试；而每日周期的策略（DCA、每周再平衡）在多年窗口里都能干净地工作。

**成本感知模式 (v40)。** 默认模拟是无摩擦的 —— 这在 vs-hold 比较中会系统性地美化**主动型**策略（每日 DCA 每月触发约 30 次，每一次生产触发都要付滑点 + gas；买入持有则什么都不付）。每个回测命令都接受三个旋钮：

```bash
# 显式摩擦成本
tradekit backtest schedule --side buy --every 1d --quoteAmount 100   --base ETH --quote USDC --balance '{"USDC":3000}' --since 30d   --slippage-bps 25 --gas-usd 0.40

# 或从你自己记录的真实交易中校准
tradekit backtest playbook ./strategy.json --balance '{"USDC":3000}'   --costs-from-history
```

`--slippage-bps` 在每次成交时折损你*收到*的那一侧（买入：更少的 base，或在定 base 模式下花更多的 quote；卖出：更少的 quote），并贯穿余额流动，因此复利效应是真实的 —— 它也参与可负担性判定（一笔无法覆盖价格+滑点的买入会停止）。`--gas-usd` 在估值时刻按每次成交收取一笔固定美元，从最终权益中扣除（模拟只追踪 base+quote；gas 实际是从它并不建模的原生余额中支付 —— 从权益中扣除可避免虚假的余额不足停止，同时保持 PnL 诚实）。`--costs-from-history` 会用 trades 表填入你没有显式传入的那个旋钮：滑点 = 你在该链上最近 50 笔成功的**真实**成交的平均 |`realized_slippage_bps`|（paper 成交携带的是*模拟*滑点 —— 用一个模拟来校准另一个模拟会陷入循环），gas = 平均 `gas_cost_native` × 当前原生币美元价格。来源出处会落入结果备注，以便 `backtest show` 保留上下文。**hold 反事实刻意保持无摩擦** —— 暴露这种不对称正是其全部意义所在。结果携带一份 `costs` 摘要（`fills`、`slippageUsd`、`gasUsd`、`totalUsd`）；文本输出增加一行 `Friction:`，`backtest compare` 则增加一条按场景的摩擦脚注。三个旋钮全部省略时，行为与 v40 之前的零成本模拟逐位一致。

**风险指标 (v41)。** 单看 PnL 只是部署决策的一半 —— "+$50 对比 hold 的 +$30"读起来像是赢了，直到你看到该策略整个窗口都处于 hold 两倍的回撤之下。每份回测结果现在都携带一对在按市价计值权益曲线上计算的 `metrics` / `hold_metrics`（该曲线从触发时间线逐点重建，delta 里含滑点，gas 从每次成交起逐笔扣除）：**最大回撤**（% + 美元 + 峰→谷日期）、**年化波动率**和**夏普比率**（rf=0，年化系数由序列中位间隔推断 —— 5 分钟/每小时/每日数据都能正确年化）、**在市时间**（窗口中 base 敞口 ≥ 权益 1% 的比例 —— 一个在第 30 天里第 2 天就退出的止损，有 27 天处于零加密货币风险），以及一条 ≤100 点的降采样权益 `curve` 供绘图。hold 反事实也获得**相同**的指标 —— 风险调整后的比较需要两边都在同一标尺上：

```
  Strategy PnL:  +$118.40
  Hold PnL:      +$96.00
  Vs hold:       outperformed by +$22.40
  Risk:          max DD −8.2% (−$176.10, 04-12→04-19)   vol 31.4%/yr   sharpe 1.21   in-market 63%
  Hold risk:     max DD −18.0% (−$360.00, 04-10→04-19)   vol 41.0%/yr   sharpe 0.80
```

这一对会持久化到 `backtest_runs.metrics_json`（价格序列本身从不存储，所以指标日后无法重新计算）—— `backtest show <id>` 离线重新渲染该风险块，`backtest compare` 则增加一个按场景的 `MAX DD` 列，让那个靠杠杆式风险取胜的扫描冠军一眼可见。平直曲线报告 `sharpe —`（null），绝不会是 ±Infinity。

**Web 视图 (v42)。** **Backtests 标签页**让各次运行可浏览：一个可过滤的运行列表（`GET /api/backtests`，仅摘要 —— 大体量负载留在详情路由里），可点入查看每次运行的详情（`GET /api/backtests/:id`），其中**策略与 hold 的权益曲线叠加在同一 y 轴标尺上**（实线 vs 虚线 —— 这种形状对比是文本输出无法展示的），完整的风险指标对，带每笔成交摩擦的成交时间线，以及带冠军标记和 MAX DD 的比较表（`GET /api/backtest-comparisons[/:id]`）。这四个端点都是只读的，直接从 `backtest_runs`/`backtest_comparisons` 提供服务 —— web 层从不运行模拟；CLI/MCP 负责产出，标签页负责消费。

**未被模拟的部分。** 池子冲击/MEV（数据精度不支持深度建模 —— v40 的成本是一个按成交的固定模型，而非价格冲击曲线）、安全护栏（操作员想知道的是"触发本会不会发生"；护栏会掩盖那个信号）。你验证的是策略 spec；实盘引擎在其之上叠加生产行为。

**持久化到 `backtest_runs`。** 每次运行都获得一个 id（通过 `backtest list` 可见）。策略 spec、余额、触发时间线、窗口和反事实都会持久化，因此 `backtest show <id>` 无需重新抓取 CoinGecko 数据即可重新渲染。

**多策略回测（`backtest playbook`）。** 针对一条共享价格序列、用一份共享的模拟余额，回放一个完整的 [playbook](#playbooks-declarative-strategy-bundles)（多个订单 + 定时任务）。该模拟器能处理单策略模式无法处理的跨策略交互：

```bash
tradekit backtest playbook ./eth-strategy.json \
  --balance '{"ETH":2,"USDC":1000}' \
  --since 30d
```

OCO 级联在模拟**过程中**触发 —— 当一个同组成员成交（例如 TP 触发），同组中其他活跃成员翻转为 `cancelled`，并在后续 tick 中不再触发。共享余额是顺序的：一个在第 5 小时成交的订单会减少同一 tick 中在第 5 小时触发的定时任务可用的 USDC（每个 tick 中订单先于定时任务评估 —— 与实盘引擎一致）。一个因余额不足而停止的策略会被停泊为 `cancelled`，以便包里其余部分继续评估。

**按策略的拆解。** 输出会展示每个策略的 `finalStatus`（`filled` / `cancelled` / `completed` / `active`）、触发次数和累计 base/quote 变动 —— 回答"我那个 bracket 的哪条腿真正扛起了这笔交易"以及"DCA 预算是否在移动止损退出后存活了下来"。

**多交易对组合 (v43)。** v1 的同交易对约束被解除：一个混合 ETH/USDC 和 WBTC/USDC 策略的 playbook 可以作为一个组合来回测。CLI/MCP **为每个唯一 base 抓取一条价格序列**（上限 6 条），模拟器走一条**合并时间线** —— 即每条序列时间戳的有序并集，每个策略在它自己 base 的早于或等于当前时刻的价格上评估并成交（与再平衡回测对不对齐序列所用的约定相同）。一切都从那**一份**共享 quote 余额里交易，因此跨 base 的资本交互是真实的：一个抽干 USDC 的 ETH DCA 会让 WBTC 突破入场挨饿，OCO 组跨 base 级联，估值/hold/风险指标各自按其序列价格为每个 base 计值。两条不变式保持不变：**每个组合一份共享 quote**（否则共享余额记账会有歧义），以及**钩子腿交易其父策略的交易对**（它们的规模由父策略的成交决定）。再平衡计划仍被排除 —— `backtest rebalance` 是它们自己的多资产模拟器。校验器会在同一条消息里点名每一处违规。

#### 多场景比较 (iter22)

[模板化](#templating-iter21)的直接收益。当操作员手握一个可参数化的 playbook 时，自然的下一个工作流就是**参数扫描** —— 用多组变量包回测同一个模板并挑出冠军。`backtest compare` 针对一条共享价格序列、为每个场景配一份全新余额运行所有场景，并展示一张比较表：

```json
// trail-sweep.json
{
  "name": "trail-pct-sweep",
  "scenarios": [
    { "name": "5pct",  "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 5,  "BASE_AMOUNT": 1, "ASSET": "ETH" } },
    { "name": "10pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 10, "BASE_AMOUNT": 1, "ASSET": "ETH" } },
    { "name": "15pct", "file": "./trail.tmpl.json", "vars": { "TRAIL_PCT": 15, "BASE_AMOUNT": 1, "ASSET": "ETH" } }
  ]
}
```

```bash
tradekit backtest compare ./trail-sweep.json \
  --balance '{"ETH":1,"USDC":0}' --since 60d

tradekit backtest compare list                # 近期比较
tradekit backtest compare show 3              # 重新渲染已存储的比较
```

输出：

```
Backtest comparison #3 "trail-pct-sweep"
  Window:        2026-03-31T... → 2026-05-30T...
  Datapoints:    1440 (CoinGecko base)
  Pair:          ETH/USDC
  Scenarios:     3

  NAME                     PNL       VS HOLD  FIRES   FINAL USD   RUN  WINNER
  ----------------------------------------------------------------------------
  5pct                  +$245.18    +$520.18      1   $2245.18    #14   ★
  10pct                 +$180.42    +$455.42      1   $2180.42    #15
  15pct                  -$74.91    +$199.91      1   $2074.91    #16

  HOLD (no trades)       -$275.00          —      0   $2275.00     —

Winner: 5pct  (PnL +$245.18, +$520.18 vs hold, run #14)
```

**冠军语义。** 在至少触发了一次成交的场景中取 PnL 最高者。`vs hold` 列让"对比什么都不做"的比较可见 —— 一个仍跑输 hold 的"冠军"会被清楚标出。当每个场景都在任何成交之前就停止时，运行器报告"No winner"（强行做出一个误导性的选择，比承认没有数据更糟）。

**同交易对不变式。** 每个场景在其非再平衡策略中都必须引用相同的 `base/quote` 交易对。比较是针对一条价格序列进行的；混合交易对的场景会在一开始就以一个结构化错误浮现出来，并指向"按交易对分别运行独立比较"。再平衡计划天生是多资产的，并不适合共享序列的比较 —— 请改用专门的 `tradekit backtest rebalance`。

**持久化。** 每个场景都写入一条常规的 `backtest_runs` 记录，因此 `tradekit backtest show <run_id>` 对单个场景也可用。比较摘要存放在 v20 的 `backtest_comparisons` 里，通过 id 列表把那些记录关联起来，因此 `backtest compare show <id>` 无需重跑模拟，也无需重新抓取 CoinGecko 数据即可重新渲染。

**作用域限制。** v1 把每个文件的比较上限设为 50 个场景（更大的扫描请拆分成多个文件）。scenarios.json 中的相对 `file` 路径相对于该 scenarios 文件所在目录解析 —— `./trail.tmpl.json` 意为"在 scenarios.json 旁边"，而非"CLI 运行所在之处"。

### 指标(Prometheus / 可观测性)

呼声最高的生产能力:在可抓取的端点上暴露结构化的数值指标。`tradekit` 暴露标准的 Prometheus 文本展示格式(version 0.0.4)——所有主流抓取器都能消费它:Prometheus、VictoriaMetrics、Grafana Cloud、Datadog Agent、OpenTelemetry Collector 等等。

**三种交付形态**,共享同一套核心:

```bash
# 1. 一次性 CLI —— cron + node_exporter 的 textfile 收集器
* * * * *  tradekit metrics > /var/lib/node_exporter/textfile_collector/tradekit.prom

# 2. Web 服务器路由 —— 实时抓取（当 `tradekit web` 正在运行时）
curl http://127.0.0.1:3030/metrics
curl http://127.0.0.1:3030/healthz    # 负载均衡器探活

# 3. 引擎独立监听器 —— 单进程生产部署
tradekit engine run --metrics-port 9090
curl http://127.0.0.1:9090/metrics
```

示例输出:

```
# HELP tradekit_engine_running 1 when the engine supervisor is alive (pid alive + not stopping), else 0.
# TYPE tradekit_engine_running gauge
tradekit_engine_running 1
# HELP tradekit_engine_worker_last_tick_seconds_ago Seconds since each worker's most recent tick; -1 when never ticked. Use `> N` for stalled-worker alerts.
# TYPE tradekit_engine_worker_last_tick_seconds_ago gauge
tradekit_engine_worker_last_tick_seconds_ago{worker="orders"} 12
tradekit_engine_worker_last_tick_seconds_ago{worker="schedules"} 47
tradekit_engine_worker_last_tick_seconds_ago{worker="reconcile"} 47
tradekit_engine_worker_last_tick_seconds_ago{worker="rebalance"} 134
# HELP tradekit_orders_total Total conditional orders persisted, labeled by status.
# TYPE tradekit_orders_total counter
tradekit_orders_total{status="active"} 8
tradekit_orders_total{status="filled"} 23
tradekit_orders_total{status="cancelled"} 4
tradekit_orders_total{status="expired"} 1
tradekit_orders_total{status="failed"} 2
# HELP tradekit_trades_total Total trades persisted, labeled by chain + status (success/failed/pending).
# TYPE tradekit_trades_total counter
tradekit_trades_total{chain="base",status="success"} 41
tradekit_trades_total{chain="base",status="pending"} 1
tradekit_trades_total{chain="arbitrum",status="success"} 7
# ... more families ...
```

**指标清单:**

| 指标族 | 类型 | 基数 | 用途 |
|---|---|---|---|
| `tradekit_build_info{version,node}` | info(= gauge 1) | 1 | 版本标签 join |
| `tradekit_trades_total{chain,status}` | counter | chain × status | 交易量 / 失败率 |
| `tradekit_pending_trades` | gauge | 1 | 卡住交易告警 |
| `tradekit_orders_total{status}` | counter | 5 | 订单流水线状态 |
| `tradekit_schedules_total{status}` | counter | 4 | 定投(DCA)流水线状态 |
| `tradekit_schedule_fires_total` | counter | 1 | 定投(DCA)吞吐量 |
| `tradekit_rebalance_plans_total{status}` | counter | 4 | 再平衡流水线状态 |
| `tradekit_rebalance_runs_total` | counter | 1 | 再平衡吞吐量 |
| `tradekit_audit_rows_total{result}` | counter | 2(ok/err) | 整体活动速率 |
| `tradekit_audit_errors_total{error_code}` | counter | ≤21(前 20 个 + other) | 错误码分布 |
| `tradekit_engine_running` | gauge | 1 | 存活告警 |
| `tradekit_engine_uptime_seconds` | gauge | 1 | 重启检测 |
| `tradekit_engine_worker_ticks_total{worker}` | counter | 4 个 worker | tick 速率 |
| `tradekit_engine_worker_failures_total{worker}` | counter | 4 个 worker | 特定 worker 的失败 |
| `tradekit_engine_worker_last_tick_seconds_ago{worker}` | gauge | 4 个 worker | worker 停滞告警(`> threshold`) |

**基数纪律。** 每个标签都是有界的枚举值。链与状态都是很小的有限集合;worker 名称是 4 个固定字符串;错误码的「前 20 个」上限,避免一个失控的 agent 不断生成各异的错误码,把时间序列索引撑爆。**钱包地址、美元金额、代币数量、策略标签、账户标签都绝不会作为标签暴露**——它们要么会让基数膨胀(无界集合),要么会把运营者信息泄露给任何抓取者。

**生产告警示例:**

```promql
# 引擎已死 或 正在排空
tradekit_engine_running == 0

# 某个 worker 已 5 分钟没有 tick
tradekit_engine_worker_last_tick_seconds_ago > 300

# 交易失败率飙升
rate(tradekit_trades_total{status="failed"}[5m]) > 0.1

# 卡住的待处理交易在堆积
tradekit_pending_trades > 5

# 某个错误码激增
topk(5, rate(tradekit_audit_errors_total[10m]))
```

**无状态快照模型。** 每个指标都从既有的持久化状态计算得来(数据库行数、引擎的 `.engine.status.json` 文件)。没有内存计数器;没有事件总线埋点;抓取之间没有竞态。一次抓取就是一遍小的 SQL 扫描 + 一次状态文件读取——通常只需几毫秒。

### 定时 / 周期性交易(DCA)

条件订单的时间触发版「兄弟」。常驻意图,按 cron 定时任务在固定时刻发起同一笔交易——经典的定投(DCA)/ 定时买入原语——经由与手动兑换相同的 `executeTrade` 流程,因此每一道安全护栏 + 审计日志行 + 通知都原封不动地适用。

```bash
# 每周定投 —— 每 7 天买入 $100 的 ETH
tradekit schedule create --side buy --every 7d --base ETH --quote USDC --quoteAmount 100 \
  --name dca-eth --strategy dca

# 每周一 10:00 UTC；上限 12 次触发（一个季度）
tradekit schedule create --side buy --cron "0 10 * * 1" --quoteAmount 100 --max-runs 12

tradekit schedule list                                 # 默认只列活跃的
tradekit schedule show 1
tradekit schedule pause 1                              # 暂停期间引擎忽略它
tradekit schedule resume 1                             # 重新计算 next_run_at
tradekit schedule cancel 1                             # 终态
tradekit schedule run --once                           # 单次 tick（对 cron 友好）
tradekit schedule run --strict --json                  # 守护进程：默认 watch=30
```

**Cron 表达式**——标准的 5 字段 UTC(`m h dom mon dow`),支持 `*`、范围 `1-5`、列表 `1,3,5`、步进 `*/5` 以及 `1-30/5`。宏:`@hourly`、`@daily`、`@weekly`、`@monthly`、`@yearly`。日期(day-of-month)/ 星期(day-of-week)遵循 POSIX 的「或」语义——`0 10 1 * 1` 会在每月 1 号「以及」每周一的 10:00 UTC 触发。

**时长简写**——`--every 30m`、`1h`、`6h`、`1d`、`7d`。在创建时编译为等价的 cron,并以标准形式存储。无法整除一小时或一天的节奏会被拒绝(这类请用 `--cron`)。

**边界**——可选的 `--start-at <ISO>`(引擎跳过此时间之前的触发)、`--end-at <ISO>`(到达后定时任务翻转为 `completed`)、`--max-runs N`(对**成功**触发次数的终身上限;常用于「分 12 周买入」这类有界活动)。失败的尝试不消耗该上限——一个 `--max-runs 12` 的活动始终会交付 12 笔实际买入,即便途中某些触发碰上了暂时性的 RPC 错误。

**生命周期**——运行期间在 `active → paused → active` 之间循环;终态是 `completed`(到达 max_runs 或 end_at)和 `cancelled`(运营者操作)。失败的触发保持 `active`,因此每个 cron 触发点都独立评估——该行携带 `last_error_code / last_error_message` 供诊断,且会经由通知系统发出 `schedule.failed`。

**运行遥测**——`run_count`(仅成功触发)、`total_base_filled`、`total_quote_spent`、`last_run_at`、`last_run_tx_hash` 在每次触发时累加。`schedule show <id>` 一眼呈现全部信息——快速回答「我到目前为止定投(DCA)了多少 ETH」。

**成交后钩子(iter27)。** 在每次成功触发后自动创建一个后续订单。经典用例:DCA 买入 ETH → 对刚买入的数量自动创建一个跟踪止损(trailing-stop)。iter27 之前,运营者必须在每次触发后手动创建后续订单;有了钩子,定时任务可以自我管理。

```bash
# 定投买入 + 每次触发都自动挂移动止损
tradekit schedule create --side buy --every 7d --base ETH --quote USDC --quoteAmount 100 \
  --on-fill '{
    "type": "createOrder",
    "spec": {
      "side": "sell",
      "trigger": "trailing",
      "trailPct": 10,
      "baseAmount": "{{filled.baseAmount}}",
      "base": "ETH",
      "quote": "USDC"
    }
  }'
```

每次每周定投(DCA)触发后,都会针对刚刚买入的**确切**数量(由 `{{filled.baseAmount}}` 渲染得出)创建一个新的跟踪止损。十二次每周触发 → 十二个跟踪止损,每个都只覆盖它对应创建的那一份。

**模板变量**(每次触发的上下文):
- `{{filled.baseAmount}}` — 成交的基础代币数量(字符串小数)
- `{{filled.quoteAmount}}` — 花费的计价币数量(字符串小数)
- `{{filled.fillPriceUsd}}` — 成交时的美元价格(数字)
- `{{filled.txHash}}` — 成交的交易哈希(字符串)
- `{{filled.fireNumber}}` — 从 1 开始计数的触发序号(数字)

**类型感知的替换**——`"baseAmount": "{{filled.baseAmount}}"`(整字段占位符)渲染为 `"baseAmount": "0.04"`(字符串类型的数量);嵌入式的 `"bracket-{{filled.fireNumber}}"` 会被强制为字符串以便拼接。与 iter21 的 playbook 模板语义相同。

**创建时校验。** 钩子规格会用伪造的成交数据渲染,并在定时任务行持久化**之前**跑一遍订单规格校验器。配置错误(未知变量、缺少 trail_pct、无效 trigger)会立即暴露——而不是几个月后第一次触发时才发现。

**订单也成链(v31)。** 同样的钩子可附加到条件订单——`order create … --on-fill '{...}'`(或 playbook 订单条目里的 `onFill`、MCP `order_create`):一个在 \$1,800 的限价买单成交后,会针对买入的确切数量自动创建跟踪止损。每个订单只触发一次(`fireNumber` 始终为 1);`order replay` 会在成交旁显示 `hook_created` / `hook_failed`;`order edit --on-fill/--unset on-fill` 可就地修改它;playbook 回测对订单钩子的模拟方式与对定时任务钩子相同。

#### 配置历史 + 回滚(v36)——为掌管真金白银的那个文件做变更管理

每一次 `saveConfig` 现在都会向 `config_history` 记录一份去重的、带来源标记的快照(「`cli:config set safety.maxSlippageBps`」、「`rollback:#12`」、init 预设、引擎热重载写入——全部可追溯):

```bash
tradekit config history
#   #14  2026-06-11T03:22:41Z  9f2c01ab…  cli:config set safety.maxSlippageBps ← current
#   #13  2026-06-10T09:00:12Z  77ab3c90…  cli:config push notifications.channels
tradekit config diff-version 13        # 与当前版本的点分路径 diff
tradekit config rollback 13 --yes      # 经 schema 校验的恢复 + SIGHUP 热重载
```

设计要点:记录是**尽力而为、绝不阻塞保存**(文件写入才是契约);只有在数据库已存在时才会开始(纯配置用户不会因 `config set` 而被凭空创建一个数据库);内容相同的快照按哈希去重,因此幂等的重复保存不会堆积行。回滚会**先把存储的快照通过当前 schema 解析**——旧版本会用默认值前向填充更新的字段,而不是把它们剥掉,且硬性校验错误会在任何写入之前中止。一次回滚会记录一个**新**版本:历史只增不减,出错的那个版本会保留下来供取证。可通过 `db.retention.configHistoryDays` 进行修剪。

### 执行质量(execution quality)报告(v44)

交易执行是本工具的核心,而每一笔真实成交都已经记录了它的取证数据:`realized_slippage_bps`(带符号——**正值 = 相对报价不利**)、为其服务的聚合器、`gas_cost_native`。`tradekit execution` 这个界面把那份记录转化为它能回答的生产决策:

```bash
tradekit execution --since 30d [--chain base] [--account ledger]
```

一次离线的数据库扫描产出:**总计**(尝试数/成交数/失败率、美元交易量、带符号滑点的中位数/平均值/p90、滑点**覆盖率**——有多少成交真正带有记录的数值)、**按聚合器**(成交数、占比、滑点中位数 + p90、每个聚合器的成功率、交易量——「哪个路由器实际上对我更好」)、**按交易对**(按交易量排序的前几名)、**按订单规模**(`<$100 / $100–1k / $1k–10k / ≥$10k`——把价格冲击可视化)、**按链的原生单位 gas**(换算成美元需要实时价格;诚实优于一个混在一起的数字),以及**滚动 7 天 vs 前一周期的趋势**(`slippage_trend` 告警的离线孪生版本,以前一窗口作为基线)。

**建议是确定性的且受阈值约束**——只有当数据越过样本下限时它们才发声:聚合器偏好建议需要**每个聚合器**都有 ≥10 笔带滑点标记的成交,且中位差 ≥10bps(然后才建议 `aggregator.mode: "best"` 或重排);规模冲击建议需要每个桶 ≥5 笔成交且增幅 ≥15bps(然后才建议拆单);退化在近期 vs 前一周期中位数 +10bps 时触发;覆盖率低于 50% 会指向 `tradekit reconcile`(它会从回执回填 `realized_slippage_bps`)——在你信任其余部分**之前**。没有阈值被越过 → 显示「(none)」,而不是凭感觉。

**模拟交易(paper)成交按设计被排除**——它们的滑点是模拟的,而用模拟来评判执行质量是循环论证(与 v40 的 `--costs-from-history` 校准遵循同一规则)。转账与转入行也被排除:它们不是兑换,无可衡量。Agent 经由 MCP `execution_report` 获得相同的结构;web 端的**执行(Execution)标签页**(v46,`GET /api/execution`)渲染同一份报告——摘要卡片、聚合器表格、规模/交易对切分、趋势,以及作为高亮告警呈现的建议。

**晋升就绪检查(v49)。** `tradekit playbook promote-check <id>` 回答本工具所有分析投入最终服务的那个问题:**「这个模拟(paper)策略可以上真金白银了吗?」** 它把四个部分组合成一个确定性的裁决:**运行时证据**(下限:7 天 + 5 笔成交——任一不足直接 `NOT READY`;市场情形或执行证据不够)、**模拟(paper)表现**(经由既有的成本基础(cost-basis)行走器计算的已实现 + 按市价计价收益,按观察到的节奏折算为每月 $/月)、**v48 的 paper book 风险块**(最大回撤 / 波动率 / 夏普——属于账本层面,报告中会注明),以及**摩擦-现实交叉核对**:模拟成交记录的是它们**假设**的滑点(`slippage_bps`);你的真实交易记录的是成交实际**花费**(v44 的已实现滑点 + gas 统计)。把真实数字投射到模拟节奏上,得出每月摩擦估计及其占模拟盈亏(PnL)的比例——超过 50% 会标记 `CAUTION: the edge may not survive real execution`,而一次假设滑点低于你真实成交平均值的模拟运行会被点名为过于乐观。数据缺失时诚实降级(无真实历史 → 返回 null,而非虚假的信心;无模拟快照 → 指向快照 worker,绝不阻断)。Agent 获得 `playbook_promote_check`;`playbook promote` 本身仍会运行资金预检——这是该决策中关于策略质量的那一半。

**模拟权益对齐(v48)。** paper book——策略在 `promote` 之前自证身手的入口——现在喂入同一套权益(equity)栈。快照 worker(以及手动的 `tradekit portfolio snapshot --paper`)按实时价格为虚拟账本估值,并写入**同一张** `portfolio_snapshots` 表,置于带命名空间的 `paper:<account>` 作用域下,因此**整套**栈无需任何额外接线即可作用于模拟(paper)策略:`tradekit equity --accounts-key "paper:default"` 渲染权益曲线 + v46 风险块(回撤/波动率/夏普),web 端的作用域选择器会列出它,且节奏门控独立于真实数据源(不同的 note 标签——一个数据源新鲜绝不会饿死另一个)。无法定价的代币会**被排除在总额之外并附带警告**,绝不臆测;空账本是无操作;`engine.snapshotIncludePaper: false` 可退出。晋升决策终于有了它需要的数字:「这次模拟运行过去一个月的最大回撤与夏普」就是一条命令。

**实时权益获得回测的风险数学(v46)。** 实时权益曲线(`tradekit equity`、`GET /api/equity`、web 端盈亏(PnL)卡片)现在携带一个由**同一个** `metricsFromCurve`(回测风险块所用的那个)计算的 `risk` 块:最大回撤(% + 美元 + 峰值→谷底日期)、年化波动率与夏普(节奏从快照时间戳推断——小时级和日级数据源都能正确年化),以及窗口收益。一套数学,三个界面:回测的风险画像与实时投资组合的可以直接比较,因为它们字面上就是同一个函数。

#### 运营者备注——时间线的人类层(v37)

取证时间线全是机器事件。真实的事故复盘还需要人类一侧:运营者**为什么**移动了那个止损,RPC 被轮换时**当时在发生**什么。`tradekit note add "tightened the ETH trail — CPI print tomorrow" --strategy playbook:7` 记录一条注释,合并进统一的时间线(`note.operator`,在 CLI、web 端时间线(Timeline)标签页和 MCP `timeline_query` 中显示在成交/日志/告警旁边)——「事情坏掉前后我做了什么」变成一个视图。未打标签的备注是**全局上下文**,并有意地在任何策略过滤下存活(一次被轮换的 RPC 对每个策略的调查都重要);打了标签的备注则按作用域限定。Agent 经由 MCP 获得 `note_add`/`note_list`——一个记录自己推理的 agent,对下一个会话和审阅它的人类来说都是交接的金矿。无自动保留:人类上下文是最宝贵的取证数据;删除必须显式(`note rm`)。

#### 已实现收益(realized gains)导出(v36)——报税季,一条命令

```bash
tradekit export gains --year 2026 --out gains-2026.csv
#   42 realization(s) in 2026-01-01 → 2026-12-31 (real)
#   total gain 1,284.31 · proceeds 18,402.77 · cost basis 17,118.46
#   method: WEIGHTED-AVERAGE cost basis · gas excluded · not tax advice
```

每个盈亏界面都已共享一个加权平均成本基础引擎;该行走器在内部按每笔卖出计算已实现收益,然后把它们丢弃了。v36 把它们暴露出来:每一笔产生已实现收益的卖出都成为一条记录(日期、卖出数量、所得、成本基础、收益、卖出时的平均成本、交易哈希)——CSV 输出到 stdout(可管道传递;摘要 + 免责声明输出到 stderr,因而绝不会污染数据流)或 `--out FILE`;`--json` 与 MCP `gains_report` 供结构化消费者使用。确定性:这是一次纯粹的成交日志行走,无预言机,因此同一窗口总会导出完全相同的行。

**关键的微妙之处:** 成本基础是路径相关的,因此行走始终看到**完整历史**,而窗口只过滤**输出**记录——一笔 2025 年的买入会正确地为一笔 2026 年的卖出提供基础,而不是冒充一笔莫名其妙的未追踪卖出。方法上的注意事项盖在每一次导出上:加权平均(不是 FIFO/特定批次——某些司法辖区另有要求)、仅限稳定币计价的成交(被跳过的会被计数)、不含 gas(`tradekit pnl` 负责 gas 核算)、没有可追踪基础的卖出单独报告,绝不并入收益。非税务建议。

#### 信号触发订单(v35)——事件驱动执行

第四种触发类型。订单不再轮询价格,而是在一个具名的**外部信号**到达时触发——这就是 TradingView 告警集成模式:

```bash
# 1. 就绪意图（金额 + 安全护栏由你现在设定）：
tradekit order create --side buy --trigger signal --signal-name tv-breakout \
  --base ETH --quote USDC --quoteAmount 500

# 2. 启用 webhook（独立的密钥 —— webhook URL 会在第三方界面里泄露）：
tradekit config set webhooks.signalSecret "$(openssl rand -hex 16)"

# 3. 把 TradingView 的告警指向：
#    POST https://your-host:3030/api/signal/tv-breakout?key=<secret>
# （或手动 / 从 agent 触发：`tradekit signal fire tv-breakout`，MCP signal_fire）
```

**语义,精确地说。** 一个信号是一个**点事件**:一个事件会触发**在它到达之前就已就绪**的每一个活跃监听器(后就绪的订单绝不会被陈旧信号触发),随后被消耗——对每个监听器至多投递一次,且一次暂时性失败的触发**不会**在同一事件上重试(那个时刻已过;失败通知会告诉你)。模拟运行(dry-run)的 tick 和引擎锁跳过都不消耗事件。未被认领的事件在 1 小时后过期。过期、OCO 分组、on_fill 钩子、动态定额以及 v33 的崩溃窗口守卫,对信号订单的适用方式与对价格触发订单完全相同——且每次触发都经由 `executeTrade`,带完整的安全栈。

**Playbook 也会说信号(v37)。** 订单条目接受 `"trigger": "signal", "signalName": "tv-breakout"`——完整的 TradingView 策略(信号入场 + OCO 括号单 + 定投(DCA)定时任务)作为**一个** playbook 文件部署,通过 promote 在模拟(paper)↔真实之间切换,并像其他一切一样做 diff/替换(`signalName` 变更归类为重建——它属于触发身份)。`signalName` 有意**不**做 playbook 命名空间隔离:外部告警名是全局的,而多个 playbook 监听同一个信号是一项特性。Playbook**回测**会对照**记录的信号历史**重放信号入场——`backtest playbook ... --signals-from-history` 回答「以我实际收到的告警,这个策略本会表现如何?」:每个入场在信号收件箱中匹配到的到达时间「之时或之后」的第一个数据点上触发(「webhook 之后的下一次引擎 tick」的模拟孪生版本),窗口之前的陈旧到达绝不触发,on_fill 括号单 + OCO 级联照常模拟。MCP `backtest_playbook` 额外接受一个内联的 `signals: [{name, at}]` 数组用于**假设性**重放(「如果告警早一天到会怎样?」)。若未提供历史,信号入场会被拒绝并附一条教学信息——没有历史可重放是猜测,不是模拟。

**可观测性(v36.5)。** 信号流经每一个取证界面:时间线增加 `signal.received` 事件(被消耗 → info,带触发的订单 id;**PENDING / 未认领过期 → warn**——一个到达却什么都没触发的告警,正是集成调试需要的信号),每日摘要统计 `Signals received: N (M fired, K fired NOTHING ⚠)`,`tradekit doctor` 会在存在信号就绪订单但 `webhooks.signalSecret` 未设置时发出警告(webhook 端点被静默禁用),web 端的自动化(Automation)标签页渲染 `on signal "X"` 触发器,而 `GET /api/signals` 提供收件箱。

**风险画像,诚实地说。** 该 webhook 端点是在原本只读的 web API 上唯一的入站写入界面。它在构造上即有界:一个伪造的信号只能触发**你用自己的金额预先就绪的订单**——它无法选择代币、规模或方向。秘密以恒定时间比较,长度 ≥16 字符,未设置则端点返回 404。信号订单只能对照提供的信号历史进行回测(经由 `--signals-from-history` 记录,或经由 MCP `signals[]` 做假设性回测),且钩子腿不能信号就绪(无可校验对象)——两者否则都会被拒绝并附清晰信息。

**钩子失败不会回退成交。** 如果钩子在触发时报错(例如渲染出的数量对滑点上限来说太小),成交仍然保留——交易已经发生——并会发出一条带错误码的 `schedule.on_fill_failed` 通知。运营者可以调查并手动创建后续订单。成功则发出 `schedule.on_fill_created`。

**无递归。** 钩子创建的订单自身绝不携带钩子(钩子规格方言里没有 `onFill` 字段)。所以一个 DCA 的钩子创建一个跟踪止损;当该跟踪止损之后触发时,不会再有进一步的钩子触发。在构造上即有界。

**策略标签会传递。** 自动创建的订单原封不动地继承定时任务的 `strategy` 列。一个标记为 `playbook:1` 的定时任务,产出标记为 `playbook:1` 的订单 → tradekit 的 playbook + 策略预算过滤器会自动覆盖它们。

**激活边界——`--start-at` / `--start-in`(v38)。** 订单获得了定时任务一直拥有的激活窗口:**「只在 18:00 美联储宣布之后才就绪这笔突破买入」**。在 `start_at` 之前,引擎**完全**忽略该订单——不做触发评估,不维护跟踪水位(宣布前的震荡绝不能设置你止损用来衡量回撤的那个最高水位 HWM),且预启动期间收到的信号对该订单**永久不合格**(合格性始于 `max(created_at, start_at)`——一个在你就绪之前就触发的告警,早于你的意图)。有三条边界在预启动期间被有意地继续适用:过期会让订单退役(有效期窗口 ≠ 活动窗口)、OCO 同伴可以取消它,以及资金跑道继续为其一次性花费保留额度(保守做法)。「过期早于启动」会在创建时被拒绝。适用于每一种触发类型,以及 playbook 订单条目。

**仓位级定额——`"max"` 与 `"N%"`(v35)。** 订单和定时任务的金额在**花费一侧**接受 `max` 哨兵值(卖出 → `baseAmount`,买入 → `quoteAmount`):它在**触发时**解析为实时余额——真实触发用链上余额,模拟(paper)用虚拟账本,回测用模拟余额。这让最自然的止损终于可以表达:一个 DCA 周复一周地增长你的仓位,而**一条** `order create --side sell --trigger trailing --trail-pct 10 --baseAmount max` 就能保护**全部**——没有固定切片,无需每次触发后重新堆叠,止损会在触发时自动覆盖你当时所持有的一切。百分比补全了这个家族(v35.5):`"37.5%"` 解析为触发时可花费余额的那个比例——`100%` 在构造上 ≡ `max`,采用整数 ppm 数学,因此 18 位小数的余额不会漂移。它们让**分批退出(scale-out)**得以表达:一个 `[{price_above 2600, baseAmount: "50%"}, {trailing 10%, baseAmount: "max"}]` 的括号单会在目标价拿走一半,并对**剩余的任何部分**进行跟踪——每条腿都按它触发**之时**仓位的实际状态来定额,这正是部分退出之后你想要的语义。接收一侧的哨兵值会在创建时被拒绝并附教学错误(那一侧由报价推导而来),无效金额——包括 `150%`——现在会在创建时失败而不是在首次触发时失败,而资金跑道会把动态定额的原语列在 `skipped` 之下并给出明确原因(它们的花费是当时实际持有量的函数)。注意:同一代币上多个同时的 `max` 止损会竞争——先触发的拿走仓位;把它们配成一个 OCO 分组。手动交易也继承了百分比形式(`trade sell --baseAmount 25%`)。

**每次触发的 OCO 括号单。** 把 `{{filled.fireNumber}}` 与 `group` 字段结合,给每次触发它自己的 OCO 分组:

```jsonc
{
  "type": "createOrder",
  "spec": {
    "side": "sell", "trigger": "price_above", "price": 5000,
    "baseAmount": "{{filled.baseAmount}}",
    "base": "ETH", "quote": "USDC",
    "group": "bracket-{{filled.fireNumber}}"
  }
}
```

触发 1 → 分组为 `bracket-1` 的订单。触发 2 → 分组为 `bracket-2` 的订单。每次触发的括号单都是独立的——没有跨触发的 OCO 级联。

**多腿括号单(`createOrders`)。** 一次成交可以原子地派生出多个后续订单——经典的括号单是对刚买入的切片同时挂一个止盈和一个止损,其中任一触发都会取消另一个:

```jsonc
{
  "type": "createOrders",
  "specs": [
    { "side": "sell", "trigger": "price_above", "price": 3000,
      "baseAmount": "{{filled.baseAmount}}", "base": "ETH", "quote": "USDC" },
    { "side": "sell", "trigger": "price_below", "price": 1500,
      "baseAmount": "{{filled.baseAmount}}", "base": "ETH", "quote": "USDC" }
  ]
}
```

每个钩子 2–4 条腿。未声明显式 `group` 的腿会**按每次触发自动配成 OCO 对**(生成的分组为 `hook-<parent>-<fireNumber>`):止盈触发 → 止损消亡,反之亦然——无需手动维护分组,且每次触发的括号单都独立于上一次触发。在任一腿上声明显式 `group` 即可自己接管配对。腿的创建是**全有或全无**:如果第 2 条腿在触发时校验失败,第 1 条腿会被回滚(取消,行保留供取证),然后才发出 `on_fill_failed` 通知——一个只有单臂的括号单绝不会存活。在 `createOrder` 可用的所有地方都可用:定时任务 + 订单钩子、playbook 条目,以及 playbook 回测(模拟会派生每一条腿并重放 OCO 级联——在每策略统计里显示为 `dca:hook#1.1` / `dca:hook#1.2`)。

**模拟(paper)继承。** 钩子订单继承父级的模拟(paper)标志:一个模拟 DCA 的括号单存在于 paper book 上,绝不会落到真实账本上。

### MEV 保护提交(私有内存池)

以太坊主网上(以及在其他链上不同程度地)的公开内存池 DEX 交易,经常遭到三明治攻击:机器人抢跑这笔兑换、操纵价格,然后尾随套利。典型的被提取价值:每笔 0.5–3%。Tradekit 的安全护栏(滑点上限、gas 预算、仓位限制)**不解决这个问题**——它们限制的是 tradekit **允许**一笔交易做什么,而不是公开内存池在交易传输途中能**对**它做什么。

标准的缓解办法是把已签名的交易经由一个私有中继 RPC 提交,该 RPC 直接转发给区块构建者,而不把交易暴露给公开内存池。Tradekit 支持按链进行此设置:

```bash
tradekit config set mev.enabled true
tradekit config set mev.privateRpcs.ethereum 'https://rpc.flashbots.net/fast'
tradekit config set mev.labels.ethereum 'Flashbots Protect'

# 验证可达性 + chainId + 延迟：
tradekit doctor
#   ✓  mev:ethereum (Flashbots Protect)  reachable in 234ms
```

| 中继 | URL | 备注 |
|---|---|---|
| Flashbots Protect | `https://rpc.flashbots.net/fast` | 免费;「fast」端点纳入更多构建者以加快上链 |
| MEV Blocker | `https://rpc.mevblocker.io` | 免费;返还给用户而非构建者 |
| Merkle Private RPC | `https://rpc.merkle.io/<api-key>` | 免费档 + 付费档;API key 在 URL 路径中 |
| BloXroute / Eden / 其他 | 多种 | 大多数兼容 JSON-RPC 的中继都能通过同样的配置工作 |

**读取 vs 写入。** 读取(余额、回执、`eth_call`)继续使用公开 RPC 的回退链。写入(每一次 `walletClient.writeContract` / `sendTransaction` 调用)经由私有中继路由。之所以这样拆分,是因为大多数中继会把提交的交易私下缓冲若干区块后才传播——对一笔刚提交的私有交易调用 `eth_getTransactionByHash` 会返回「not found」直到其上链,这会让每一次回执等待挂起。

**失败模式**——`mev.fallbackToPublic`(默认 `false`):
- `false`:私有中继故障会让交易**硬失败**,而不是泄露到公开内存池。MEV 保护的保证被维持。推荐。
- `true`:如果私有这条腿出错,viem 会回退到公开 RPC。交易会上链;MEV 保护可能不会。适用于比起泄露更看重可用性的运营者。

**秘密卫生。** 内嵌 API key 的私有 RPC URL(Merkle 等)在 `tradekit config show`、审计日志以及 MCP `config show` 中会被仅保留主机名地脱敏处理。路径被替换为 `[REDACTED]`。用 `tradekit config show --show-secrets` 查看原始值。

**按链选择启用。** 只有在 `privateRpcs[<chain>]` 中有条目的链才会私有路由——其他链照旧公开提交。所以为 ethereum 启用 MEV 不会影响 base 或 arbitrum 的交易。设置 `enabled: false` 可全局禁用。

### 通知(推送投递)

用于推送式投递「运营上值得关注」事件的 webhook 渠道——订单引擎与 cron-watch 循环的天然补充。在 `config.notifications.channels[]` 中配置一个或多个渠道:

```bash
tradekit config push notifications.channels '{
  "name": "ops-slack",
  "url": "https://hooks.slack.com/services/T0XXXX/B0XXXX/abcdef",
  "events": ["order.filled", "order.failed", "trade.failed", "approval.infinite"],
  "minSeverity": "info"
}'

tradekit notify list                    # 显示已配置的渠道（URL 路径已脱敏）
tradekit notify test --channel ops-slack
```

**自动识别的格式:**

| URL host 模式 | 格式 | 负载 |
|---|---|---|
| `hooks.slack.com` | Slack | Block Kit(header + section + context) |
| `discord.com/api/webhooks` | Discord | 单个 embed,带颜色 + 字段 |
| `api.telegram.org/bot…/sendMessage?chat_id=…` | Telegram | MarkdownV2 文本 |
| 其他任何 | 通用 | `POST {event, severity, title, body, fields, link, timestamp}` |

**内置事件:**

| 事件 | 严重级别 | 何时 |
|---|---|---|
| `order.filled` | info | 订单触发条件满足 + 交易成功 |
| `order.failed` | warn(回滚)/ critical(终态) | 订单的交易在链上回滚 / 安全保护被触发 |
| `order.expired` | info | 订单未触发就到达了 `expires_at` |
| `order.cancelled_oco` | info | 因 OCO 同伴触发而自动取消订单(每个被取消的同伴一个事件) |
| `schedule.fired` | info | 周期性定时任务成功发起了一笔交易 |
| `schedule.on_fill_created` | info | 成交后钩子自动创建了一个后续订单(iter27) |
| `schedule.on_fill_failed` | warn | 成交落定**之后**钩子报错——可能需要手动后续处理 |
| `digest.daily` | 按裁决映射(healthy=info,attention=warn,critical=critical) | v31 引擎推送的每日摘要(notifications.digest) |
| `schedule.failed` | warn(回滚)/ critical(终态) | 定时任务的交易失败;定时任务保持 active 等下一个时段 |
| `schedule.completed` | info | 定时任务到达了 `max_runs` 或 `end_at` |
| `trade.failed` | warn | 任何直接兑换在链上回滚 |
| `approval.infinite` | critical | 一个 `maxUint256` 授权额度被成功授予(风险最高的链上操作) |
| `engine.locked` | warn | Iter28——运营者启用了全局急停开关;所有交易路径现在都拒绝 |
| `engine.unlocked` | info | Iter28——急停开关清除;交易恢复 |

**按渠道过滤**——每个渠道有可选的 `events: [...]`(白名单;空/缺省 = 全部)和 `minSeverity`(下限;`info` 放行一切,`critical` 限制为仅 critical)。

**去重**——`config.notifications.dedupWindowMs`(默认 60s)在窗口内抑制相同的 `(channel, dedupKey)` 对。一个反复失败的订单每分钟产生一条告警,而不是每个 tick 一条。

**摘要携带权益变动(v38)。** 有了 v37 的快照数据源到位,每日摘要的第一个问题——「投资组合表现如何?」——终于有了一行:`EQUITY: $10,002 → $10,184 (+$182, +1.82%) · 4 snapshots`,像每个权益界面一样遵守作用域纪律,并在窗口内少于两个数据点时静默省略(绝不失败)。

**安静时段(v34)——什么都不丢,谁都不被吵醒。** 严重级别路由没有时间维度:凌晨 3 点的 info 级 `schedule.fired` 是噪声,但整夜把渠道静音也会把凌晨 3 点的 `circuit_breaker` 一起静音。`notifications.quietHours` 加入了时间轴:

```jsonc
{
  "notifications": {
    "quietHours": { "enabled": true, "startHourUtc": 22, "endHourUtc": 7, "breakthroughSeverity": "critical" },
    "channels": [
      { "name": "ops-slack", "url": "https://hooks.slack.com/..." },
      { "name": "pager", "url": "https://...", "minSeverity": "critical", "ignoreQuietHours": true }
    ]
  }
}
```

在窗口内(当 `start > end` 时跨午夜),低于 `breakthroughSeverity` 的通知会被**排队,而非丢弃**——它们落入 v34 的 `notification_queue` 表,并在窗口结束时作为**一条汇总通知**刷新(「安静时段内抑制了 12 条:1 critical · 4 warn · 7 info」加上最后 15 条标题,携带这一批的最高严重级别)。三个刷新触发点:窗口结束后的第一次投递(机会性的,因此汇总会在那个唤醒渠道的事件之前先到)、引擎摘要 worker 的 tick(覆盖平静无事的早晨),以及 `tradekit notify flush`(`--force` 在窗口中途刷新)。`breakthroughSeverity` 事件始终立即投递,任何带 `ignoreQuietHours: true` 的渠道也是——这就是 pager 模式。失败诚实:如果汇总 webhook 失败,行会保留排队等待下次尝试;如果入队本身失败,通知立即投递(fail open——一个坏掉的队列绝不能吞掉告警)。用 `notify queue` 检查;通过 `db.retention.notificationQueueDays` 修剪。

**可靠性不变量**——webhook 投递是**尽力而为且绝不会从一笔交易或一次引擎 tick 中抛出异常**。一次 Slack 故障无法阻塞一笔成交。所有失败都落入 `~/.tradekit/server.log` 供事后排查。

**安全**——webhook URL 在路径中内嵌承载令牌(bearer token)。它们在所有可能泄露的地方都被脱敏:`notify list`、`config show`(用 `--show-secrets` 看原始值)、审计日志,以及 MCP `notify_list`。只有磁盘上的配置持有原始值(权限 0600)。

### 授权额度(安全关键)

```bash
tradekit allowances [--chain <name>] [--account <label>] [--json]
# 探测知名聚合器路由器 × 链 profile 的代币列表；报告
# 任何非零额度。在交易前/后用它来审计长期敞口。

tradekit allowances audit [--chain X | --chains a,b,c | --chains all] [--lookback-blocks N] [--usd-threshold N] [--json]
# 为每一项长期授权做风险评分：infinite_unknown_spender (CRITICAL)、large_usd_exposure (WARN)、
# stale_approval (WARN —— 仅在带 --lookback-blocks 时) 等。返回一个结构化的 `recommendedActions[]`，
# 携带按美元敞口排序的前 3 个关键撤销目标（无限额度优先）。多链模式
# 聚合跨链的前 3 名 —— 在 5 条链上都有关键授权的运营者无需逐行扫描，
# 就能看到最紧迫的 3 个待撤销项。

tradekit allowances revoke-all [--chain X] [--account L] [--spender X] [--token Y] [--simulate] [--yes]
# 批量撤销匹配的行。配合 `audit` 输出脚本化“撤销所有关键项”：
#   tradekit allowances audit --json | jq -r '.recommendedActions[].params.spender' | \
#     xargs -n1 -I{} tradekit allowances revoke-all --spender {} --yes

tradekit approve <token> <spender> [--amount <decimal> | --infinite] [--force-infinite] [--chain X] [--account L]
tradekit revoke  <token> <spender> [--chain X] [--account L]
```

`approve` 受与保护兑换相同的那套 `safety` 配置约束:

- **代币黑名单**——拒绝授权列出的代币
- **合约白名单**——只允许授权列出的 spender(当白名单非空时)
- **无限授权门控**——`--infinite` 需要 `--force-infinite`(或 `safety.allowInfiniteApprovals=true`)
- **`safety.maxApprovalUsdLimit`**——为单笔授权的美元计价价值设上限

### 数据与运维

```bash
tradekit health    [--accounts X,Y|all] [--chains a,b,c] [--summary] [--strict] [--quiet] [--json] [--watch N]
                   # 运维面板：投资组合 + 7 天 PnL + 交易质量 + 长期授权 + nextActions。
tradekit status    [--section S,S,...] [--json] [--watch N]
                   # 运营面板：引擎 worker、临近触发的订单、定时触发、再平衡漂移、
                   # playbook 部署、回撤熔断器、策略预算、24h 审计异常、
                   # 当前正在触发的策略告警（+24h 转换）、模拟盘快照。
                   # 把约 10 个读侧查询组合进一个态势感知视图；亚 100ms，零 RPC。
                   # 章节：engine,orders,schedules,rebalance,playbooks,drawdown,budgets,activity,alerts,paper。
tradekit digest    [--window 1h|24h|7d|30d] [--format text|slack|json] [--compare] [--strict]
                   # 窗口化活动报告。与 status 搭配（此刻 vs 窗口）。slack 格式可直接
                   # 管道送入 Slack incoming webhook 用于每日 cron 报告。--strict 在 critical 时以退出码 2 退出。
tradekit holdings [<address> | --account <label>] [--chains base,arbitrum,...|all] [--strict] [--json] [--watch N]
tradekit portfolio [--accounts a,b,c|all] [--chains a,b,c|all] [--limit N] [--strict] [--json]
tradekit pnl       [--chain <name>] [--account <label>] [--accounts a,b,c|all] [--windows 1d,7d,30d] [--json]
tradekit trades    [--chain <name>] [--account <label>] [--token T] [--status pending|success|failed]
                   [--note <substr>] [--limit N] [--format table|csv|json] [--out <file>]
tradekit trades sync [--chain X] [--account L] [--since-days N] [--strict] [--summary] [--json]
                     # 从链上历史回填 DB（按 tx_hash 幂等；用书签续传）。
tradekit trades analyze [--since YYYY-MM-DD] [--aggregator <name>] [--strict] [--json]
                     # 聚合器质量评分卡（按聚合器划分的滑点统计）。
tradekit price     <symbol|addr> [--chain <name>] [--period 1d|1w|1m|1y] [--strict] [--json] [--watch N]
tradekit trending  [<query>] [--chain <name>] [--limit N]
tradekit audit     [--limit N] [--since YYYY-MM-DD] [--tool T] [--account L] [--chain X] [--caller cli|mcp|web]
tradekit audit summary [--since N] [--tool T]    # 聚合计数 + 错误率（对 cron 友好）
tradekit audit prune --before YYYY-MM-DD [--yes] # 预览 + 删除旧的审计行
tradekit viewTx    <hash> [--chain <name>]
tradekit chains                       # 列出链；活跃的那条用 * 标记
tradekit chain     [<name>]           # 显示或切换活跃链
tradekit reconcile [--chain X] [--account L] [--watch=Ns] [--summary] [--json]
                   # 遍历待处理交易，查询链上回执，更新状态。
tradekit pending   [--chain X] [--account L] [--strict] [--summary] [--json]
                   # 诊断卡住的交易（gas / nonce / mempool），对每行给出裁定。
tradekit tx speedup <hash> [--chain X] [--multiplier N] [--pass <pw>] [--json]
                   # 在相同 nonce 上用更高 gas 的替换交易替换一笔卡住的待处理交易
                   # （默认 ×1.2）。当 `pending` 返回 action=speedup 时使用。
tradekit tx cancel  <hash> --yes [--chain X] [--multiplier N] [--pass <pw>] [--json]
                   # 破坏性操作：在相同 nonce 上用一笔零额自转账替换待处理交易
                   # （撤销原本的意图）。当 `pending` 返回 action=cancel 时使用。
tradekit doctor    [--chains base,arbitrum,…|all] [--strict] [--summary] [--quiet] [--json] [--watch N]
tradekit verify    [all | backup <file> | wallet | config | db] [--strict] [--summary] [--quiet] [--json]
                   # 完整性检查套件（数据 + 配置 + 钱包完整性）。
```

### 运行状态仪表盘 (iter23)

`tradekit status` 把引擎 worker、活跃的订单/计划/再平衡方案、playbook、回撤熔断器、策略预算以及 24h 审计异常组合进一个统一的态势感知视图。它与 `tradekit health`（财务摘要）不同——`status` 回答的是"引擎此刻正在主动管理什么 + 哪些即将触发/熔断"。

```
TRADEKIT STATUS  ·  2026-05-30T14:00:00.000Z

ENGINE
  pid=12345  started 2h 14m ago  updated 25s ago
  ● orders     last tick 25s ago  (interval 30s, 245 ok, 2 fails)  ← TX_REVERTED on 0xabc...
  ● schedules  last tick 30s ago  (interval 30s, 12 ok)
  ● rebalance  last tick 4m ago   (interval 5m, 9 ok)
  ✕ reconcile  last tick 2h ago   (interval 60s, 0 ok)  ← stale > 4× interval

ORDERS  (3 active, 12 filled, 1 cancelled, 0 expired, 0 failed)
  Closest to trigger:
    #14   sell ETH/USDC  price_above $3000              cur=  $2952.40   1.61% away
    #19   sell ETH/USDC  trailing 5% (HWM $2980.00)     cur=  $2952.40   4.10% away
    #22   sell ETH/USDC  price_above $4000              cur=  $2952.40  35.49% away

SCHEDULES  (2 active, 0 paused)
  #5    eth-weekly-dca   cron "0 0 * * 0"  next fire 2d 14h  (4 runs)
  #7    wbtc-monthly     cron "0 0 1 * *"  next fire 22d 0h  (0 runs)

REBALANCE PLANS  (1 active)
  #2    core-folio       chain=base  drift>5%  next eval 4h 12m  · last drift 3.20%, 0 legs

PLAYBOOKS  (1 deployed)
  #1    eth-bracket-dca  deployed 14d ago

DRAWDOWN BREAKER
  enabled (maxDrawdown 15%, autoResume<5%)
  scope=global  peak $5240.00  last $4980.20  drawdown 4.96%  ● ok

STRATEGY BUDGETS
  playbook:*           [2 matches]  lifetime $1247.50/$5000.00 (25%)  24h $145.00/$500.00 (29%)
  arb-experiment                    lifetime $250.00/$1000.00 (25%)  per-fire cap $50.00

LAST 24H  (47 audit rows, 3 errors)
  Top errors:
    SLIPPAGE_TOO_HIGH               2 occurrences  (last 2026-05-30T11:32:00Z)
    RPC_FAILED                      1 occurrence   (last 2026-05-30T09:45:00Z)
```

**章节过滤。** `--section orders,drawdown` 只渲染指定的章节。默认 = 全部 8 个。

**临近触发计算。** 每个活跃订单存储的 `last_checked_price`（由订单引擎在每次 tick 时写入）给出触发的百分比距离，**无需**新的 RPC 调用。过期的价格读数（> 1h）会标注 `⚠ stale check`。追踪类订单使用 `water_mark × (1 ± trail_pct/100)` 作为阈值。

**亚 100ms、零 RPC。** 约 10 次有索引的数据库查询 + 1 次状态文件读取。没有 oracle 调用。每个临近触发订单显示的"当前价格"是引擎最近一次的观测值；超过 1h 时会标注新鲜度。

**结构上即组合。** 复用每一个现有的数据库辅助函数（`listOrders`、`listSchedules`、`orderCountsByStatus`、`auditSummary` 等）——没有新的持久化，没有新的 schema。新模块纯粹是编排 + 渲染。

**可持续观察。** `--watch 30` 每 30 秒重新渲染一次，适合在事故响应或主动策略监控期间放在旁边的终端里。

### 活动摘要 (iter24)

`tradekit digest` 是 `status` 的天然补充：
- **`status`** 回答的是"引擎**此刻**在做什么"。
- **`digest`** 回答的是"过去 **N 小时/天**发生了什么"。

它把一个时间窗内的交易 + 策略触发 + 告警 + 模拟盘活动 + 安全事件 + 高频错误组合进一份面向操作者的报告。三种格式：

```bash
tradekit digest --window 24h                       # 文本（终端）
tradekit digest --window 24h --format slack        # 供 Slack webhook 用的 markdown
tradekit digest --window 24h --format json         # 结构化形态
tradekit digest --window 7d --compare              # 增加与前一窗口的差值
tradekit digest --window 24h --strict              # 裁定为 🔴 critical 时以退出码 2 退出
```

**Slack 就绪输出**解锁了适合 cron 的每日报告工作流：

```bash
# /etc/cron.d/tradekit-digest
0 9 * * * tradekit digest --window 24h --format slack | \
  curl -X POST -H 'Content-Type: text/plain' --data-binary @- $SLACK_WEBHOOK
```

**……或者干脆跳过 cron (v31)。** 引擎的 `digest` worker 每个 UTC 日一次，把同样的 markdown 推送到已配置的通知渠道（Slack / Discord / Telegram / webhook）：

```bash
tradekit config set notifications.digest '{"enabled":true,"hourUtc":9,"window":"24h","minVerdict":"healthy"}'
# 无需重启引擎 —— SIGHUP 热重载会接收它
```

每个 UTC 日在 `hourUtc`（或之后）最多发送一次，通过一个标记文件跨重启去重。`minVerdict: "attention"` 把摘要变成一份*只在出问题时才告警*的报告——低于门槛的一天不会被标记为已发送，所以一旦健康度退化越过门槛，摘要立即发出。使用与 `--format slack` 相同的 `renderDigestMarkdown` 渲染器，因此渠道格式与 cron 路径完全一致。

slack 格式使用 Slack 的 mrkdwn（`*bold*`、`_italic_`、`\`code\``）以便在频道中直接渲染——无需 JSON 包裹。

**v28/v29 感知。** 摘要直接读取持久化日志：**ALERTS** 章节统计窗口内精确的 fired/resolved 状态转换（外加当前活跃快照和高频规则类型），**PAPER** 章节让模拟运行(dry-run)策略在每日报告中可见，触发章节在启用 `engine.scheduleJournal` / `rebalanceJournal` 时加上日志精确的 schedule/rebalance 计数——传统的 `last_run_at` 近似法无法区分"触发了一次"和"触发了 10 次"，*而且根本看不到一次失败后紧跟一次成功的情况*。日志失败计数和窗口告警活动会喂给健康判定（`attention` 原因），因此 cron 的 Slack 摘要会就那些传统计数器悄悄漏掉的事情发出告警。

**示例输出（slack 格式）：**

```
🟡 *Tradekit digest* · 24h · attention
_2026-05-29 12:00 UTC → 2026-05-30 12:00 UTC_

*Reasons:*
• error rate 15.4% > 10% threshold
• 3 safety blocks during window
• 2 orders failed during window

*Trades:* 47 (43✓ 4✗) · $12.4k volume · 91% success
*Top strategies:* `playbook:1`×24 `manual-dca`×12 `arb-bot`×5

*Strategy fires:* 7 filled · 2 cancelled · 5 schedules fired

*Safety:* 3 budget blocks · 1 honeypot block

*Errors:* 4/26 (15.4%) `SLIPPAGE_TOO_HIGH`×3 `RPC_FAILED`×1
```

**判定等级：**
- 🟢 **healthy** — 没有令人担忧的信号
- 🟡 **attention** — 错误率 > 10%、预算使用率 > 80%、触发了安全拦截，或有任何订单失败
- 🔴 **critical** — 回撤熔断器跳闸（窗口内或当前），或错误率 > 25%

`--strict` 在 critical 时以代码 2 退出（操作者把它接入 PagerDuty / cron-mailer 来告警）。

**对比模式**（`--compare`）为紧邻的、等长的前一个窗口计算同样的摘要，并显示差值：

```
COMPARISON vs prior 24h:
  Trades:        47 (+8)
  USD volume:    $12.4k (+$3.2k)
  Orders filled: 7 (-2)
  Audit errors:  4 (+1)
```

**性能。** 约 6 次有索引的数据库查询，受 `since=window_start` 限定。在一个有数百万审计行的典型安装上仍是亚 100ms。

**窗口范围。** 1 分钟到 90 天。超过 90d 后，审计日志 + 交易表会大到让"高频错误 + 近期触发"信号退化；想要长窗口的操作者应拆分成更短的窗口。

### 健康检查

`tradekit doctor` 快速过一遍：Node 版本、数据目录 / 数据库可写、配置 schema、钱包存在性、活跃链的所有已知 RPC、两个免费聚合器（KyberSwap + OpenOcean），以及 DexScreener 价格 API。任何检查严重失败则以 1 退出；`--strict` 把 warn 也提升为以 1 退出（适合 CI）。`--summary` 打印单行摘要，适合 cron / Slack 主题。

```
🟢 OK   tradekit health check  (tradekit 1.1.1)

  ✓  node                   22.16.0
  ✓  data_dir               /Users/.../tradekit
  ✓  config                 valid (0 chain override(s), active=base)
  ✓  wallet                 single-key keystore → 0x76e8…67a8
  ✓  sqlite                 ~/.tradekit/tradekit.db (trades=3, audit=73)
  !  rpc:base               3/4 reachable (down: base.llamarpc.com)
  ✓  agg:kyberswap          reachable in 550ms
  ✓  agg:openocean          reachable in 1505ms
  ✓  price (DexScreener)    reachable

8 ok · 1 warn · 0 fail
```

在 `--summary` 模式下，同样的检查渲染为一行，适合管道送进告警系统：

```
🟡 WARN  tradekit doctor · 8 ok · 1 warn · 0 fail · top: rpc:base · 2026-05-30T...
```

### 全局标志

| 标志         | 默认 | 效果                                                                 |
|--------------|---------|------------------------------------------------------------------------|
| `--verbose`  | off     | 把 DEBUG+INFO 日志镜像到 stderr（调试时方便）。                |
| `--quiet`    | off     | 适合 cron 的降噪。在 `health` / `doctor` / `verify` 上，过滤输出只保留非 ok 行，让 tail 观察 cron 日志时只看到值得读的信号。在没有 `--json` 时，也会静默 stderr。 |
| `--json`     | off     | 在适用处输出机器可读的 JSON（`holdings`、`quote`、`pnl` 等）。与 `--watch` 结合时，输出紧凑的 JSONL，每个 tick 一行（可被 `jq -c`、Vector、Fluent Bit 消费）。 |
| `--strict`   | off     | 在可处置的坏状态下以 1 退出。每个命令的 strict 触发条件匹配其领域——doctor（warnings）、trades sync（chunk errors）、health（critical nextActions）、pnl（stale data）、gas/price/holdings/portfolio（per-chain failures）、preflight（no_go）、token check（honeypot/suspicious）。在 cron 管道中用退出码来给下游步骤设门。 |
| `--watch [N]`| off     | 每 N 秒重跑一个只读命令（默认 5；最小 1，最大 3600）。在两次 tick 之间清屏；`--json` 模式改为输出 JSONL 流。支持 `health`、`doctor`、`reconcile`、`pending`、`sync`、`holdings`、`pnl`、`gas`、`price`。 |
| `--summary`  | off     | 单行、适合 cron/Slack 的摘要，取代多行文本视图。可用于 `health`、`doctor`、`verify`、`reconcile`、`trades sync`、`pending`。字段折叠模式：健康状态简短；退化状态随错误出现自然增长字段。JSON 输出不变。 |
| `--chain X`  | active  | 针对链 X 运行命令，而不改变活跃链。     |
| `--pass P`   | env     | 钱包密码（也可用 `WALLET_PASS` 环境变量）。仅真实的 trade/transfer/approve/revoke + 钱包管理需要；`quote`、任何 `--simulate` 运行以及只读检查命令无需密码即可运行。 |

### MCP 服务器

```bash
tradekit mcp --pass <password>
```

启动一个 MCP stdio 服务器，暴露分布在六个分组中的 112 个工具：

- **数据 / 检查**（18）— `chains`、`gas`、`price`、`check_price`、`holdings`、`portfolio`、`portfolio_snapshot`、`portfolio_history`、`portfolio_diff`、`trending`、`pnl`、`viewTx`、`health`、`token_info`、`aggregator_stats`、`pair_stats`、`slippage_suggest`、`strategies_list`
- **交易与自动化**（30）— `quote`、`buy`、`sell`、`transfer`、`import_trade`、`preview_trade`、`preflight_trade`、`sweep_balances`、`order_create`、`order_list`、`order_show`、`order_cancel`、`order_edit`、`order_run`、`schedule_create`、`schedule_list`、`schedule_show`、`schedule_pause`、`schedule_resume`、`schedule_cancel`、`schedule_edit`、`schedule_run`、`rebalance_create`、`rebalance_list`、`rebalance_show`、`rebalance_edit`、`rebalance_pause`、`rebalance_resume`、`rebalance_cancel`、`rebalance_run`
- **安全**（8）— `allowances`、`audit_allowances`、`approve`、`revoke`、`revoke_all`、`check_token`、`safety_drawdown`、`safety_reset_drawdown`
- **管理 / 诊断**（26）— `status`、`accounts`、`audit`、`reconcile`、`recent_trades`、`config`、`config_preflight`、`doctor`、`verify`、`sync_trades`、`list_sync_bookmarks`、`address`、`analyze_trade`、`diagnose_pending`、`speedup_tx`、`cancel_tx`、`notify_list`、`notify_test`、`engine_run`、`engine_status`、`engine_lock`、`engine_unlock`、`bulk_halt`、`bulk_resume`、`db_stats`、`db_integrity_check`
- **策略与回测**（13）— `playbook_validate`、`playbook_deploy`、`playbook_list`、`playbook_show`、`playbook_diff`、`playbook_replace`、`playbook_promote`、`playbook_destroy`、`backtest_order`、`backtest_playbook`、`backtest_rebalance`、`backtest_compare`、`strategy_report`
- **可观测性**（13）— `status_dashboard`、`digest_summary`、`order_replay`、`schedule_replay`、`rebalance_replay`、`backtest_list`、`backtest_show`、`backtest_compare_list`、`backtest_compare_show`、`timeline_query`、`engine_events`、`alert_history`、`price_stats`
- **模拟盘交易**（5）— `paper_balances`、`paper_trades`、`paper_pnl`、`paper_deposit`、`paper_reset` —— 管理那个供 `paper: true` 的订单/计划/playbook 交易的虚拟账本（注入资金、查看仓位 + 成交、已实现盈亏(PnL)、重置），让 Agent 能模拟运行整个策略而不动用真实资金。

每个写工具都接受 `simulate: true`。错误是结构化的（见下文 *Agent 集成*）。每个监控/诊断工具都暴露一个顶层 `severity` 字段（'ok' | 'warn' | 'critical' / 'fail'）和一个 `recommendedActions[]` 数组，携带结构化的 `NextAction[]` 调度提示——Agent 在 `severity` 上分支以获取一目了然的状态，并遍历 `recommendedActions` 来自动修复，无需解析散文。

MCP 客户端配置（例如 Claude Desktop）：

```json
{
  "mcpServers": {
    "tradekit": {
      "command": "npx",
      "args": ["-y", "tradekit", "mcp"],
      "env": { "WALLET_PASS": "your-password" }
    }
  }
}
```

### Web 模式

```bash
tradekit web --port 3030 --pass <password>
```

服务器打印一个一次性 URL，内嵌每会话的认证 token；打开它会进入一个单页 React UI：

- **概览** — 钱包状态 + 快捷信息
- **持仓** — 多链余额及其 USD 价值
- **交易** — 从浏览器执行或模拟，附带按规模分数的安全提示
- **自动化** — 引擎的态势视图：存活性 + 锁 + 每个 worker 的健康度、当前正在触发的告警、带决策日志钻取的订单/计划/再平衡表格（再平衡行把漂移渲染为朝阈值推进的进度条）、已部署的 playbook、模拟账本，以及一个按需的资金续航卡片（按花费 token 的判定，少于 7 天显示红色）；15s 自动刷新，结构上即只读
- **时间线** — 浏览器中的取证事件流：每个子系统在一个按时间顺序的视图里（交易、决策日志含 v32 重试 + v33 恢复、告警 fire/resolve/熔断器跳闸、引擎生命周期），带窗口 / 严重度 / 类型分组 / 策略过滤器、可展开的逐事件细节、日期分隔线、30s 自动刷新
- **策略** — 按标签的深度剖析：身份 + 生命周期组成、窗口表现（成交 / 成功率 / 净计价 / 滑点百分位）、净仓位、风险（预算消耗条 + 回撤）、前瞻信号（下次触发、待触发条件、再平衡漂移条）、近期活动。与 CLI 使用同一个 `buildStrategyReport` 内核——数字在结构上一致；刻意不联网（实时计价估值留在 CLI，那里才是 oracle 成本被主动选用的地方）
- **图表** — 由 OKX 公开 K 线驱动的 TradingView Lightweight Charts
- **交易 / PnL / 审计** — 由 SQLite 支撑的历史表格
- **授权** — 逐行 revoke 和批量 **Revoke ALL**
- **配置** — 带服务端 Zod 校验的 JSON 配置编辑

#### 只读自动化 API

Web 服务器还把自动化引擎的可观测性内核暴露为 token 认证的、**只读** JSON 路由——专为壁挂式仪表盘和外部监控而建，且由 CLI/MCP 所用的同一批内核辅助函数消费（数字在结构上跨各界面一致）。没有钱包、没有 keystore 密钥库、没有 RPC、没有写操作——一个泄露的仪表盘 token 无法借此发起交易：

| 路由 | 返回 |
|---|---|
| `GET /api/engine` | 引擎状态文件 + 锁状态（`running`、每个 worker 的 tick、锁原因） |
| `GET /api/dashboard[?sections=…]` | 完整的 10 章节状态仪表盘（与 `tradekit status` / MCP `status_dashboard` 同一个 `gatherStatusReport` 内核） |
| `GET /api/orders[?status&chain&account&strategy&limit]` | 条件订单；`/api/orders/:id` 追加决策日志尾部 |
| `GET /api/schedules[…]`, `/api/schedules/:id` | DCA 计划 + v29 日志尾部（触发、失败、退役、钩子） |
| `GET /api/rebalance[…]`, `/api/rebalance/:id` | 再平衡方案 + 漂移历史日志——仪表盘的"距离触发还有多远？"序列 |
| `GET /api/playbooks`, `/api/playbooks/:id` | 部署 + spec + 每一个被拥有的原语 |
| `GET /api/paper[?account&chain]` | 虚拟余额 + 已实现盈亏(PnL)（同一个 `summarizePaperPnl` 内核） |
| `GET /api/timeline[?since&until&kinds&strategy&minSeverity&limit]` | 统一的取证事件流（`ALL_EVENT_KINDS` 中的每一种——CLI、MCP 和 web 白名单现在共享一个注册表） |
| `GET /api/runway[?days&chain&account&strategy]` | 资金续航预测（按需——真实分桶读取链上余额） |
| `GET /api/strategies` | 策略标签：交易历史 ∪ 活跃原语（含零成交 playbook，活跃优先排序） |
| `GET /api/alerts[?tag&limit]` | 活跃告警状态 + v28 转换历史 |
| `GET /api/strategy-report/:tag[?window&mode]` | 完整的多章节策略报告（离线构建——无实时价格；MTM 留在 CLI/MCP，那里才是显式选用之处） |

#### 架构

服务器是 **Express 5**；前端是 **React 18 + Mantine 7**，用 **Vite** 打包。认证是每会话的随机 token，可通过 `Authorization: Bearer`、`tk_token` cookie 或 `?token=` 查询参数传入（cookie 在引导用的 `GET /?token=…` 时设置）。`/api/*` 下的所有端点使用一个结构化错误中间件，输出 `{ok:false, error:{code,message}}`。BigInt 值通过 Express 层面的 `json replacer` 序列化。SPA 路由回退到 `index.html`。在 SIGINT/SIGTERM 时优雅关闭，干净地关闭 SQLite WAL。

Web UI 源码位于 `webui/`。重新构建打包：

```bash
pnpm build       # 构建服务器（tsc）+ React 打包（vite）
pnpm build:webui # 仅 React 打包
```

要进行带热重载的 UI 开发，把服务器和 Vite dev 并排运行：

```bash
WALLET_PASS=... tradekit web                 # 一个终端
pnpm -C webui dev                            # 另一个；打开 http://localhost:5173
```
Vite dev 服务器把 `/api` 代理到正在运行的 tradekit web（默认端口 3030）。

## 密码解析

对于需要解密钱包的命令：

1. `--pass <password>`
2. `WALLET_PASS` 环境变量
3. 交互式提示（仅 CLI——在 MCP / web 中永不可用）

## 支持的链

| Chain    | ID    | Native | Aggregators       |
|----------|-------|--------|-------------------|
| ethereum | 1     | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| base     | 8453  | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| arbitrum | 42161 | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| optimism | 10    | ETH    | KyberSwap, OpenOcean, 0x*, 1inch* |
| bnb      | 56    | BNB    | KyberSwap, OpenOcean, 0x*, 1inch* |
| polygon  | 137   | POL    | KyberSwap, OpenOcean, 0x*, 1inch* |

`*` 需要在配置中提供 API key（`aggregator.apiKeys.0x` / `.1inch`）。

### 自定义链

通过写入配置中的 `chains.<name>` 来添加不在内置列表里的链。下面是添加 Zora（L3）的示例：

```bash
tradekit config push chains.zora '{
  "chainId": 7777777,
  "rpcs": ["https://rpc.zora.energy"],
  "explorer": "https://explorer.zora.energy",
  "nativeSymbol": "ETH",
  "weth": "0x4200000000000000000000000000000000000006",
  "usdc": "0xCccCCccc7021b32EBb4e8C08314bD62F7c653EC4"
}'
```

之后：`tradekit chains` 会把 zora 和内置链一起显示；`tradekit holdings --chains zora` 会查询它；当 KyberSwap / OpenOcean 支持时，交易会经由该链的 profile 路由。iter211/iter340 确保自定义链能流入 `--chains all`、`doctor --chains all` 以及交易对解析器。

## 安全护栏

所有检查都位于配置的 `safety` 之下。默认值：

```jsonc
{
  "safety": {
    "enabled": true,
    "maxSlippageBps": 500,         // 滑点硬上限（5%）
    "perTxUsdLimit": null,         // 未设置 → 不限
    "dailyUsdLimit": null,         // 未设置 → 不限
    "maxApprovalUsdLimit": null,   // 未设置 → 不限制单次授权的 USD 价值
    "allowInfiniteApprovals": false, // 授予 maxUint256 需要 --force-infinite（CLI）/ override=true（MCP）
    "tokenWhitelist": null,        // { "base": ["0x..."] }
    "tokenBlacklist": null,
    "contractWhitelist": null,     // 限制 swap 目标合约（以及授权 spender）
    "gas": {                       // gas 预算护栏（iter620）。需主动开启；默认关闭。
      "maxGasPctOfTrade": 10,     //   当 (estimatedGasUsd / inputUsd × 100) > N 时失败。拦截主网上"$5 的 swap 花 30% gas"这类自伤。
      "maxGasNativePerChain": {    //   每条链的原生币绝对上限。
        "ethereum": 0.01,          //   主网上任何单笔交易永不支付超过 0.01 ETH
        "base": 0.001
      }
    },
    "minTradeIntervalMs": null,    // 每账户限速（iter633）。设为 60000 → 每账户每分钟最多 1 笔交易。
                                    // 拦截在每日 USD 上限内刷大量小额交易的失控机器人循环。
    "positionLimits": [             // 投资组合感知的上限。每条限制某 token 在组合中的权重占比。
      { "chain": "base", "token": "ETH",  "maxPctOfPortfolio": 70 },     // base 上不要漂移超过 70% ETH
      { "chain": "base", "token": "USDC", "minPctOfPortfolio": 10 },     // 始终保留 ≥ 10% USDC 储备
      { "chain": "*",    "token": "WBTC", "maxPctOfPortfolio": 30 }      // 全组合范围内 30% WBTC 上限
    ],
    "positionLimitsFailOnUnpriced": false, // 预言机宕机时软跳过（默认）；设为 true 则失败时关闭
    "autoTokenCheck": {                    // 交易前自动貔貅(honeypot)探测（默认关闭）
      "enabled": true,
      "cacheTtlMs": 86400000,             // 判定结果缓存 24h
      "failOnSuspicious": true,            // 可疑（高税）时拦截；false = 仅警告
      "probeUsd": 5,                       // 往返探测的规模
      "skipWhitelisted": true              // safety.tokenWhitelist 中的 token 跳过探测
    },
    "strategyBudgets": [                  // 每策略 USD 花费上限（iter19；默认关闭）
      { "tag": "playbook:*", "lifetimeUsd": 5000, "dailyUsd": 500 },
      { "tag": "arb-experiment", "perFireUsd": 50, "dailyUsd": 200 },
      { "tag": "manual-dca", "lifetimeUsd": 10000 }
    ],
    "drawdownCircuitBreaker": {           // 状态感知的本金亏损熔断器（iter20；默认关闭）
      "enabled": true,
      "maxDrawdownPct": 15,               // 投资组合较峰值下跌 15% 时跳闸
      "autoResumeAtPct": null,             // null = 仅手动重置；否则在回撤 < N% 时自动清除
      "scope": "global"                    // v1 跨所有账户 + 链汇总投资组合 USD
    }
  }
}
```

**仓位上限**捕捉每笔交易 USD 限额看不到的投资组合构成漂移——一个做许多笔小额"预算内"交易的 Agent，仍可能把投资组合任意集中。交易前，引擎获取当前投资组合，应用预测的交易变动量，并对预测的构成检查每一条匹配的限额。`chain: "*"` 通配符跨链求和（对"任意位置最多 30% WBTC"很有用）。当下限在交易前**已经**被突破时，下限类限额会抑制——否则一个已漂移的储备会让后续所有交易死锁。当交易或投资组合无法计价时软跳过并给出警告；可通过 `positionLimitsFailOnUnpriced: true` 选择硬失败。当 `positionLimits` 为空 / 未定义时整体跳过 → 不用此特性的安装零开销。

**自动貔貅(honeypot)探测**捕捉那类"买入正常、卖出回退"的 token，这是滑点/USD 限额在症状上盲视的。在每笔交易触发前（`--simulate` 时跳过，因为模拟运行不动资金），引擎用与 `tradekit token check` 相同的买+卖往返模拟，探测输入**和**输出 token。貔貅(honeypot)判定总是以 `TOKEN_BLOCKED` 拦截；可疑判定（往返净损失 ≥20%——高税 token）在 `failOnSuspicious=true` 时拦截，否则仅警告。判定按 (chain, token) 缓存在 v15 的 `token_safety_cache` 表中，时长为 `cacheTtlMs`（默认 24h），因此窗口内对同一 token 的交易零探测开销。智能短路——native、链规范的 USDC/WETH/WBTC，以及操作者的 `safety.tokenWhitelist` 整体跳过探测。未知判定（流动性不足的 token、聚合器宕机）**失败时开放(fail-open)**为警告，这样一次基础设施抖动不会级联成全局性的 tradekit 故障。

**策略预算**把 USD 花费上限限定到某个具体的 `strategy` 标签——与全局每笔交易和每日 USD 上限正交。一个运行多个 playbook 的操作者现在可以说"这个 playbook 终生最多花 $5000"、"这个实验每天最多花 $200"、"这条 DCA 腿每次触发永不超过 $50"——**独立于**全局上限。每条规则三个上限窗口，任意组合：
- `lifetimeUsd`：跨所有时间的 success+pending 交易累计
- `dailyUsd`：滚动 24h
- `perFireUsd`：每笔交易上限（比全局 `maxUsdPerTx` 更严，限定到一个标签）

标签匹配支持精确字符串（`arb-bot`）**和**后缀通配符（`playbook:*` 匹配任意 playbook id——与 iter12 的 playbook 自动打标签组合）。多条匹配规则 → **全部**必须通过。没有策略标签的交易整体跳过检查。预算超出会抛出 `STRATEGY_BUDGET_EXCEEDED`，附带结构化细节（tag、window、capUsd、spentUsd、predictedUsd）和指向 `tradekit strategies --budget` 的 `nextActions[]` 供查看。

预算聚合器（`usdSpentUnderStrategy`）从现有的 `trades` 表读取——按策略跟踪没有新 schema。v18 的 `(strategy, timestamp)` 复合索引让 SUM 查询在多年历史上仍然廉价。检查在聚合器报价**之后**（我们需要预测 USD）但任何状态变更调用**之前**触发——超出的预算永不烧 gas。

实时消耗通过 `tradekit strategies --budget` 显示：

```
2 strategy budgets configured:

  Tag pattern:  playbook:*
  Matches:      playbook:1, playbook:7
  Lifetime:     $1247.50 / $5000.00 (25%)  →  remaining $3752.50
  24h rolling:  $145.00 / $500.00 (29%)    →  remaining $355.00

  Tag pattern:  arb-experiment
  Lifetime:     $250.00 / $1000.00 (25%)   →  remaining $750.00
  Per-fire:     cap $50.00
```

**回撤熔断器**是首个**状态感知**的安全原语。上面每一道护栏都是**前瞻性**的——它针对一条规则评估每笔交易，然后批准或拒绝。它们都不对实际已实现的资本损失作出反应。一个触发太晚的追踪止损 + 一个买入下跌趋势的 DCA + 一个在波动市场中频繁换手的再平衡，全都可能在"符合规格"的同时流血亏钱。回撤熔断器填补这个空白：它跟踪操作者投资组合随时间的峰值 USD 价值，当当前价值跌破 `peak × (1 - maxDrawdownPct/100)` 时，拒绝新交易，直到手动重置。

交易时逻辑：
1. 在聚合器报价后，跨操作者的 owner 地址（多链）获取实时投资组合 USD。配置了仓位上限时复用；否则独立获取。
2. 从 v19 的 `drawdown_state` 表查找熔断器的先前状态（peak、tripped 标志）。
3. 新高 → 棘轮抬高 peak，放行。
4. 在区间内（回撤低于阈值）→ 放行 + 更新 last value。
5. 越过阈值 → 跳闸 + 持久化 `tripped_at` + 抛出 `DRAWDOWN_CIRCUIT_BREAKER_TRIPPED`。
6. 已跳闸 + 配置了 `autoResumeAtPct` + 已恢复越过 resume 阈值 → 清除 tripped 标志，放行。
7. 已跳闸 + 仍在跳闸区 → 抛出。

**数据缺失时失败开放**：一个无法计价的投资组合（oracle 宕机、所有 token 退市）软跳过检查，而不是触发熔断器——与现有每笔交易 USD 限额的姿态相同。状态跨引擎重启持久化；每个 scope 一行。

查看 + 手动重置：

```bash
tradekit safety drawdown                          # current peak, last value, drawdown %, tripped state
tradekit safety reset-drawdown                    # clear tripped + re-anchor peak to last value
tradekit safety reset-drawdown --peak 5000        # clear tripped + re-anchor peak to specific value
```

`--simulate` 时跳过（模拟运行不改变轨迹）。当 `drawdownCircuitBreaker.enabled=false`（默认）时整体跳过。Auto-resume 默认为 null——这是更安全的默认值，因为操作者在恢复前应当调查熔断器**为何**跳闸，而部分恢复后的意外自动恢复可能重新启用一个亏损策略。

触发的护栏会抛出结构化错误：`SLIPPAGE_TOO_HIGH`、`TOKEN_BLOCKED`、`CONTRACT_BLOCKED`、`AMOUNT_EXCEEDS_LIMIT`、`GAS_BUDGET_EXCEEDED`、`POSITION_LIMIT_EXCEEDED`、`STRATEGY_BUDGET_EXCEEDED`、`DRAWDOWN_CIRCUIT_BREAKER_TRIPPED`、`SAFEGUARD_TRIGGERED`。`POSITION_LIMIT_EXCEEDED` 的细节会指明确切的 token、当前 %、预测 %、目标区间——操作者得到一次性的修复方案（调整交易规模，或先对越界仓位再平衡）。来自自动貔貅(honeypot)路径的 `TOKEN_BLOCKED` 在细节中携带 `autoTokenCheck: true` + 指向 `tradekit token check` 的 `nextActions[]` 供手动确认。`STRATEGY_BUDGET_EXCEEDED` 的细节会指明匹配的规则 + 跳闸的窗口，因此收到该错误的 Agent 可以处置：调整交易规模、等待 24h 窗口滚动，或上报给操作者。`DRAWDOWN_CIRCUIT_BREAKER_TRIPPED` 的细节会指明 scope、peak、当前 USD、回撤 % 和 tripped_at 时间戳，并指引 Agent 在清除前去 `tradekit health` 调查。

逐交易绕过——当操作者需要为某一笔特定交易覆盖某道护栏时：`--force-gas`（CLI）/ `forceGas: true`（MCP）用于 gas 预算；`--force-infinite` 用于无限授权。绕过会落入 `audit_log` 并置上 override 标志，因此事后复盘能追溯每一笔由绕过驱动的交易。

防御性默认：破坏性 MCP 操作（例如 `audit { action: "prune" }`）默认为模拟运行(dry-run)；Agent 必须显式传 `dryRun: false` 才真正删除。转账收款人和 approve/revoke 的 spender 上强制执行 EIP-55 校验和验证，以在资金移动前捕捉单字符粘贴错误。

## Agent 集成

### 幂等键 (v45) — 重试而不会重复交易

引擎自身的触发自 v33 起就有重放保护（崩溃窗口防护）。但 **Agent 路径完全没有**：一个 MCP `buy`，其传输在 *tx 已发送之后* 超时，会被任何理智的 Agent 循环重试——而那次重试就是一笔重复交易，是面向 Agent 的交易工具所能有的最糟糕的失败模式。

每个真实（非 simulate）的 `buy`/`sell` 都应携带一个 `idempotencyKey`（8–128 个 `[A-Za-z0-9_-]` 字符——为每笔*逻辑*交易生成一个 UUID，重试时复用它）：

- **重试，相同请求** → 已记录的结果原样重放，带 `replayed: true`。什么都不会重新执行——记录在案的*失败*也会重放（"修好了，重试"是一笔新的逻辑交易 → 新键）。
- **相同键，不同请求**（参数指纹是规范化的——键顺序无关，`undefined` ≡ 缺失）→ `IDEMPOTENCY_CONFLICT` (409)。
- **键仍在执行中** → `REQUEST_IN_FLIGHT` (409)。永远不要假设原请求已死：tx 可能仍在 mempool 中。先检查 `recent_trades`；过期的行（>10 分钟）会在 `details.stale` 里说明，并且仍然保持围栏。在确认没有东西被发送后，`tradekit trade release-key <key>` 解除围栏——终态的键永不可释放（释放一个*已完成*的键会重新武装一笔已完成的交易）。
- 执行中途发生的**非 ToolError 崩溃**会刻意把键留在 in-flight：结果未知，而这恰恰是重试必须被围栏之时。

CLI 等价：`tradekit buy/sell --idempotency-key K`。键通过 `db.retention.idempotencyKeysDays` 过期（重放保护是一个运维窗口，不是一份归档）。

### 交易审批门 (v47) — Agent 提议，人类决定

静态安全上限回答的是"Agent *永远* 可以做什么"；它们无法表达**"$500 以下 Agent 自主交易，超过这个数我想先看看。"** `safety.tradeApproval { enabled, thresholdUsd, expiresMinutes }` 就是这个中间地带：

- 一个达到/超过 `thresholdUsd`（`null` = 每一笔 Agent 交易）的 MCP `buy`/`sell` **不会被执行**。该请求经由一次完整的 `simulate` 过程定价（整个安全栈 + 实时报价——正是审核者需要的），落地为一个**待处理意图(pending intent)**，Agent 得到一个 `pending_approval` *成功*结果（不是错误——Agent 循环不应盲目重试），附带意图 id 和一条不要重新提交的说明。审批门**失败时关闭(fail closed)**：无法定价的交易也会被拦。一条通知会向操作者告警。与幂等键组合：一次传输重试会重放*同一个*意图，而不是再提交重复的。
- 操作者用 `tradekit intents show <id>`（请求 + 预览 + Agent 的 `approvalReason`）审核并决定。**`approve` 会在钱包密码背后重新执行，并内建漂移保护**——预览的收到金额作为 `expectedAmountOut` 重放（默认 100bps 容差），因此一份一小时前的报价无法在已变动的市场里悄悄成交。结果（`executed`/`failed` 带结果，`rejected` 带说明）会记录在意图上；待处理意图在 `expiresMinutes`（默认 60）后**过期**。
- **批准/拒绝按设计仅限 CLI**——与 backup/panic 相同的安全边界：一个被提示注入的 Agent 绝不能批准它自己的花费。Agent 得到只读的 `intents_list` 来轮询决定。CLI 交易路径本身不设门：它已经位于钱包密码之后，即人类。
- **队列在操作者本就会看的每一处都可见 (v47.5)**：**digest** 统计提议/决定，并在有任何待处理（带最旧的年龄）或未审核即过期时把判定推到 `attention`；**`tradekit doctor`** 在队列开放（"Agent 在你决定之前一直被阻塞"）和近期未审核的过期（"审批请求正在被错过"）时告警；**时间线**加入 `intent.created`（等待期间为 warn）和 `intent.decided` 事件——过期会在截止时刻合成一个 decided 事件，因此"未审核即 EXPIRED"会出现在取证流和事故报告中；**web 概览**显示一个待处理横幅，轮询只读的 `GET /api/intents`。一个没人看见的审批队列就是一个被悄悄阻塞的 Agent——可见性是这个特性的一部分。

### 错误结构

每个 MCP 工具要么返回一个 JSON 成功体，要么在失败时返回一个 `ToolError`：

```jsonc
{
  "ok": false,
  "error": {
    "code": "NEEDS_APPROVAL",            // 稳定、可被机器读取
    "message": "Approval is required before the swap can be executed.",
    "details": { "token": "0x...", "spender": "0x..." }
  },
  "next_actions": [
    {
      "tool": "approve",
      "params": { "token": "0x...", "spender": "0x...", "amount": "1000000" },
      "reason": "Approval is required before the swap can be executed."
    }
  ]
}
```

稳定的错误码：

```
INVALID_PARAMS UNKNOWN_CHAIN UNKNOWN_TOKEN UNKNOWN_ACCOUNT UNKNOWN_RECIPIENT
WALLET_LOCKED WALLET_NOT_FOUND WALLET_EXISTS WRONG_PASSWORD
RPC_FAILED RPC_RATE_LIMITED TX_NOT_FOUND TX_TIMEOUT TX_REVERTED
INSUFFICIENT_LIQUIDITY QUOTE_FAILED AGGREGATOR_FAILED QUOTE_DEVIATION_EXCEEDED
INSUFFICIENT_BALANCE NEEDS_APPROVAL SLIPPAGE_EXCEEDED SLIPPAGE_TOO_HIGH
SIMULATION_FAILED TRANSFER_FAILED
SAFEGUARD_TRIGGERED TOKEN_BLOCKED CONTRACT_BLOCKED
AMOUNT_EXCEEDS_LIMIT GAS_BUDGET_EXCEEDED POSITION_LIMIT_EXCEEDED
STRATEGY_BUDGET_EXCEEDED DRAWDOWN_CIRCUIT_BREAKER_TRIPPED
API_ERROR INTERNAL_ERROR
```

### MCP 工具目录 (iter26)

通过 `tradekit mcp` 服务器暴露的工具，按领域分组：

**钱包 + 账户操作：** `status` `accounts` `audit` `address` `reconcile` `recent_trades` `config` `doctor` `verify` `speedup_tx` `cancel_tx` `sync_trades` `list_sync_bookmarks` `analyze_trade` `diagnose_pending`

**数据 / 检查：** `chains` `gas` `price` `check_price` `holdings` `portfolio` `portfolio_snapshot` `portfolio_history` `portfolio_diff` `health` `token_info` `aggregator_stats` `pair_stats` `slippage_suggest` `strategies_list` `trending` `pnl` `viewTx`

**交易执行：** `quote` `buy` `sell` `import_trade` `transfer` `preview_trade` `preflight_trade` `sweep_balances`

**条件订单 + 计划 + 引擎 + 再平衡：** `order_create` `order_list` `order_show` `order_cancel` `order_run` `schedule_create` `schedule_list` `schedule_show` `schedule_pause` `schedule_resume` `schedule_cancel` `schedule_run` `engine_run` `engine_status` `rebalance_create` `rebalance_list` `rebalance_show` `rebalance_pause` `rebalance_resume` `rebalance_cancel` `rebalance_run`

**安全 / 授权：** `allowances` `audit_allowances` `approve` `revoke` `revoke_all` `check_token`

**通知：** `notify_list` `notify_test`

**模拟盘交易（虚拟账本）：** `paper_balances` `paper_trades` `paper_pnl` `paper_deposit` `paper_reset`
- 管理那个供 `paper: true` 的订单/计划/playbook 触发的合成账本——经由 MCP 的完整模拟运行(dry-run)循环，无真实资金，无 CLI 回退
- `paper_deposit` 注入/调整一个虚拟余额（模式 `credit` 增加，模式 `set` 覆盖；decimals 来自交易流所用的同一个链上 getToken 查找）
- `paper_pnl` 是按策略的、以计价币种计量的盈亏(PnL)，经由 CLI 所用的同一批内核（数字跨各界面一致）；默认输出仅已实现且确定性，`mtm: true` 加上按当前 oracle 价格标记的成本基础仓位（已实现 / 未实现 / 合计 / 逐仓位细节）
- `paper_reset` 是破坏性的（清除某 scope 的余额 + 成交日志）且需要 `confirm: true`；同时省略 `account` 和 `chain` 会清除整个账本

**Iter26 — 策略生命周期（playbook + 回测）：**
- **Playbook 管理：** `playbook_validate` `playbook_deploy` `playbook_list` `playbook_show` `playbook_diff` `playbook_replace` `playbook_promote` `playbook_destroy`
  - 全都直接接受结构化 JSON spec（不需要文件路径）
  - 模板支持：传 `vars: { NAME: value }` 在校验前渲染 `{{NAME}}` 占位符
  - `playbook_deploy` 是原子的（部署中途失败会回滚）、在 spec hash 上幂等，并接受 `paper: true` 以把整个策略部署到虚拟账本——经由 MCP 的完整模拟运行(dry-run)循环（部署 paper → 观察 `paper_trades` → 读 `paper_pnl mtm:true` → 用 `playbook_replace` 迭代 → 重新部署真实）
  - `playbook_diff` 是只读预览：四个桶（未变/已改/新增/移除）、字段级变更，以及逐条目的 `applyMode`（原地编辑 vs 取消+重建），让 Agent 在应用**之前**就知道某个变更是否保留追踪 HWM / 运行计数器
  - `playbook_replace` 以 v2 状态保留语义原子地应用一份新 spec（尽可能原地编辑、重建时运行计数器结转、paper 属性从被拥有的行继承）；`preserve_state: false` 选择完全状态重置；需要 `yes: true`
  - `playbook_destroy` 需要 `yes: true`，并把取消级联到所有被拥有的原语
- **回测：** `backtest_order` `backtest_playbook` `backtest_rebalance` `backtest_compare` `backtest_list` `backtest_show` `backtest_compare_list` `backtest_compare_show`
  - 单策略 + 多策略 + 多场景对比
  - 全都持久化结果；`backtest_show` / `backtest_compare_show` 无需重新拉取 CoinGecko 即可重新渲染

**Iter26 — 运维可观测性：**
- `status_dashboard` — 引擎 + 订单 + 计划 + 再平衡 + playbook + 回撤 + 预算 + 24h 审计仪表盘，带可选的章节过滤器
- `digest_summary` — 窗口化的活动摘要，带 3 级健康判定 + 可选的对比前一窗口
- `order_replay` — 一个订单的取证决策时间线（需要 `engine.orderJournal.enabled=true`）

**Iter26 — 安全栈检查：**
- `safety_drawdown` — 每个 scope 的回撤熔断器状态（peak / current / 回撤 % / tripped 标志）
- `safety_reset_drawdown` — 清除 tripped 标志 + 可选地重新锚定 peak（需要 `yes: true`）

每个工具在成功时返回 `ok: true`，失败时返回 `isError: true` 并带一个结构化的 `ToolError` 结构。`code` 字段稳定可用于分支；`details` 携带具体操作的上下文；`next_actions[]`（存在时）把 Agent 指向下一个要调用的工具。

### 成功结构

**每个** MCP 成功响应都包含 `ok: true`（iter889 自动信封）。做实质工作的工具（RPC 往返、外部 API 调用、多行计算、写操作）还包含 **`elapsedMs`** 以跟踪墙钟延迟——iter908-918 覆盖了每个这样的工具：

```jsonc
{
  "ok": true,
  "elapsedMs": 234,                       // 出现在 RPC/API/计算类工具上（廉价读取没有）
  /* … tool-specific fields … */
}
```

廉价读取工具（`chains`、`accounts list`、`strategies_list`、`address list`）省略 `elapsedMs`——其工作是常数时间 + 亚毫秒级。读取 `response.elapsedMs ?? 0` 来做延迟直方图的 Agent 在两类工具上都能统一工作。

**监控 / 诊断工具**（`health`、`doctor`、`verify`、`reconcile`、`sync_trades`、`pnl`、`portfolio`、`token_info`、`aggregator_stats`、`pair_stats`、`audit_allowances`、`audit summary`、`diagnose_pending`）还额外包含 `severity` + `recommendedActions[]` 以供结构化的 Agent 调度：

```jsonc
{
  "ok": true,
  "timestamp": "2026-05-30T11:24:33Z",
  "elapsedMs": 1234,
  "severity": "warn",                     // 'ok' | 'warn' | 'critical' | 'fail'（取决于工具）
  "recommendedActions": [                 // 结构化的 NextAction[] — 当 severity='ok' 时为空
    {
      "tool": "sync_trades",
      "params": { "chain": "arbitrum", "account": "main" },
      "reason": "Bookmark for arbitrum/main hasn't advanced in 3.1d — PnL may be missing recent trades."
    },
    {
      "tool": "diagnose_pending",
      "params": { "chain": "base" },
      "reason": "1 trade still pending after reconcile — diagnose stuck txs."
    }
  ],
  /* … tool-specific fields … */
}
```

**在 `severity` 上分支以获取一目了然的状态：**

```ts
const report = await mcp.call("health");
if (report.severity === "critical") page_oncall(report);
else if (report.severity !== "ok") log_warning(report);
```

**遍历 `recommendedActions[]` 来自动修复**，无需解析散文：

```ts
for (const action of report.recommendedActions) {
  await mcp.call(action.tool, action.params);   // tool + params 已可直接调度
}
```

每个 `recommendedActions[].tool` 都保证是一个已注册的 MCP 工具（通过 iter589 不变量测试强制保证）。

### 预聚合摘要字段

返回列表的工具（`holdings`、`audit list`、`accounts`、`recent_trades`、`diagnose_pending`）包含一个顶层 `summary` 对象，预先计算最有用的聚合，让 Agent 不必遍历数组：

```jsonc
{
  "ok": true,
  "summary": { "total": 47, "errors": 3, "byStatus": { "pending": 2, "success": 45 } },
  "items": [ /* … 47 entries … */ ]
}
```

### 安装状态检查

对于想要验证"本主机上配置好 tradekit 了吗？"而不依赖文本输出的 CI / 脚本，`tradekit --json`（不带位置命令）返回一个状态对象：

```jsonc
// 已配置（钱包存在）：
{ "ok": true,  "version": "1.1.1", "node": "22.16.0", "platform": "darwin",
  "arch": "arm64", "wallet": "0xabc...", "account": "main",
  "activeChain": "base", "needsInit": false }

// 未配置（无钱包）：
{ "ok": false, "version": "1.1.1", "node": "22.16.0", "platform": "darwin",
  "arch": "arm64", "wallet": null, "account": null,
  "activeChain": "base", "needsInit": true,
  "hint": "Run `tradekit init` for a guided setup." }
```

在 `.ok` 上分支以检测已配置状态，或用 `.needsInit` 获取明确的"此安装需要设置"信号。Cron / Docker entrypoint：

```bash
if tradekit --json | jq -e .ok > /dev/null; then
  tradekit health --summary --strict
else
  echo "tradekit not configured on $(hostname)" >&2; exit 1
fi
```

### 单位

每个工具描述里都记录了单位：
- `slippageBps` 是基点（50 = 0.5%）
- 金额是十进制字符串（"1.5" = 1.5 ETH，不是 wei）
- 地址带 0x 前缀
- USD 值是数值（不是字符串）
- 时间戳是 ISO 8601 UTC 字符串
- 经过的时间以毫秒为单位（`elapsedMs`）
- 区块高度和大整数是字符串化的 BigInt（JSON 安全）

## 数据存储

```
~/.tradekit/
├─ config.json       # 配置（CLI / web / MCP 共享）
├─ wallet.json       # 加密的单私钥 keystore（web3-eth-accounts 格式）
├─ mnemonic.json     # 加密的 BIP-39 助记词 keystore（scrypt + AES-256-GCM）
├─ accounts.json     # HD 账户标签 → 派生索引
├─ tradekit.db       # SQLite —— 见下方表格
└─ server.log        # 轮转的文本日志（在 TRADEKIT_LOG_ROTATE_BYTES 处轮转，默认 5MB）
```

SQLite 表（通过 `db.ts` 中编号的迁移管理）：

| 表                  | 用途                                                                |
|------------------------|------------------------------------------------------------------------|
| `trades`               | 每一笔执行/导入的 swap——base/quote、金额、价格、滑点、gas、状态、tx hash、策略标签 |
| `audit_log`            | 每一次 MCP/CLI/web 调用——caller、params、result、错误码、tx hash；可经 `audit prune` 修剪 |
| `portfolio_snapshots`  | 时点投资组合捕获，供 `portfolio_diff` 历史序列使用 (iter618) |
| `sync_bookmarks`       | 每个 (chain, account, owner) 的恢复状态，供增量 `trades sync` 使用 (iter737) |
| `orders`               | 条件 / 限价订单——引擎在价格触发时执行的常驻意图；携带成交审计轨迹（filled_at、fill_tx_hash、fill_price） |
| `schedules`            | 周期 / DCA 计划——cron 驱动的常驻意图；携带 `next_run_at` 游标 + 运行遥测（`run_count`、`total_base_filled`、`total_quote_spent`） |
| `rebalance_plans`      | 投资组合目标权重方案——声明式 `{token, targetPct}[]` spec + cron 节奏 + 漂移阈值；当漂移超过阈值时引擎发起纠正交易 |
| `token_safety_cache`   | 交易前自动貔貅(honeypot)判定，按 (chain, token_address) 作键——买+卖往返探测结果及 TTL。避免每笔交易都重新探测 |
| `backtest_runs`        | 持久化的历史策略模拟结果。每一行 = 一次 `backtest order`/`backtest schedule`/`backtest playbook` 调用，附其 spec、余额、触发时间线、PnL 和 `vs hold` 反事实 |
| `backtest_comparisons` | 多场景回测摘要 (iter22)。每一行把 N 个 `backtest_runs` 行归在一个对比名下，附每场景统计 + winner 索引 |
| `playbooks`            | 声明式多原语策略捆绑包。通过每个上面的 `strategy = playbook:<id>` 标签拥有子订单/计划/再平衡方案。原子部署，中途失败回滚；拆除经由与手动 CLI 相同的取消路径级联 |
| `drawdown_state`       | 回撤熔断器状态。每个 scope 单行，跟踪投资组合峰值 USD + tripped 标志，供 iter20 的资本损失熔断器使用 |
| `order_check_log`      | Iter25 订单决策日志。对每个活跃订单的引擎评估按状态变更采样的行——驱动 `tradekit order replay <id>` |
| `engine_lock`          | Iter28 全局急停开关。单行状态 (id=1)，被每条触发路径检查；跨引擎重启持久化 |
| `schema_version`       | 迁移游标；永不手动改动                               |

文件权限：目录 `0o700`，密钥文件（`wallet.json`、`mnemonic.json`）`0o600`。数据库和审计日志在静态时不加密——如果主机是共享的，请使用全盘加密。

### 备份/恢复

```bash
tradekit backup export <file> [--include-db] [--force] [--pass <pw>]
# config.json + wallet.json + mnemonic.json + accounts.json 的加密包。
# 传 --include-db 还会包含 tradekit.db（通常为 MB 级；仅当
# 交易/审计历史不可替代时使用）。该包用钱包密码
# 加密 —— 没有独立的加密密钥。

tradekit backup restore <file> [--force] [--pass <pw>]
# 解密 + 恢复到数据目录。不带 --force 时拒绝覆盖
# 已有文件（在 TTY 上会交互式提示输入 'restore' 确认）。

tradekit verify backup <file> [--pass <pw>]
# 非破坏性的完整性检查：解密 + 解析 + 校验 schema，
# 不写入任何东西。在依赖某个备份做灾难恢复之前，
# 用它在另一台主机上验证备份的完整性。
```

备份契约**刻意仅限 CLI**——从不暴露为 MCP 工具。恢复是破坏性的（覆盖操作者的钱包）；把它挡在 Agent 界面之外是一道安全边界。

## 测试

两个测试层：

**单元测试**（Vitest）— 55 个测试文件，约 1370 个测试，覆盖：

- **纯逻辑单元**：`safety.enforceSafety`、`decodeTx.classify`、`gas.verdictForChain`、`chains.resolveToken`、`config.setConfigPath` / `parseConfigValue`、`errors.toToolError`
- **报告组合器**：`pnl`、`portfolio`、`health`、`reconcile`、`aggregatorStats`、`pairStats`、`approvalAudit`、`tokenInfo`、`activitySync`
- **数据库层**：schema 迁移、查询正确性、sync bookmarks、审计日志过滤器、投资组合快照
- **CLI 辅助**：argv 解析、watch 模式 JSONL 流、标志拼写错误警告（距离-1 Levenshtein）、日期过滤器
- **不变量**（回归守护）：每个 `nextAction.tool` 引用一个已注册的 MCP 工具 (iter589)、每个 `server.tool(NAME)` 都在 `MCP_TOOLS` 中声明 (iter877)、每个 `case "X":` 顶层命令都在拼写检测列表中 (iter878)

```bash
pnpm test           # 单次运行
pnpm test:watch     # watch 模式
```

测试使用 Vitest，SQLite 测试用 `pool: "forks"`（每个 worker 得到自己的数据库），破坏性操作冒烟测试用 `TRADEKIT_DATA_DIR` 覆盖。

**冒烟测试**（bash）— 针对实时测试钱包运行已构建二进制的集成套件（只读 + 一笔模拟交易——从不发送真实 tx）：

```bash
pnpm build
WALLET_PASS=<your-password> bash scripts/smoke.sh
```

两者都设计为可安全地反复运行。冒烟脚本会自清理它插入的任何行，使重跑可复现。

## 许可证

MIT

