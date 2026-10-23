/**
 * Request/token/cost ceilings and cost estimation for cloud processing.
 * Prices are configuration with a "checked" date; estimates show their
 * assumptions and uncertainty and are never presented as a bill.
 */
import type { Usage } from './types.ts';

export interface PriceEntry {
  model: string;
  inputPerMTokUsd: number;
  outputPerMTokUsd: number;
  checked: string;
  source: string;
  note?: string;
}

/** Standard (paid) tier list prices; output includes thinking tokens. */
export const DEFAULT_PRICES: PriceEntry[] = [
  { model: 'gemini-3.5-flash-lite', inputPerMTokUsd: 0.3, outputPerMTokUsd: 2.5, checked: '2026-10-22', source: 'https://ai.google.dev/gemini-api/docs/pricing' },
  { model: 'gemini-3.8-flash', inputPerMTokUsd: 0.75, outputPerMTokUsd: 3.75, checked: '2026-10-22', source: 'https://ai.google.dev/gemini-api/docs/pricing', note: 'Promotional through 2026-12-31; $1.50/$7.50 from 2027-01-01.' },
];

export function priceFor(model: string, table: readonly PriceEntry[] = DEFAULT_PRICES): PriceEntry | undefined {
  return table.find((p) => p.model === model);
}

export interface Budget {
  maxRequests: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  /** Hard ceiling on estimated spend for one job (USD). 0 = no spend allowed. */
  maxCostUsd: number;
}

export const DEFAULT_BUDGET: Budget = { maxRequests: 200, maxInputTokens: 2_000_000, maxOutputTokens: 400_000, maxCostUsd: 1 };

export interface UsageLedger {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  /** Any usage counted from local estimates instead of provider reports. */
  anyEstimated: boolean;
  startedAt: number;
}

export function emptyLedger(now: number): UsageLedger {
  return { requests: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, anyEstimated: false, startedAt: now };
}

export function costOf(model: string, inputTokens: number, outputTokens: number, table?: readonly PriceEntry[]): number | undefined {
  const p = priceFor(model, table);
  if (!p) return undefined;
  return (inputTokens / 1e6) * p.inputPerMTokUsd + (outputTokens / 1e6) * p.outputPerMTokUsd;
}

export class BudgetExceeded extends Error {
  readonly which: keyof Budget;
  constructor(which: keyof Budget) {
    super(`Budget limit reached: ${which}`);
    this.which = which;
  }
}

/** Throw if one more request of the estimated size would exceed the budget. */
export function checkBudget(b: Budget, l: UsageLedger, model: string, estIn: number, estOut: number): void {
  if (l.requests + 1 > b.maxRequests) throw new BudgetExceeded('maxRequests');
  if (l.inputTokens + estIn > b.maxInputTokens) throw new BudgetExceeded('maxInputTokens');
  if (l.outputTokens + estOut > b.maxOutputTokens) throw new BudgetExceeded('maxOutputTokens');
  const c = costOf(model, estIn, estOut);
  if (c !== undefined && l.estimatedCostUsd + c > b.maxCostUsd) throw new BudgetExceeded('maxCostUsd');
  if (c === undefined && b.maxCostUsd <= 0) throw new BudgetExceeded('maxCostUsd');
}

export function record(l: UsageLedger, model: string, u: Usage): UsageLedger {
  const c = costOf(model, u.inputTokens, u.outputTokens) ?? 0;
  return {
    ...l,
    requests: l.requests + 1,
    inputTokens: l.inputTokens + u.inputTokens,
    outputTokens: l.outputTokens + u.outputTokens,
    estimatedCostUsd: l.estimatedCostUsd + c,
    anyEstimated: l.anyEstimated || u.estimated,
  };
}

export interface RunEstimate {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number | undefined;
  costLowUsd?: number | undefined;
  costHighUsd?: number | undefined;
  assumptions: string[];
}

/** Estimate a batched run before consent. */
export function estimateRun(opts: {
  model: string;
  items: number;
  batchSize: number;
  promptOverheadTokens: number;
  perItemInputTokens: number;
  perItemOutputTokens: number;
  extraRequests?: number;
}): RunEstimate {
  const batches = Math.ceil(opts.items / Math.max(1, opts.batchSize)) + (opts.extraRequests ?? 0);
  const inputTokens = batches * opts.promptOverheadTokens + opts.items * opts.perItemInputTokens;
  const outputTokens = opts.items * opts.perItemOutputTokens + batches * 20;
  const cost = costOf(opts.model, inputTokens, outputTokens);
  const p = priceFor(opts.model);
  return {
    requests: batches,
    inputTokens,
    outputTokens,
    costUsd: cost,
    costLowUsd: cost === undefined ? undefined : cost * 0.6,
    costHighUsd: cost === undefined ? undefined : cost * 1.6,
    assumptions: [
      `${batches} request(s) of up to ${opts.batchSize} bookmarks.`,
      `Token counts are local estimates (±40%); thinking tokens are billed as output.`,
      p ? `Prices: $${p.inputPerMTokUsd}/1M input, $${p.outputPerMTokUsd}/1M output for ${p.model} (paid tier, checked ${p.checked}).${p.note ? ` ${p.note}` : ''}` : `No price on file for ${opts.model}; cost cannot be estimated.`,
      'Free-tier keys are not billed but have rate limits, and Google may use free-tier content to improve its products.',
      'Retries after errors can add requests; the budget ceiling stops processing gracefully.',
    ],
  };
}
