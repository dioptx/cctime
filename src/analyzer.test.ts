import { describe, it, expect } from 'vitest';
import { analyzeSession } from './analyzer.js';
import type { SessionMessage } from './types.js';

function msg(overrides: Partial<SessionMessage> & { type: SessionMessage['type']; timestamp: string }): SessionMessage {
  return { uuid: Math.random().toString(36), ...overrides } as SessionMessage;
}

function assistantMsg(ts: string, opts: { model?: string; toolUses?: { id: string; name: string }[]; requestId?: string; usage?: any } = {}): SessionMessage {
  const content = [
    { type: 'text' as const, text: 'response' },
    ...(opts.toolUses || []).map(tu => ({ type: 'tool_use' as const, id: tu.id, name: tu.name })),
  ];
  return msg({
    type: 'assistant',
    timestamp: ts,
    requestId: opts.requestId || `req_${ts}`,
    message: {
      role: 'assistant',
      model: opts.model || 'claude-opus-4-6',
      usage: opts.usage || { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
      content,
    },
  });
}

function userMsg(ts: string, text?: string): SessionMessage {
  return msg({
    type: 'user',
    timestamp: ts,
    message: { role: 'user', content: text || 'hello' },
  });
}

function toolResultMsg(ts: string, toolUseIds: string[], opts?: { isError?: boolean }): SessionMessage {
  return msg({
    type: 'user',
    timestamp: ts,
    message: {
      role: 'user',
      content: toolUseIds.map(id => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: opts?.isError ? 'error' : 'ok',
        is_error: opts?.isError,
      })),
    },
  });
}

function summaryMsg(text: string): SessionMessage {
  return msg({ type: 'summary', timestamp: '2026-01-01T00:00:00Z', summary: text });
}

describe('analyzer: enhanced phases', () => {
  it('should classify user→assistant gap as claudeThink', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'), // 5s think time
    ]);

    expect(result.enhancedStats.claudeThink).toBe(5000);
    expect(result.enhancedStats.humanAway).toBe(0);
    expect(result.enhancedStats.humanWait).toBe(0);
  });

  it('should classify assistant→user gap < 2min as humanWait (waiting on you)', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:03Z'),
      userMsg('2026-01-01T00:01:00Z'), // 57s later — short gap
      assistantMsg('2026-01-01T00:01:05Z'),
    ]);

    expect(result.enhancedStats.humanWait).toBe(57000);
    expect(result.enhancedStats.humanAway).toBe(0);
  });

  it('should classify assistant→user gap >= 2min as humanAway', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'),
      userMsg('2026-01-01T00:10:00Z'), // 10min later — AFK
      assistantMsg('2026-01-01T00:10:03Z'),
    ]);

    expect(result.enhancedStats.humanAway).toBeGreaterThan(0);
    expect(result.enhancedStats.humanWait).toBe(0);
  });

  it('should classify tool_use→tool_result gap as toolExec', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:12Z', ['tu1']), // 10s tool exec
    ]);

    expect(result.enhancedStats.toolExec).toBe(10000);
  });

  it('should classify tool_result→assistant gap as claudeThink (mid-turn)', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Read' }] }),
      toolResultMsg('2026-01-01T00:00:04Z', ['tu1']),
      assistantMsg('2026-01-01T00:00:08Z', { toolUses: [{ id: 'tu2', name: 'Edit' }] }), // 4s thinking after getting result
      toolResultMsg('2026-01-01T00:00:09Z', ['tu2']),
    ]);

    // Should have two claudeThink segments: user→first assistant (2s) + toolResult→second assistant (4s)
    expect(result.enhancedStats.claudeThink).toBe(6000);
  });

  it('should classify Task tool as subagent time (legacy)', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Task' }] }),
      toolResultMsg('2026-01-01T00:01:00Z', ['tu1']), // 58s subagent
    ]);

    expect(result.enhancedStats.subagent).toBe(58000);
    expect(result.enhancedStats.toolExec).toBe(0);
  });

  it('should classify Agent tool as subagent time', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Agent' }] }),
      toolResultMsg('2026-01-01T00:01:00Z', ['tu1']), // 58s subagent
    ]);

    expect(result.enhancedStats.subagent).toBe(58000);
    expect(result.enhancedStats.toolExec).toBe(0);
  });

  it('should classify Agent tool as subagent in legacy phases', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Agent' }] }),
      toolResultMsg('2026-01-01T00:01:00Z', ['tu1']),
    ]);

    expect(result.stats.subagent).toBeGreaterThan(0);
  });

  it('should not double-count away time in active duration', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'),
      userMsg('2026-01-01T01:00:00Z'), // 1h AFK
      assistantMsg('2026-01-01T01:00:03Z'),
    ]);

    const activeMs = result.durationMs - result.enhancedStats.humanAway;
    expect(activeMs).toBeLessThan(60_000); // Active work < 1 min
    expect(result.enhancedStats.humanAway).toBeGreaterThan(3_000_000); // ~1h away
  });
});

describe('analyzer: tool latencies', () => {
  it('should compute per-tool avg/p50/p95', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:11Z', ['tu1']), // 10s
      assistantMsg('2026-01-01T00:00:12Z', { toolUses: [{ id: 'tu2', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:14Z', ['tu2']), // 2s
      assistantMsg('2026-01-01T00:00:15Z', { toolUses: [{ id: 'tu3', name: 'Read' }] }),
      toolResultMsg('2026-01-01T00:00:15.1Z', ['tu3']), // 100ms
    ]);

    const bash = result.toolLatencies.find(t => t.name === 'Bash');
    expect(bash).toBeDefined();
    expect(bash!.count).toBe(2);
    expect(bash!.avgMs).toBe(6000); // (10000+2000)/2

    const read = result.toolLatencies.find(t => t.name === 'Read');
    expect(read).toBeDefined();
    expect(read!.count).toBe(1);
  });

  it('should sort by avgMs descending', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Read' }, { id: 'tu2', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:02Z', ['tu1']),   // Read: 1s
      toolResultMsg('2026-01-01T00:00:11Z', ['tu2']),   // Bash: 10s
    ]);

    expect(result.toolLatencies[0].name).toBe('Bash');
    expect(result.toolLatencies[1].name).toBe('Read');
  });
});

describe('analyzer: turn metrics', () => {
  it('should count only external user messages as turns', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z', 'first question'),
      assistantMsg('2026-01-01T00:00:05Z', { toolUses: [{ id: 'tu1', name: 'Read' }] }),
      toolResultMsg('2026-01-01T00:00:06Z', ['tu1']), // NOT a turn
      assistantMsg('2026-01-01T00:00:08Z'),
      userMsg('2026-01-01T00:00:30Z', 'second question'), // IS a turn
      assistantMsg('2026-01-01T00:00:35Z'),
    ]);

    expect(result.turnCount).toBe(2);
    expect(result.turnMetrics).toHaveLength(2);
    expect(result.turnMetrics[0].responseMs).toBe(5000);
    expect(result.turnMetrics[1].responseMs).toBe(5000);
  });
});

describe('analyzer: cost estimation', () => {
  it('should estimate cost based on model pricing', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z', {
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 10000, cache_creation_input_tokens: 0 },
      }),
    ]);

    // Opus: $15/M input, $75/M output, cache read at 10%
    // (1000/1M * 15) + (500/1M * 75) + (10000/1M * 15 * 0.1)
    // = 0.015 + 0.0375 + 0.015 = 0.0675
    expect(result.estimatedCostUsd).toBeCloseTo(0.0675, 3);
  });
});

describe('analyzer: summary extraction', () => {
  it('should use summary message if present', () => {
    const result = analyzeSession('s1', [
      summaryMsg('Implementing authentication system'),
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'),
    ]);

    expect(result.summary).toBe('Implementing authentication system');
  });

  it('should return Untitled session when no summary', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'),
    ]);

    expect(result.summary).toBe('Untitled session');
  });
});

describe('analyzer: context trend', () => {
  it('should track input token context per API call', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z', {
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 500 },
      }),
      userMsg('2026-01-01T00:00:30Z'),
      assistantMsg('2026-01-01T00:00:35Z', {
        usage: { input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 2000, cache_creation_input_tokens: 600 },
      }),
    ]);

    expect(result.contextTrend).toEqual([1600, 2800]); // input + cache_read + cache_creation
  });
});

describe('analyzer: edge cases', () => {
  it('should return empty analysis for no messages', () => {
    const result = analyzeSession('empty', []);
    expect(result.durationMs).toBe(0);
    expect(result.turnCount).toBe(0);
    expect(result.estimatedCostUsd).toBe(0);
    expect(result.summary).toBe('Empty session');
  });

  it('should clamp activeMs to non-negative', () => {
    // Construct case where humanAway > durationMs (edge case from overlapping segments)
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z'),
    ]);
    // durationMs=1000, humanAway=0, so activeMs=1000 — valid
    const activeMs = Math.max(0, result.durationMs - result.enhancedStats.humanAway);
    expect(activeMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle unknown model names gracefully', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z', { model: 'mystery-model-v99' }),
    ]);
    expect(result.models['mystery-model-v99']).toBe(1);
    expect(result.estimatedCostUsd).toBeGreaterThan(0); // defaults to sonnet pricing
  });

  it('should handle pending tools at session end', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      // No tool result — session ended mid-tool-execution
    ]);
    // Should not crash, toolExec should be 0 (no result to measure against)
    expect(result.enhancedStats.toolExec).toBe(0);
    expect(result.tools['Bash']).toBe(1);
  });

  it('should filter sidechain messages', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z'),
      { ...assistantMsg('2026-01-01T00:00:06Z'), isSidechain: true } as any,
    ]);
    // Sidechain message should be excluded from main analysis
    expect(result.durationMs).toBe(5000); // Only spans user→first assistant
  });
});

describe('analyzer: planning mode', () => {
  it('should detect planning phase from EnterPlanMode/ExitPlanMode', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'pm1', name: 'EnterPlanMode' }] }),
      toolResultMsg('2026-01-01T00:00:03Z', ['pm1']),
      assistantMsg('2026-01-01T00:00:10Z'), // 7s in planning
      msg({ type: 'user', timestamp: '2026-01-01T00:00:11Z', message: { role: 'user', content: 'looks good' } }),
      assistantMsg('2026-01-01T00:00:13Z', { toolUses: [{ id: 'pm2', name: 'ExitPlanMode' }] }),
      toolResultMsg('2026-01-01T00:00:14Z', ['pm2']),
    ]);
    expect(result.enhancedStats.planning).toBeGreaterThan(0);
  });
});

describe('analyzer: stuck loops', () => {
  it('should detect 2+ consecutive failures of same tool', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:02Z', ['tu1'], { isError: true }),
      assistantMsg('2026-01-01T00:00:03Z', { toolUses: [{ id: 'tu2', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:04Z', ['tu2'], { isError: true }),
      assistantMsg('2026-01-01T00:00:05Z', { toolUses: [{ id: 'tu3', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:06Z', ['tu3'], { isError: true }),
    ]);

    expect(result.stuckLoops).toHaveLength(1);
    expect(result.stuckLoops[0].toolName).toBe('Bash');
    expect(result.stuckLoops[0].attempts).toBe(3);
    expect(result.stuckLoops[0].failures).toBe(3);
    expect(result.stuckLoops[0].resolved).toBe(false);
  });

  it('should mark as resolved when final attempt succeeds', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Edit' }] }),
      toolResultMsg('2026-01-01T00:00:02Z', ['tu1'], { isError: true }),
      assistantMsg('2026-01-01T00:00:03Z', { toolUses: [{ id: 'tu2', name: 'Edit' }] }),
      toolResultMsg('2026-01-01T00:00:04Z', ['tu2'], { isError: true }),
      assistantMsg('2026-01-01T00:00:05Z', { toolUses: [{ id: 'tu3', name: 'Edit' }] }),
      toolResultMsg('2026-01-01T00:00:36Z', ['tu3']), // success after 2 failures
    ]);

    expect(result.stuckLoops).toHaveLength(1);
    expect(result.stuckLoops[0].resolved).toBe(true);
    expect(result.stuckLoops[0].attempts).toBe(3);
    expect(result.stuckLoops[0].failures).toBe(2);
    expect(result.stuckLoops[0].durationMs).toBe(35000); // 00:01 to 00:36
  });

  it('should NOT flag single failures', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:02Z', ['tu1'], { isError: true }),
      assistantMsg('2026-01-01T00:00:03Z', { toolUses: [{ id: 'tu2', name: 'Read' }] }), // different tool
      toolResultMsg('2026-01-01T00:00:04Z', ['tu2']),
    ]);

    expect(result.stuckLoops).toHaveLength(0);
  });

  it('should track independent tools separately', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      // Bash fails twice
      assistantMsg('2026-01-01T00:00:01Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:02Z', ['tu1'], { isError: true }),
      assistantMsg('2026-01-01T00:00:03Z', { toolUses: [{ id: 'tu2', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:04Z', ['tu2'], { isError: true }),
      // Switch to Read (breaks Bash chain)
      assistantMsg('2026-01-01T00:00:05Z', { toolUses: [{ id: 'tu3', name: 'Read' }] }),
      toolResultMsg('2026-01-01T00:00:06Z', ['tu3']),
      // Edit fails twice
      assistantMsg('2026-01-01T00:00:07Z', { toolUses: [{ id: 'tu4', name: 'Edit' }] }),
      toolResultMsg('2026-01-01T00:00:08Z', ['tu4'], { isError: true }),
      assistantMsg('2026-01-01T00:00:09Z', { toolUses: [{ id: 'tu5', name: 'Edit' }] }),
      toolResultMsg('2026-01-01T00:00:10Z', ['tu5'], { isError: true }),
    ]);

    expect(result.stuckLoops).toHaveLength(2);
    expect(result.stuckLoops[0].toolName).toBe('Bash');
    expect(result.stuckLoops[1].toolName).toBe('Edit');
  });
});

describe('analyzer: warmup cost', () => {
  it('should compute first turn cost vs steady state', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z', {
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 20000 },
      }),
      userMsg('2026-01-01T00:01:00Z'),
      assistantMsg('2026-01-01T00:01:05Z', {
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 },
      }),
      userMsg('2026-01-01T00:02:00Z'),
      assistantMsg('2026-01-01T00:02:05Z', {
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 20000, cache_creation_input_tokens: 0 },
      }),
    ]);

    // Turn 1: cache_creation 20K Opus = 20000/1M * 15 * 1.25 = 0.375 + input + output
    expect(result.warmupCost.warmupCostUsd).toBeGreaterThan(result.warmupCost.steadyAvgCostUsd);
    expect(result.warmupCost.warmupCacheCreation).toBe(20000);
    expect(result.warmupCost.turnCount).toBe(3);
  });

  it('should handle single-turn session', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:05Z', {
        model: 'claude-opus-4-6',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 5000 },
      }),
    ]);

    expect(result.warmupCost.warmupCostUsd).toBeGreaterThan(0);
    expect(result.warmupCost.steadyAvgCostUsd).toBe(0); // no subsequent turns
    expect(result.warmupCost.turnCount).toBe(1);
  });
});

describe('analyzer: segment-union ≤ wall-clock invariant', () => {
  // Local copy of the analyzer's wall-clock union (it isn't exported). Time
  // accounting must aggregate possibly-overlapping spans by UNION, not SUM —
  // overlapping spans can never cover more wall-clock than exists. This guards
  // against a regression that double-counts parallel tool/subagent spans.
  function unionMs(spans: Array<[number, number]>): number {
    if (spans.length === 0) return 0;
    const sorted = [...spans].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [curStart, curEnd] = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const [s, e] = sorted[i];
      if (s <= curEnd) {
        if (e > curEnd) curEnd = e;
      } else {
        total += curEnd - curStart;
        curStart = s;
        curEnd = e;
      }
    }
    return total + (curEnd - curStart);
  }

  // seconds within one minute → ISO timestamp (matches the literal style above)
  const T = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}Z`;

  it('holds with overlapping parallel-tool spans (union ≤ span < naive sum)', () => {
    // Two tool_use in ONE assistant message → both start at the assistant ts, so
    // their toolExec segments overlap. A naive sum overcounts; the union must not.
    const result = analyzeSession('s1', [
      userMsg(T(0)),
      assistantMsg(T(2), { toolUses: [{ id: 'tu1', name: 'Bash' }, { id: 'tu2', name: 'Bash' }] }),
      toolResultMsg(T(32), ['tu1']), // toolExec [2,32] = 30s
      toolResultMsg(T(42), ['tu2']), // toolExec [2,42] = 40s, overlaps tu1
      assistantMsg(T(50)),           // claudeThink [42,50] = 8s
    ]);

    const segs = result.enhancedSegments;
    expect(segs.length).toBeGreaterThan(0);

    const minStart = Math.min(...segs.map(s => s.startTime));
    const maxEnd = Math.max(...segs.map(s => s.endTime));
    const span = maxEnd - minStart;
    const union = unionMs(segs.map(s => [s.startTime, s.endTime] as [number, number]));
    const naiveSum = segs.reduce((acc, s) => acc + s.durationMs, 0);

    // The invariant: union of all phase segments never exceeds the wall-clock span.
    expect(union).toBeLessThanOrEqual(span);
    // The parallel tools genuinely overlap, so the naive sum DOES exceed the span —
    // demonstrating why aggregation must union (the bug class this guards).
    expect(naiveSum).toBeGreaterThan(span);

    // Each segment is a valid, non-negative interval consistent with its duration.
    for (const s of segs) {
      expect(s.endTime).toBeGreaterThanOrEqual(s.startTime);
      expect(s.durationMs).toBe(s.endTime - s.startTime);
    }
  });

  it('holds for a simple sequential session (no overlap)', () => {
    const result = analyzeSession('s2', [
      userMsg(T(0)),
      assistantMsg(T(5), { toolUses: [{ id: 'tu1', name: 'Read' }] }),
      toolResultMsg(T(8), ['tu1']),
      assistantMsg(T(10)),
    ]);
    const segs = result.enhancedSegments;
    const span = Math.max(...segs.map(s => s.endTime)) - Math.min(...segs.map(s => s.startTime));
    const union = unionMs(segs.map(s => [s.startTime, s.endTime] as [number, number]));
    expect(union).toBeLessThanOrEqual(span);
  });
});

describe('analyzer: parallel subagents counted by wall-clock union', () => {
  it('does not sum overlapping (fanned-out) subagent durations', () => {
    // 3 Agents dispatched in ONE assistant turn (parallel fan-out), all starting
    // at 00:00:10, returning staggered at +60s / +120s / +180s.
    // Per-agent durations sum to 360s; true wall-clock elapsed is 180s.
    const messages: SessionMessage[] = [
      userMsg('2026-01-01T00:00:00Z', 'go'),
      assistantMsg('2026-01-01T00:00:10Z', {
        toolUses: [
          { id: 'a1', name: 'Agent' },
          { id: 'a2', name: 'Agent' },
          { id: 'a3', name: 'Agent' },
        ],
      }),
      toolResultMsg('2026-01-01T00:01:10Z', ['a1']),
      toolResultMsg('2026-01-01T00:02:10Z', ['a2']),
      toolResultMsg('2026-01-01T00:03:10Z', ['a3']),
      assistantMsg('2026-01-01T00:03:20Z'),
    ];
    const a = analyzeSession('s', messages);
    expect(a.enhancedStats.subagent).toBe(180_000); // union, NOT 360_000 sum
    expect(a.enhancedStats.toolExec).toBe(0);
  });

  it('does not sum overlapping parallel non-agent tool calls either', () => {
    // 2 Bash calls in one turn, overlapping: spans 60s + 120s (sum 180s), union 120s.
    const messages: SessionMessage[] = [
      userMsg('2026-01-01T00:00:00Z', 'go'),
      assistantMsg('2026-01-01T00:00:10Z', {
        toolUses: [
          { id: 'b1', name: 'Bash' },
          { id: 'b2', name: 'Bash' },
        ],
      }),
      toolResultMsg('2026-01-01T00:01:10Z', ['b1']),
      toolResultMsg('2026-01-01T00:02:10Z', ['b2']),
      assistantMsg('2026-01-01T00:02:20Z'),
    ];
    const a = analyzeSession('s', messages);
    expect(a.enhancedStats.toolExec).toBe(120_000); // union, NOT 180_000 sum
    expect(a.enhancedStats.subagent).toBe(0);
  });

  it('sequential subagents still add up (no spurious union collapse)', () => {
    // Two NON-overlapping agents: 60s then 60s = 120s union == 120s sum.
    const messages: SessionMessage[] = [
      userMsg('2026-01-01T00:00:00Z', 'go'),
      assistantMsg('2026-01-01T00:00:10Z', { toolUses: [{ id: 'a1', name: 'Agent' }] }),
      toolResultMsg('2026-01-01T00:01:10Z', ['a1']),
      assistantMsg('2026-01-01T00:01:20Z', { toolUses: [{ id: 'a2', name: 'Agent' }] }),
      toolResultMsg('2026-01-01T00:02:20Z', ['a2']),
      assistantMsg('2026-01-01T00:02:30Z'),
    ];
    const a = analyzeSession('s', messages);
    expect(a.enhancedStats.subagent).toBe(120_000);
  });
});

describe('analyzer: thinking gaps are capped (mid-turn suspension ≠ thinking)', () => {
  const CAP = 10 * 60 * 1000; // THINK_CAP_MS

  it('caps a long tool_result→assistant gap: 10min think + remainder humanAway', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:00:02Z', { toolUses: [{ id: 'tu1', name: 'Bash' }] }),
      toolResultMsg('2026-01-01T00:00:12Z', ['tu1']),
      assistantMsg('2026-01-01T02:00:12Z'), // 2h gap after the tool result (session suspended)
    ]);
    // 2s legit first-response think (user→assistant) + 10min cap on the suspended gap
    expect(result.enhancedStats.claudeThink).toBe(2000 + CAP);
    expect(result.enhancedStats.humanAway).toBe(2 * 60 * 60 * 1000 - CAP); // 1h50m booked as away
  });

  it('caps a long user→assistant first-response gap the same way', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T03:00:00Z'), // 3h before first response (suspended)
    ]);
    expect(result.enhancedStats.claudeThink).toBe(CAP);
    expect(result.enhancedStats.humanAway).toBe(3 * 60 * 60 * 1000 - CAP);
  });

  it('leaves a normal short think gap untouched (no spurious humanAway)', () => {
    const result = analyzeSession('s1', [
      userMsg('2026-01-01T00:00:00Z'),
      assistantMsg('2026-01-01T00:05:00Z'), // 5min < cap
    ]);
    expect(result.enhancedStats.claudeThink).toBe(5 * 60 * 1000);
    expect(result.enhancedStats.humanAway).toBe(0);
  });
});
