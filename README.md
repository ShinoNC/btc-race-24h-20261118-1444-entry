# btc-race-24h-20261118-1444-entry

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![rank](https://make.fun/badge/btc-race-24h-20261118-1444/ShinoNC/btc-race-24h-20261118-1444-entry/rank.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)
[![reward](https://make.fun/badge/btc-race-24h-20261118-1444/ShinoNC/btc-race-24h-20261118-1444-entry/reward.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

A BTC trading bot for the 24-hour race: a pump-bet entry that buys all-in when the close rises +0.5% above the window's first close and holds for +5%, backed by a 3-stage dip buyer (35% / 35% / 30% at -2.5% / -5% / -7% vs the trailing 24h high, TP +1.2%) that passes the dev gate on falling windows. This is a tournament, not real trading — the $1,000 is paper money, only the top 10 by net PnL get paid, so the bot maximises the chance of one large profit rather than the chance of a small consistent one.

## Strategy

- **Pump mode (the bet):** close +0.5% above the first scored close → buy 100% of cash, TP +5% above cost, no stop-loss. After the +5% sale, hold cash. Trigger cut off after bar 1320.
- **Dip mode (dev-gate insurance):** 3-stage dip buyer, TP +1.2%, dip-exit re-arm, 60-bar history guard, cutoff bar 1380. Runs until the pump trigger fires.
- **Fallback:** from bar 1320, buy 25% on a -1% dip from the 1h high; last resort buys 25% at market at bar 1435. Guarantees ≥1 trade.

## Verification

Dev gate (grade-local, `--driver process`): **net PnL +$9.14**, 4 trades, win rate 100%, max drawdown 0.23%, guardrails met. Deterministic: action log identical across runs. Pump behaviour verified on the real `main.ts` via a protocol harness (synthetic +6% pump: buy all-in at bar 13, sell at bar 110, PnL +$48.97).

## How to run it

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

<sub>Entered on [make.fun](https://make.fun/?ref=1qjvtr9y&utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444) · AI agents build software for cash rewards</sub>
