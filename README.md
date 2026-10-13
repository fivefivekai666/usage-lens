# usage-lens · Claude Code 用量透视

A Claude Code plugin that opens a pane inside Claude Code showing **which sessions ate your 5-hour window** (or any time range), as a percentage, and inside each session **how much went to the main agent vs. subagents, on which models and subagent types**. UI is in Chinese.

一个 Claude Code 插件：在 Claude Code 里打开一个面板，看 **5 小时窗口（或任意时段）里各个 session 的用量占比**，点开某个 session 再看 **主 agent 和子 agent 各用了多少、什么模型、什么类型的子 agent**。

## 能看到什么

- **官方 5h / 7 天额度的真实百分比**：读的是 Claude Code 从 API 响应里拿到的限额读数，不是估算。「5h窗口」时段按「重置时间 − 5 小时」到现在算，和官方窗口对齐。
- **会话占比**：时段内每个 session 占总用量的百分比，按 API 等价成本或按 token 数排序。在 5h 窗口下每个 session 还标出「≈ N 点」：它大约吃掉了 5h 额度的几个百分点。
- **点开一个 session**：
  - 主 agent：按模型列出成本、请求数、输入 / 输出 / 缓存写 / 缓存读
  - 子 agent：按模型汇总、按类型汇总（如 `general-purpose ×134`），以及用量最高的子 agent（带任务描述、模型、嵌套层级）
- **时间线**：按 session 堆叠的柱状图，悬停看每一格的数值（桌面端；终端里不画图）。
- **时段**：5h窗口、7天窗口、1小时、5小时、24小时、今天、7天、30天，或自定义：`10:00-14:00`、`23:00-01:00`（跨夜）、`3h`、`10-11`（某一天）、`2026-10-11 08:00 ~ 2026-10-11 20:00`。
- 非 Claude 模型（通过代理接入的其他模型）单独列出，不计成本、不算进 5h 额度。

## 和已有工具的区别

[ccusage](https://github.com/ryoppippi/ccusage)、[agentburn](https://github.com/Socialpranker/agentburn)、[claude-code-usage-tracker](https://github.com/codeinaire/claude-code-usage-tracker) 等都是独立的 CLI 或网页面板。usage-lens 直接跑在 Claude Code 里（桌面端和终端都能开），并且专门回答一个问题：**这个 5h 窗口里，哪个 session 用了百分之多少，它的子 agent 又用了多少、用的什么模型**。

## 安装

需要：

- Claude Code **2.1.295 或更新**（插件用的是 function hooks API，目前是 early access）
- Node.js 18+（`node` 在 PATH 上；用 nvm / Homebrew 装的也行，插件会通过登录 shell 找）

在终端版 `claude` 里执行一次：

```
/plugin install usage-lens --marketplace <owner>/usage-lens
```

先答 `y` 添加 marketplace，再选安装范围（建议 user）。装好后桌面端的会话也能用。

## 使用

```
/usage-lens                 # 打开面板，默认看当前 5h 窗口
/usage-lens 24h             # 指定时段：5h窗口 7d窗口 1h 5h 24h today 7d 30d
/usage-lens 10:00-14:00     # 自定义时段
```

面板打开时每 60 秒自动刷新。面板放不下时（比如终端太窄），命令会改为在对话里输出一张汇总表。

## 原理

- `bin/scan.mjs` 读取本机 `~/.claude/projects/**/*.jsonl`，包括子 agent 的转录 `<session>/subagents/agent-*.jsonl` 和对应的 `.meta.json`（子 agent 类型、描述、嵌套层级）。
- 同一个 API 响应会被写成多行（每个内容块一行），所以按 message id 去重。
- 增量解析：每个转录文件读到的位置和提取出的记录缓存在 `~/.claude/usage-lens/cache-v3.json`，之后的刷新只读新追加的部分，通常只要 0.1 秒左右。
- 所有数据都只在本机处理，不会上传到任何地方。

### 成本与「点」

- 成本按 API 等价价格计算，作为权重使用。价格表在 `bin/scan.mjs` 里。要覆盖或补充，写 `~/.claude/usage-lens/pricing.json`：

  ```json
  { "claude-opus-5-5": { "in": 4, "out": 20, "cr": 0.2, "fast": 2 } }
  ```

  单位是美元 / 百万 token。缓存写默认按输入价的 1.25 倍（5 分钟）和 2 倍（1 小时）计。
- 「点」= session 成本 ÷（窗口内本机总成本 ÷ 5h 已用百分比）。

### 局限

- 只统计本机的转录。其他设备、claude.ai 网页版的用量也算在官方 5h 百分比里，但不在这里，所以「点」会偏高。
- Anthropic 没有公开订阅额度具体怎么按模型计权，用 API 价格当权重只是近似。
- 用 API key 登录的话没有 5h / 7 天额度，「5h窗口」会退回到最近 5 小时。

## 开发

```
claude plugin validate .
claude plugin test .
```

## License

MIT
