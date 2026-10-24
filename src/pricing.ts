import type { TokenUsage } from './types.js';

interface ModelPricing {
  inputPerM: number;
  outputPerM: number;
  cacheReadMultiplier: number;
  cacheCreationMultiplier: number;
}

// Per-million-token USD rates. Haiku is model-id aware because the rate changed
// generations: Claude 3 / 3.5 Haiku billed $0.25/$1.25, but the current Haiku
// generation (4.5+) bills $1/$5. cctime reads historical session logs, so both
// still need to price correctly.
const PRICING: Record<string, ModelPricing> = {
  opus: { inputPerM: 15, outputPerM: 75, cacheReadMultiplier: 0.1, cacheCreationMultiplier: 1.25 },
  sonnet: { inputPerM: 3, outputPerM: 15, cacheReadMultiplier: 0.1, cacheCreationMultiplier: 1.25 },
  // Current Haiku generation (Haiku 4.5): $1 / $5 per MTok.
  haiku: { inputPerM: 1, outputPerM: 5, cacheReadMultiplier: 0.1, cacheCreationMultiplier: 1.25 },
  // Legacy Claude 3 / 3.5 Haiku: $0.25 / $1.25 per MTok.
  haikuLegacy: { inputPerM: 0.25, outputPerM: 1.25, cacheReadMultiplier: 0.1, cacheCreationMultiplier: 1.25 },
};

function resolveModel(model: string): ModelPricing {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return PRICING.opus;
  if (lower.includes('haiku')) {
    // Claude 3 / 3.5 Haiku ids look like `claude-3-haiku-…` / `claude-3-5-haiku-…`.
    if (/claude-3(-5)?-haiku/.test(lower)) return PRICING.haikuLegacy;
    return PRICING.haiku;
  }
  // Default to sonnet for unknown models
  return PRICING.sonnet;
}

export function estimateCost(model: string, usage: TokenUsage): number {
  const p = resolveModel(model);
  const input = usage.input_tokens || 0;
  const output = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheCreate = usage.cache_creation_input_tokens || 0;
  const inputCost = (input / 1_000_000) * p.inputPerM;
  const outputCost = (output / 1_000_000) * p.outputPerM;
  const cacheReadCost = (cacheRead / 1_000_000) * p.inputPerM * p.cacheReadMultiplier;
  const cacheCreateCost = (cacheCreate / 1_000_000) * p.inputPerM * p.cacheCreationMultiplier;
  return inputCost + outputCost + cacheReadCost + cacheCreateCost;
}
