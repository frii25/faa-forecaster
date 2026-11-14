// faa-forecaster — Polymarket FAA outage attribution forecast (Node 22, stdlib only).
//
// Design (from the research plan; constants locked, not re-tuned):
//   Per market, let x be its last price (price at the checkpoint) and let the
//   1-minute moves be the consecutive differences of its price history.
//   Sigma is jump-robust and multi-window: for each window W in {60, 360, 1440}
//   minutes, take the last W moves, sort their absolute values, drop the
//   largest 5%, and take the root-mean-square of the rest. Sigma is the MEAN
//   of the three window values.
//   Median is x (persistence — no drift, no mean reversion).
//   For minute h = 1..240 after the checkpoint:
//     inner half-width: sigma * sqrt(h), times 0.85 for the 25%/75% quantiles;
//     outer half-width: sqrt((sigma * sqrt(h))^2 + 0.005^2) for the 5%/95%
//     quantiles (a constant jump allowance added in quadrature).
//     rows: [x - 1.644854*outer, x - 0.67449*inner, x,
//            x + 0.67449*inner, x + 1.644854*outer],
//     each clamped to [0,1] and rounded to 6 decimals.
//
// Reads every <id>.in in the input directory, writes <id>.out to the output
// directory: {"forecasts":[{"id","q"}]}, q = 240 rows of 5 quantiles.
// Deterministic: no clock, no randomness, no network — only the case file.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level, to 6 decimals. */
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];
/** Trailing windows (minutes) whose trimmed RMS vols are averaged. */
const WINDOWS = [60, 360, 1440];
/** Fraction of largest |moves| dropped in each window (jump robustness). */
const TRIM = 0.05;
/** Inner (25%/75%) quantile shrink factor. */
const INNER_SHRINK = 0.85;
/** Outer (5%/95%) jump allowance, added in quadrature. */
const JUMP = 0.005;

interface CaseMarket {
  id: string;
  prices: number[];
}

interface Case {
  horizon_minutes: number;
  quantiles: number[];
  markets: CaseMarket[];
}

/** x clamped to [0,1] and rounded to 6 decimals (0, never -0). */
const price6 = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6 + 0;

/**
 * Trimmed RMS of the last `window` moves: sort the absolute moves and keep
 * the smallest 95% of them (dropping the largest 5%), then root-mean-square.
 * Short histories use whatever moves exist; with no moves the vol is 0.
 */
function trimmedRms(moves: number[], window: number): number {
  const tail = moves.slice(-window);
  if (tail.length === 0) return 0;
  const abs = tail.map((m) => Math.abs(m)).sort((a, b) => a - b);
  // Keep the smallest 95% by count (int truncation, as in the plan's
  // "drop the largest 5%"): for n moves this keeps floor(0.95 * n).
  const kept = abs.slice(0, Math.max(1, Math.floor(abs.length * (1 - TRIM))));
  let sumSq = 0;
  for (const v of kept) sumSq += v * v;
  return Math.sqrt(sumSq / kept.length);
}

/** Per-market sigma: the mean of the three windows' trimmed RMS vols. */
function sigmaOf(prices: number[]): number {
  const moves: number[] = [];
  for (let i = 1; i < prices.length; i++) moves.push(prices[i] - prices[i - 1]);
  let total = 0;
  for (const w of WINDOWS) total += trimmedRms(moves, w);
  return total / WINDOWS.length;
}

/** The forecast of one market: horizon rows of the five quantiles around its last price. */
function forecast(m: CaseMarket, horizon: number): number[][] {
  if (m.prices.length === 0) throw new Error(`market ${m.id} has no prices`);
  const x = m.prices[m.prices.length - 1] as number;
  const sigma = sigmaOf(m.prices);
  const rows: number[][] = [];
  for (let h = 1; h <= horizon; h++) {
    const base = sigma * Math.sqrt(h);
    const inner = base * INNER_SHRINK;
    const outer = Math.sqrt(base * base + JUMP * JUMP);
    rows.push([
      price6(x + Z[0] * outer),
      price6(x + Z[1] * inner),
      price6(x),
      price6(x + Z[3] * inner),
      price6(x + Z[4] * outer),
    ]);
  }
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
  if (c.quantiles.length !== QUANTILES.length || c.quantiles.some((t, j) => t !== QUANTILES[j])) throw new Error(`${file} asks for quantiles ${JSON.stringify(c.quantiles)}, not ${JSON.stringify(QUANTILES)}`);
  const forecasts = c.markets.map((m) => ({ id: m.id, q: forecast(m, c.horizon_minutes) }));
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ forecasts })}\n`);
}
