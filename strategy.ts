// Trail-sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: most pump.fun coins die within minutes, so the bot only ever risks a small,
// fixed stake per coin and only on launches that already show real, broad buying.
// The edge is asymmetry, not prediction: losers are cut fast (-12%), winners are
// never capped by a fixed take-profit — a trailing stop lets a runner keep running.
// (Partial banking is a parameter, bankAt; at its default it never triggers, so
// the trailing stop is the only profit exit.) One entry per coin, ever.
//
// Entry (decided from the tape since the coin's CreateEvent):
//   - age between entryAgeMin and entryAgeMax slots after creation
//   - real SOL reserve inside [minRealSol, maxRealSol] (liquid enough to trade,
//     not so large the move already happened)
//   - at least minBuyers distinct non-creator buyers and minTrades trades
//   - net SOL flow (buys minus sells) at least minNetFlowSol
//   - price run-up since creation inside [minRunup, maxRunup] (momentum, not a chase)
//   - no single non-creator buyer owns more than maxTopBuyerShare of the buy SOL
//   - the creator has not sold, and the creator's own buy in the create slot is
//     at most maxCreatorBuySol (a creator-heavy launch is a dump waiting to happen)
//
// Exits (checked first every batch, before any entry):
//   - stop loss: liquidation value below cost * (1 - stopLoss)
//   - partial bank: once value passes cost * (1 + bankAt), sell half the tokens
//     (off at the default bankAt, which no position reaches)
//   - trailing stop: once value passes cost * (1 + trailArm), exit if value falls
//     below peakValue * (1 - trail)
//   - creator sells after we bought: exit at once
//   - stale: held longer than maxHold slots and not up at least holdIfUp
// A curve that completes is closed by the replay itself.
//
// Pace fallback: if the entry filters are too strict for the window (few coins
// after real time has passed), the filters relax in two deterministic tiers so the
// guardrail (20 coins with >= 0.01 SOL round trips) is still met.
//
// Deterministic by construction: no clock, no Math.random, no I/O, iteration only
// over insertion-ordered maps fed by the batch stream. Block time comes from the
// events themselves, never the wall clock.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Slots after creation before a first buy may be decided. */
  entryAgeMin: number;
  /** Slots after creation after which a first buy is too late. */
  entryAgeMax: number;
  /** SOL to risk on one coin (capped by 1% of the real SOL reserve). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Distinct non-creator buyers and total trades seen before entry. */
  minBuyers: number;
  minTrades: number;
  /** Net SOL bought (buys minus sells) since creation, at least this. */
  minNetFlowSol: number;
  /** Price now over the create price, minus 1: entry band. */
  minRunup: number;
  maxRunup: number;
  /** Largest single non-creator buyer's share of buy SOL, at most. */
  maxTopBuyerShare: number;
  /** Creator's own buys in the create slot, at most this many SOL. */
  maxCreatorBuySol: number;
  /** Skip the coin when the creator sold before entry. */
  skipCreatorSold: boolean;
  /** Slippage allowed on buys (bps). Sells always go out at 10000. */
  buySlipBps: number;
  /** Exit when liquidation value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell half the position once value reaches cost * (1 + bankAt). At the default (100) no position reaches it, so the trailing stop is the only profit exit. */
  bankAt: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArm). */
  trailArm: number;
  /** ...then exit when value falls below peak * (1 - trail). */
  trail: number;
  /** Exit after holding this many slots, unless up at least holdIfUp. */
  maxHold: number;
  holdIfUp: number;
  /** Exit at once when the creator sells after we bought. */
  exitOnCreatorSell: boolean;
  /** Slots to ignore a coin after we exit it. */
  cooldown: number;
  /** Add to a winning position this many times at most (0 = off). */
  maxAdds: number;
  /** An add needs the position up at least this much over its cost. */
  addAt: number;
  /** ...and net SOL flow over the last addFlowWindow slots at least this. */
  addFlowWindow: number;
  addMinFlowSol: number;
  /** ...and the price at least this far above the last buy's decision price. */
  addStep: number;
}

export const DEFAULT_PARAMS: Params = {
  entryAgeMin: 2,
  entryAgeMax: 20,
  stakeSol: 0.1,
  minBuySol: 0.01,
  minRealSol: 0.5,
  maxRealSol: 80,
  minBuyers: 6,
  minTrades: 5,
  minNetFlowSol: 0.2,
  minRunup: 0.05,
  maxRunup: 0.8,
  maxTopBuyerShare: 0.6,
  maxCreatorBuySol: 3,
  skipCreatorSold: true,
  buySlipBps: 1000,
  stopLoss: 0.12,
  bankAt: 100,
  trailArm: 0.25,
  trail: 0.25,
  maxHold: 300,
  holdIfUp: 0.5,
  exitOnCreatorSell: true,
  cooldown: 100,
  maxAdds: 0,
  addAt: 0.3,
  addFlowWindow: 30,
  addMinFlowSol: 0.05,
  addStep: 0.05,
};

const LAMPORTS = 1e9;
/** Curve fee taken on each side of a trade (protocol 95bps + creator 30bps). */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
}

interface Tape {
  created: number | null;
  createPrice: number;
  creator: string;
  creatorBuySol: number;
  creatorSold: boolean;
  trades: TapeTrade[];
  entries: number;
  lastExit: number;
  /** Distinct non-creator buyers seen, with their buy SOL. */
  buyers: Map<string, number>;
  buySol: number;
  sellSol: number;
}

interface Held {
  opened: number;
  peakValue: number;
  banked: boolean;
  exiting: boolean;
  filled: boolean;
  adds: number;
  lastAddPrice: number;
  lastValue: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  /** Relaxation tier, 0 = strict, 1 = looser, 2 = loosest. Only moves up. */
  let tier = 0;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = {
        created: null,
        createPrice: 0,
        creator: '',
        creatorBuySol: 0,
        creatorSold: false,
        trades: [],
        entries: 0,
        lastExit: -1e12,
        buyers: new Map(),
        buySol: 0,
        sellSol: 0,
      };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Effective entry thresholds at the current relaxation tier. */
  const eff = () => {
    if (tier === 0) return { ageMax: p.entryAgeMax, minBuyers: p.minBuyers, minTrades: p.minTrades, minFlow: p.minNetFlowSol, maxRunup: p.maxRunup };
    if (tier === 1) return { ageMax: 60, minBuyers: 4, minTrades: 3, minFlow: 0.1, maxRunup: 1.0 };
    return { ageMax: 150, minBuyers: 3, minTrades: 2, minFlow: 0.05, maxRunup: 1.2 };
  };

  /** Liquidation value of `tokens` at virtual reserves (vq, vt), curve + tx fees off. */
  const valueOf = (tokens: number, vq: number, vt: number, tx: number): number =>
    ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const devSold = new Set<Pubkey>();
      const traded = new Set<Pubkey>();

      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.created = e.slot;
          t.creator = e.creator;
          t.createPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user });
          traded.add(e.mint);
          if (e.is_buy) {
            t.buySol += sol;
            if (e.user !== t.creator) {
              t.buyers.set(e.user, (t.buyers.get(e.user) ?? 0) + sol);
            } else if (e.slot === t.created) {
              t.creatorBuySol += sol;
            }
          } else {
            t.sellSol += sol;
            if (e.user === t.creator) {
              t.creatorSold = true;
              devSold.add(e.mint);
            }
          }
        }
      }
      // Relax the entry filters only very late, and only if the window is nearly
      // empty of qualifying coins: an early relaxation admits a flood of weak
      // launches and was the worst failure mode in backtests. (Elapsed time is
      // block time from the events, never the wall clock.)
      if (firstTime !== null && lastTime !== null) {
        const elapsed = lastTime - firstTime;
        if (tier === 0 && elapsed > 10800 && myCoins.size < 8) tier = 1;
        else if (tier === 1 && elapsed > 16200 && myCoins.size < 12) tier = 2;
      }
      // Prune tapes of coins that are old, unheld and long dead, to bound memory.
      if (tapes.size > 4000) {
        for (const [mint, t] of tapes) {
          if (!held.has(mint) && t.created !== null && now - t.created > 5000) tapes.delete(mint);
          if (tapes.size <= 4000) break;
        }
      }

      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
      for (const po of state.pending.values()) {
        const cur = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
        if (po.order.side === 'buy') cur.buy = true;
        else cur.sell = true;
        pendingByMint.set(po.order.mint, cur);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;

      // ---- Exits first. ----
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        const value = valueOf(tokens, vq, vt, tx);
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const pend = pendingByMint.get(mint);
        if (pend?.sell) continue;

        // Partial bank: sell half once the position doubles, exactly once.
        if (!h.banked && !h.exiting && value >= cost * (1 + p.bankAt)) {
          if (orders.length < cap && tokens >= 2) {
            orders.push({ side: 'sell', mint, token_amount: BigInt(Math.floor(tokens / 2)), max_slippage_bps: 10_000 });
            h.banked = true;
          }
          continue;
        }

        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && p.exitOnCreatorSell && devSold.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (orders.length >= cap) break;
        if (value <= tx) continue; // dust: selling costs more than it returns; flatten handles it
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // ---- Entries. ----
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      const th = eff();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const t = tapes.get(mint);
        if (t === undefined || t.created === null) continue;
        const heldPos = held.get(mint);
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const pend = pendingByMint.get(mint);
        if (heldPos !== undefined) {
          // Add to a winner only: up, still flowing in, stepped up from the last buy.
          if (p.maxAdds <= 0 || heldPos.exiting || !heldPos.filled || heldPos.adds >= p.maxAdds) continue;
          if (pend !== undefined) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          const cost = Number(pos.cost_lamports) / LAMPORTS;
          if (heldPos.lastValue < cost * (1 + p.addAt)) continue;
          if (price < heldPos.lastAddPrice * (1 + p.addStep)) continue;
          let flow = 0;
          for (let i = t.trades.length - 1; i >= 0; i--) {
            const tr = t.trades[i]!;
            if (tr.slot <= now - p.addFlowWindow) break;
            flow += tr.buy ? tr.sol : -tr.sol;
          }
          if (flow < p.addMinFlowSol) continue;
          const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
          let amount = Math.min(capSol, p.stakeSol);
          if (amount > free - tx) amount = free - tx;
          if (amount < p.minBuySol) continue;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
          free -= amount + tx;
          heldPos.adds++;
          heldPos.lastAddPrice = price;
          continue;
        }
        if (pendingByMint.has(mint)) continue;
        if (slotsLeft <= 0) break;
        const age = now - t.created;
        if (age < p.entryAgeMin || age > th.ageMax) continue;
        if (t.entries > 0 || now - t.lastExit < p.cooldown) continue;
        if (p.skipCreatorSold && t.creatorSold) continue;
        if (t.creatorBuySol > p.maxCreatorBuySol) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rqSol < p.minRealSol || rqSol > p.maxRealSol) continue;
        if (t.buyers.size < th.minBuyers) continue;
        if (t.trades.length < th.minTrades) continue;
        if (t.buySol - t.sellSol < th.minFlow) continue;
        if (t.createPrice <= 0) continue;
        const runup = price / t.createPrice - 1;
        if (runup < p.minRunup || runup > th.maxRunup) continue;
        let top = 0;
        for (const v of t.buyers.values()) if (v > top) top = v;
        if (t.buySol > 0 && top > p.maxTopBuyerShare * t.buySol) continue;

        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeSol);
        if (amount > free - tx) amount = free - tx;
        if (amount < p.minBuySol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        slotsLeft--;
        held.set(mint, { opened: now, peakValue: 0, banked: false, exiting: false, filled: false, adds: 0, lastAddPrice: price, lastValue: 0 });
        t.entries++;
      }
      return orders;
    },
  };
}
