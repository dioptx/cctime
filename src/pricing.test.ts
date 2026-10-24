import { describe, it, expect } from 'vitest';
import { estimateCost } from './pricing.js';

describe('pricing: model resolution', () => {
  it('should use opus pricing for opus models', () => {
    const cost = estimateCost('claude-opus-4-6', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(15); // $15/M input
  });

  it('should use sonnet pricing for sonnet models', () => {
    const cost = estimateCost('claude-sonnet-4-5-20250929', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(3); // $3/M input
  });

  // unit — regression: current-generation Haiku (4.5+) bills $1/$5 per MTok,
  // not the Claude-3 Haiku rate of $0.25/$1.25.
  it('should use current Haiku pricing for Haiku 4.5 models', () => {
    const cost = estimateCost('claude-haiku-4-5-20251001', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(1); // $1/M input (current Haiku generation)
  });

  it('should bill current-generation Haiku output at $5/M', () => {
    const cost = estimateCost('claude-haiku-4-5', {
      input_tokens: 0,
      output_tokens: 1_000_000,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(5); // $5/M output
  });

  // unit — legacy Claude 3 / 3.5 Haiku keeps the old $0.25/$1.25 rate so
  // historical session logs still price correctly.
  it('should use legacy pricing for Claude 3/3.5 Haiku models', () => {
    expect(
      estimateCost('claude-3-haiku-20240307', {
        input_tokens: 1_000_000,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(0.25);
    expect(
      estimateCost('claude-3-5-haiku-20241022', {
        input_tokens: 0,
        output_tokens: 1_000_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBe(1.25);
  });

  it('should default to sonnet pricing for unknown models', () => {
    const cost = estimateCost('unknown-model-v9', {
      input_tokens: 1_000_000,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(3); // Sonnet default
  });
});

describe('pricing: cache pricing', () => {
  it('should charge cache reads at 10% of input price', () => {
    const cost = estimateCost('claude-sonnet-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 1_000_000,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBeCloseTo(0.3, 2); // $3/M * 0.1 = $0.30
  });

  it('should charge cache creation at 125% of input price', () => {
    const cost = estimateCost('claude-sonnet-4-5', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(3.75, 2); // $3/M * 1.25 = $3.75
  });
});

describe('pricing: edge cases', () => {
  it('should return 0 for zero tokens', () => {
    const cost = estimateCost('claude-opus-4-6', {
      input_tokens: 0,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    });
    expect(cost).toBe(0);
  });

  it('should compute combined cost correctly', () => {
    // Opus: $15/M input, $75/M output, cache read 10%, cache create 125%
    const cost = estimateCost('claude-opus-4-6', {
      input_tokens: 1000,
      output_tokens: 500,
      cache_read_input_tokens: 10000,
      cache_creation_input_tokens: 2000,
    });
    // (1000/1M * 15) + (500/1M * 75) + (10000/1M * 15 * 0.1) + (2000/1M * 15 * 1.25)
    // = 0.015 + 0.0375 + 0.015 + 0.0375 = 0.105
    expect(cost).toBeCloseTo(0.105, 3);
  });
});
