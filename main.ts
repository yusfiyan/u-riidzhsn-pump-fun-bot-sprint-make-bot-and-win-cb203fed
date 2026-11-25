// Pump.fun Bot Sprint entry: trail-sniper (see strategy.ts).
//
// Strategy in one line: buy only young launches with broad, real buying
// (>= 6 distinct buyers, >= 0.2 SOL net inflow, +5%..+80% run-up in the first
// 20 slots), risk 0.1 SOL per coin, cut losers at -12%, take no fixed profit —
// runners ride under a 25% trailing stop armed at +25%. Guardrails: 20+ coins
// with >= 0.01 SOL round trips, and the bot never holds more than 5 positions
// at once.
//
// Run by the grader as `node /bot/main.ts` with this directory mounted at /bot.
// The bot writes nothing to disk: all output goes to the harness over stdout via
// runBot, so it is safe to run in the grader's read-only sandbox.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
