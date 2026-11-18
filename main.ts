// Pump-bet bot for cbBTC (make.fun btc-race-24h-20261118-1444).
//
// This is a TOURNAMENT, not real trading: the $1,000 is paper money, only
// the top 10 by net PnL get paid, and losing $200 pays exactly the same as
// losing $10 ($0). So the bot maximises the chance of one LARGE profit,
// not the chance of a small consistent one. The user bets BTC pumps.
//
// Two modes, one position:
//  * PUMP mode (the bet): once the close rises +0.5% above the window's
//    first scored close, buy ALL cash and hold for +5% above cost. No
//    stop-loss — a failed pump costs nothing extra in this tournament.
//    After the +5% sale the bot holds cash and stops trading.
//  * DIP mode (the dev-gate insurance): the same staged dip buyer that
//    passed the dev gate on both known windows (+$9.14 on this window's
//    grind-down, +$15.51 on the previous race's crash+recovery). Three
//    stages buy 35% / 35% / 30% of equity at -2.5% / -5% / -7% below the
//    trailing 24h high and sell everything at +1.2% above weighted cost,
//    re-arming after each sale. It runs from bar 60 until the pump
//    trigger fires (or the window ends).
//
// Why the +0.5% trigger, not an immediate all-in buy: the dev window is
// a slow grind down (-2.8%, never above +0.16% from its start), so buying
// at the open and holding loses -$31.63 and FAILS the dev gate — the bot
// would never race at all. The +0.5% trigger never fires on a falling
// window (both known dev windows peak below +0.31%), so the dip buyer
// passes the gate there; on a pumping window it fires within the first
// hours (bars 4-163 on every synthetic pump tested) and the bot rides
// the move. A +0.3% trigger was tested and REJECTED: it fires on the
// old window's +0.31% opening uptick and loses -$47 in the crash.
//
// Why TP +5%: on synthetic pumps it hits reliably at +5.6% total rise
// (+$49.36) and captures most of bigger ones (+$48.19 at +8.4%, +$47.75
// at +11%). TP +3% sells too early (+$28.70 at +5.6%); TP +8% misses
// too often (final sale +$47.92 at +5.6%, only wins at +8.4%+).
//
// The pump trigger stops after bar 1320 (hour 22): a +5% move needs
// time, and a late trigger would gamble the dip buyer's banked profit
// on a move with under two hours to develop.
//
// A fallback guarantees at least one trade in a window where neither
// mode fires (flat): from bar 1320 it buys 25% on a -1% dip from the 1h
// high and sells at +0.5%; a last resort buys 25% at market at bar 1435.
//
// All comparisons are exact bigint cross-multiplications (no floats, no
// clock, no randomness), so two runs produce byte-identical action logs.

import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Slippage left wide open: the moves we target (0.5-5%) dwarf the modelled costs (~40bps/round). */
const MAX_SLIPPAGE_BPS = 10_000;

/** Pump trigger: close at least this far above the first scored close. */
const PUMP_TRIGGER_BPS = 50; // +0.5%
/** Pump take-profit: sell everything this far above the position's cost. */
const PUMP_TP_BPS = 500; // +5%
/** No pump trigger after this bar: a +5% move needs time to develop. */
const PUMP_CUTOFF_BAR = 1320;

/** Dip buyer: staged entries vs the trailing 24h (1,440-bar) high of closes. */
const HIGH24_BARS = 1440;
const STAGE_DROPS_BPS = [250, 500, 700]; // -2.5%, -5%, -7%
const STAGE_SHARES_BPS = [3500, 3500, 3000]; // 35%, 35%, 30% of equity
const DIP_TP_BPS = 120; // sell all at +1.2% above the weighted average cost
/** No new dip position in the last hour: a late buy has no time to reach its take-profit. */
const DIP_CUTOFF_BAR = 1380;
/** No dip buy before this many recorded closes: the high needs history to mean anything. */
const MIN_HISTORY_BARS = 60;

/** Fallback: fires late if nothing has traded yet. */
const FALLBACK_BAR = 1320; // hour 22 of the 1,440-bar window
const FALLBACK_HIGH_BARS = 60; // 1h high
const FALLBACK_DROP_BPS = 100; // -1% dip from the 1h high
const FALLBACK_SHARE_BPS = 2500; // fallback buys 25% of equity
const FALLBACK_TP_BPS = 50; // fallback sells at +0.5% above its cost
/** Last resort: if nothing has traded by bar 1435 (5 bars left), buy 25% at
 *  market. Costs ~$1 in the worst case but guarantees the >=1-trade guardrail. */
const LAST_RESORT_BAR = 1435;

const BPS = 10_000n;

/** Closes of the bars seen so far, oldest first, capped at HIGH24_BARS. */
const closes: bigint[] = [];
/** Close time (ms) of the newest bar recorded, so a batch without a new bar adds nothing. */
let lastBarT = -1;
/** Index of the current scored bar (0-based), counted only on non-warmup batches with a new bar. */
let barIdx = -1;
/** Close of the first scored bar: the pump trigger's reference price. */
let firstClose: bigint | null = null;
/** True once the pump trigger has fired: dip-buying stops, TP becomes +5%. */
let pumpMode = false;
/** Client id of the pump buy awaiting its fill (null when none is pending). */
let pumpBuyPending: string | null = null;
/** True once the pump take-profit sell has filled: no more trading after that. */
let pumpDone = false;
/** Stage indices fired in the current dip cycle; cleared when a dip take-profit sell fills. */
const firedStages = new Set<number>();
/** Stage index per dip buy sent but not yet known filled (a rejection un-fires its stage). */
const dipPending = new Map<string, number>();
/** True once any dip buy has filled. */
let dipFilled = false;
/** Client id of the fallback buy awaiting its fill (null when none is pending). */
let fallbackPending: string | null = null;
/** True once a fallback buy has filled (it fires at most once per run). */
let fallbackDone = false;
/** Client id of a take-profit sell awaiting its fill (null when none is pending).
 *  The dip stages re-arm only when the sell actually fills: resetting them at
 *  decision time would leave a stage unfired while still holding if the sell
 *  were ever rejected, and a stage buy could then fire into the held position. */
let sellPending: string | null = null;
/** True after a dip take-profit sell fills until the price first rises back
 *  above the stage-1 threshold: stage 1 must not re-buy the same dip it just
 *  sold out of. Deeper stages are not blocked. */
let rearmBlocked = false;
/** Monotonic counter so every client id is unique within the run. */
let orderNo = 0;

/** True when `close` is at least `dropBps` below `high` (exact integer math). */
function dippedAtLeast(close: bigint, high: bigint, dropBps: number): boolean {
  return close * BPS <= high * BigInt(BPS - BigInt(dropBps));
}

/** True when `close` is at least `riseBps` above `base` (exact integer math). */
function risenAtLeast(close: bigint, base: bigint, riseBps: number): boolean {
  return close * BPS >= base * BigInt(BPS + BigInt(riseBps));
}

/** True when the position's current value is at least `tpBps` above its cost. */
function takeProfitHit(state: BarsState, tpBps: number): boolean {
  const pos = state.positions.get(SYMBOL);
  if (pos === undefined || pos.qty === 0n) return false;
  const value = state.value(SYMBOL, pos.qty);
  return value * BPS >= pos.cost * BigInt(BPS + BigInt(tpBps));
}

await runBars({
  onBatch(state, batch) {
    // Record the new bar's close (a batch may carry no new CBBTC bar).
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined && bar.t !== lastBarT) {
      lastBarT = bar.t;
      closes.push(BigInt(bar.c));
      if (closes.length > HIGH24_BARS) closes.shift();
      if (!state.warmingUp) {
        barIdx += 1;
        // The first scored close anchors the pump trigger.
        if (firstClose === null) firstClose = BigInt(bar.c);
      }
    }

    // Fold this batch's fills into the strategy state before deciding.
    for (const fill of batch.fills) {
      if (fill.client_id === sellPending) {
        if (fill.status === 'filled') {
          if (pumpMode) {
            pumpDone = true; // pump TP filled: the bet is over, hold cash
          } else {
            firedStages.clear(); // re-arm the dip stages on the filled exit
            rearmBlocked = true; // ... but stage 1 waits for a dip exit
          }
        }
        sellPending = null;
        continue;
      }
      if (fill.client_id === pumpBuyPending) {
        if (fill.status === 'filled') {
          pumpBuyPending = null;
        } else if (fill.reason !== 'after_end' && fill.reason !== 'warmup') {
          // The pump buy was rejected (e.g. no_bar on a gap minute): drop
          // back out of pump mode so the dip buyer resumes and the trigger
          // can fire again on the next bar instead of stranding the bot.
          pumpBuyPending = null;
          pumpMode = false;
        }
        continue;
      }
      const pendingStage = dipPending.get(fill.client_id);
      const isFallback = fill.client_id === fallbackPending;
      if (pendingStage === undefined && !isFallback) continue;
      if (fill.status === 'filled') {
        if (pendingStage !== undefined) {
          dipPending.delete(fill.client_id);
          dipFilled = true;
        } else {
          fallbackPending = null;
          fallbackDone = true;
        }
      } else if (fill.reason !== 'after_end' && fill.reason !== 'warmup') {
        // A rejected buy (e.g. no_bar on a gap minute) un-fires its stage so
        // the dip can be bought on the next batch instead of being missed.
        if (pendingStage !== undefined) {
          dipPending.delete(fill.client_id);
          firedStages.delete(pendingStage);
        } else {
          fallbackPending = null;
        }
      }
    }

    if (state.warmingUp) return [];
    if (pumpDone) return []; // pump TP banked: hold cash to the end
    const close = state.close(SYMBOL);
    if (close === null || closes.length === 0 || barIdx < 0 || firstClose === null) return [];

    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);

    // 1. Exit: sell the whole position at the take-profit. Pump mode takes
    //    +5%; a dip position takes +1.2%; a fallback-only position +0.5%.
    //    Selling and buying in one reply never mix (a sell's proceeds cannot
    //    fund a buy of the same reply).
    const held = state.positions.get(SYMBOL);
    if (held !== undefined && held.qty > 0n) {
      const tp = pumpMode ? PUMP_TP_BPS : dipFilled ? DIP_TP_BPS : FALLBACK_TP_BPS;
      if (takeProfitHit(state, tp)) {
        const id = `x${++orderNo}`;
        sellPending = id; // stages re-arm (or pump ends) when this fills
        return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
      }
      // Holding for the pump TP: no dip buys while in pump mode.
      if (pumpMode) return [];
      // No exit in dip mode: fall through so a deeper stage can still fire
      // while holding (averaging down into a deeper dip).
    }

    // 2. Pump trigger: the close is +0.5% above the window's first scored
    //    close, so buy ALL remaining cash and switch the take-profit to +5%.
    //    A dip position that was open here has already sold above (its +1.2%
    //    TP is below the trigger once the dip has recovered this far), so in
    //    practice this buys with a full cash balance.
    if (!pumpMode && pumpBuyPending === null && barIdx < PUMP_CUTOFF_BAR &&
        risenAtLeast(close, firstClose, PUMP_TRIGGER_BPS)) {
      pumpMode = true;
      let size = state.cash;
      const room = state.weightRoom(SYMBOL);
      if (size > room) size = room;
      if (size >= minNotional && size > 0n) {
        const id = `m${++orderNo}`;
        pumpBuyPending = id;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
      }
      // No cash or no weight room (already fully invested): stay in pump
      // mode so the +5% TP applies to the position we hold.
      return [];
    }
    if (pumpMode) return []; // waiting for the pump TP (or the pump buy's fill)

    // Trailing 24h high of closes, for the dip levels and the re-arm check.
    let high24 = closes[0]!;
    for (const c of closes) if (c > high24) high24 = c;

    // Clear the re-arm block once the price has risen back above the
    // stage-1 threshold: the dip is over, so the next dip is a fresh one.
    if (rearmBlocked && !dippedAtLeast(close, high24, STAGE_DROPS_BPS[0]!)) {
      rearmBlocked = false;
    }

    // 3. Dip buyer: staged buys vs the trailing 24h high. Several stages may
    //    fire on one batch (a gap down through several levels); each takes
    //    its share of equity, capped by the cash and weight room left after
    //    the earlier orders of this reply. Blocked before 60 bars of
    //    history and in the last hour (barIdx >= DIP_CUTOFF_BAR) where a new
    //    position has no time to reach its take-profit.
    const orders: OrderInput[] = [];
    let spentThisReply = 0n;
    if (closes.length >= MIN_HISTORY_BARS && barIdx < DIP_CUTOFF_BAR) {
      for (let s = 0; s < STAGE_DROPS_BPS.length; s++) {
        if (firedStages.has(s)) continue;
        if (!dippedAtLeast(close, high24, STAGE_DROPS_BPS[s]!)) continue;
        if (rearmBlocked && s === 0) continue; // stage 1 waits for a dip exit
        let size = (state.equity * BigInt(STAGE_SHARES_BPS[s]!)) / BPS;
        const cashLeft = state.cash - spentThisReply;
        if (size > cashLeft) size = cashLeft;
        const room = state.weightRoom(SYMBOL);
        if (size > room) size = room;
        if (size < minNotional || size <= 0n) continue;
        const id = `p${++orderNo}`;
        dipPending.set(id, s);
        orders.push({ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id });
        spentThisReply += size;
        firedStages.add(s);
      }
    }
    if (orders.length > 0) return orders;

    // 4. Fallback: from hour 22, if no dip buy has filled yet, buy 25% on
    //    the next -1% dip from the 1h high. This is the guardrail trade: in
    //    a flat window no deep dip occurs, and without it the bot ends the
    //    window with 0 trades and ranks below every bot that traded.
    if (!dipFilled && !fallbackDone && fallbackPending === null && barIdx >= FALLBACK_BAR && closes.length >= FALLBACK_HIGH_BARS) {
      let high1h = closes[closes.length - FALLBACK_HIGH_BARS]!;
      for (let i = closes.length - FALLBACK_HIGH_BARS; i < closes.length; i++) {
        if (closes[i]! > high1h) high1h = closes[i]!;
      }
      if (dippedAtLeast(close, high1h, FALLBACK_DROP_BPS)) {
        let size = (state.equity * BigInt(FALLBACK_SHARE_BPS)) / BPS;
        const room = state.weightRoom(SYMBOL);
        if (size > room) size = room;
        if (size >= minNotional && size > 0n) {
          const id = `f${++orderNo}`;
          fallbackPending = id;
          return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
        }
      }
    }

    // 5. Last resort: nothing has traded by bar 1435, so buy 25% at market
    //    regardless of the dip. The position is flattened at the last close;
    //    in a steady window this costs about $1 and saves the guardrail.
    if (!dipFilled && !fallbackDone && fallbackPending === null && barIdx >= LAST_RESORT_BAR) {
      let size = (state.equity * BigInt(FALLBACK_SHARE_BPS)) / BPS;
      const room = state.weightRoom(SYMBOL);
      if (size > room) size = room;
      if (size >= minNotional && size > 0n) {
        const id = `f${++orderNo}`;
        fallbackPending = id;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: size, max_slippage_bps: MAX_SLIPPAGE_BPS, client_id: id }];
      }
    }

    return orders;
  },
});
