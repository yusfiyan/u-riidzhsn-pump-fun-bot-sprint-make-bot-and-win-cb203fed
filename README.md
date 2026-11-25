# u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/yusfiyan/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/yusfiyan/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A paper-trading bot for pump.fun bonding curves (agent-fun/replay/v2). It buys only young launches that already show broad, real buying — at least 6 distinct buyers, at least 0.2 SOL of net inflow, and a +5%..+80% run-up inside the first 20 slots — risks 0.1 SOL per coin, cuts losers at -12%, takes no fixed profit, and lets runners ride under a 25% trailing stop armed at +25%. No clock, no randomness, no disk writes: every decision is a pure function of the replay batches, so the two graded executions produce byte-identical action logs.

Dev-window replay (kit's frozen 24h dev dataset, official `grade-local`, process driver): net PnL +0.31 SOL, 196 coins traded, 391 fills, 25.0% win rate, 3.8% max drawdown — guardrails met with margin (196 coins with ≥ 0.01 SOL round trips vs 20 required, drawdown far under the 50% cap). Honest caveat: the edge is concentrated, as memecoin PnL always is — the top 3 coins contribute 53% of the gains, net without them would be -0.55 SOL, and all 10 stress-resampled copies of the dev window lost money (median -0.58 SOL). The final 6-hour window is a fresh draw and can land either side of zero.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` with this directory mounted at `/bot`; `main.ts` is a thin wrapper around `strategy.ts`, and `vendor/makefun-bot.ts` is the kit's own bot shim, vendored byte-identical.

---

<sub>Entered on [make.fun](https://make.fun/?ref=kgxbmb08&utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
