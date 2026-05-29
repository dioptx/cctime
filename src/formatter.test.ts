import { describe, it, expect } from 'vitest';
import { formatSession, formatAggregate, formatSessionLive, formatCompact, formatCsv, formatMarkdown, formatJsonAggregate } from './formatter.js';
import type { SessionAnalysis, EnhancedStats, StuckLoop, WarmupCost } from './types.js';

// Strip ANSI codes for assertion
function strip(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function makeAnalysis(overrides: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return {
    sessionId: 's1',
    summary: 'Test session',
    startTime: Date.parse('2026-01-01T10:00:00Z'),
    endTime: Date.parse('2026-01-01T10:15:00Z'),
    durationMs: 15 * 60 * 1000,
    segments: [],
    stats: { planning: 0, coding: 0, subagent: 0, idle: 0 },
    tokens: { input: 5000, output: 2000, cacheRead: 50000, cacheCreation: 10000 },
    cacheHitRate: 0.77,
    models: { Opus: 10, Sonnet: 2 },
    tools: { Bash: 15, Read: 8, Edit: 5, Grep: 3, Write: 2 },
    enhancedStats: { humanWait: 30000, humanAway: 0, claudeThink: 180000, toolExec: 450000, subagent: 120000, planning: 0 },
    enhancedSegments: [],
    toolLatencies: [
      { name: 'Bash', count: 15, totalMs: 75000, avgMs: 5000, p50Ms: 3000, p95Ms: 15000 },
      { name: 'Read', count: 8, totalMs: 800, avgMs: 100, p50Ms: 80, p95Ms: 200 },
      { name: 'Edit', count: 5, totalMs: 500, avgMs: 100, p50Ms: 90, p95Ms: 150 },
    ],
    turnMetrics: [],
    turnCount: 6,
    avgResponseMs: 5000,
    estimatedCostUsd: 1.25,
    costPerMinuteUsd: 0.08,
    contextTrend: [10000, 15000, 20000, 25000, 30000, 35000],
    stuckLoops: [],
    warmupCost: { warmupCostUsd: 0, steadyAvgCostUsd: 0, warmupCacheCreation: 0, turnCount: 0 },
    ...overrides,
  };
}

describe('formatter: single session', () => {
  it('should show active time vs total, not raw duration', () => {
    const analysis = makeAnalysis({
      durationMs: 60 * 60 * 1000, // 1h total
      enhancedStats: { humanWait: 30000, humanAway: 50 * 60 * 1000, claudeThink: 180000, toolExec: 120000, subagent: 0, planning: 0 },
    });
    const output = strip(formatSession(analysis));
    expect(output).toContain('active');
    expect(output).toContain('away');
  });

  it('should show percentages relative to active time, not wall clock', () => {
    const analysis = makeAnalysis({
      durationMs: 10 * 60 * 1000,
      enhancedStats: { humanWait: 0, humanAway: 5 * 60 * 1000, claudeThink: 3 * 60 * 1000, toolExec: 2 * 60 * 1000, subagent: 0, planning: 0 },
    });
    const output = strip(formatSession(analysis));
    expect(output).toMatch(/Claude thinking.*60%/);
    expect(output).toMatch(/Tool execution.*40%/);
  });

  it('should show tools sorted by call count with latency', () => {
    const output = strip(formatSession(makeAnalysis()));
    const toolsSection = output.slice(output.indexOf('Tools'));
    const bashIdx = toolsSection.indexOf('Bash');
    const readIdx = toolsSection.indexOf('Read');
    expect(bashIdx).toBeLessThan(readIdx);
    expect(toolsSection).toContain('avg');
  });

  it('should show cost in efficiency section', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toContain('$1.25');
    expect(output).toContain('Cost');
  });

  it('should show session summary', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toContain('Test session');
  });

  it('should replace untitled summary with date label in single session', () => {
    const output = strip(formatSession(makeAnalysis({ summary: 'Untitled session' })));
    expect(output).not.toContain('Untitled session');
    expect(output).toMatch(/Jan\s+1.*session/);
  });

  it('should show token bar with in/out and cost underneath', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toMatch(/Tokens/);
    // Single session "in" includes input+cacheRead+cacheCreation = 5000+50000+10000 = 65K
    expect(output).toMatch(/65\.0K in/);
    expect(output).toMatch(/2\.0K out/);
  });

  it('should show tools with bars (not just text list)', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toMatch(/Bash/);
    const toolsSection = output.slice(output.indexOf('Tools'));
    expect(toolsSection).toMatch(/calls/);
  });

  it('should show model mix with bar representation', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toMatch(/Opus/);
    expect(output).toMatch(/Sonnet/);
  });

  it('should show context sparkline', () => {
    const output = strip(formatSession(makeAnalysis()));
    expect(output).toContain('Context:');
  });

  it('should hide zero-value phases', () => {
    const analysis = makeAnalysis({
      enhancedStats: { humanWait: 0, humanAway: 0, claudeThink: 60000, toolExec: 30000, subagent: 0, planning: 0 },
    });
    const output = strip(formatSession(analysis));
    expect(output).not.toContain('Subagents');
    expect(output).not.toContain('Planning');
  });

  it('should handle zero-duration session', () => {
    const analysis = makeAnalysis({
      durationMs: 0,
      enhancedStats: { humanWait: 0, humanAway: 0, claudeThink: 0, toolExec: 0, subagent: 0, planning: 0 },
    });
    const output = strip(formatSession(analysis));
    expect(output).toContain('0s active');
  });

  it('should handle session with no tools', () => {
    const analysis = makeAnalysis({
      tools: {},
      toolLatencies: [],
    });
    const output = strip(formatSession(analysis));
    expect(output).not.toContain('Tools');
    expect(output).toContain('cctime');
  });

  it('should handle session with no models', () => {
    const analysis = makeAnalysis({ models: {} });
    const output = strip(formatSession(analysis));
    expect(output).not.toMatch(/Models\s*\n.*Opus/);
    expect(output).toContain('cctime');
  });

  it('should truncate long tool names', () => {
    const analysis = makeAnalysis({
      tools: { mcp__playwright__browser_snapshot: 5 },
      toolLatencies: [{ name: 'mcp__playwright__browser_snapshot', count: 5, totalMs: 5000, avgMs: 1000, p50Ms: 800, p95Ms: 2000 }],
    });
    const output = strip(formatSession(analysis));
    // Tool name should be truncated with ellipsis
    expect(output).toContain('\u2026');
  });

  it('should show $0.00 for zero cost, not <$0.01', () => {
    const analysis = makeAnalysis({ estimatedCostUsd: 0, costPerMinuteUsd: 0 });
    const output = strip(formatSession(analysis));
    expect(output).toContain('$0.00');
    expect(output).not.toContain('<$0.01');
  });
});

describe('formatter: live session', () => {
  it('should show LIVE badge', () => {
    const output = strip(formatSessionLive(makeAnalysis()));
    expect(output).toContain('LIVE');
  });

  it('should show Ctrl+C hint', () => {
    const output = strip(formatSessionLive(makeAnalysis()));
    expect(output).toContain('Ctrl+C');
  });

  it('should show model percentages in footer', () => {
    const output = strip(formatSessionLive(makeAnalysis()));
    expect(output).toMatch(/Opus.*%/);
  });
});

describe('formatter: aggregate', () => {
  it('should show hourly activity heatmap', () => {
    const sessions = [
      makeAnalysis({ durationMs: 60 * 60 * 1000 }),
      makeAnalysis({ durationMs: 30 * 60 * 1000 }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toContain('Activity');
    expect(output).toContain('12a');
    expect(output).toContain('12p');
  });

  it('should show active time vs total in aggregate', () => {
    const sessions = [
      makeAnalysis({
        durationMs: 60 * 60 * 1000,
        enhancedStats: { humanWait: 0, humanAway: 30 * 60 * 1000, claudeThink: 15 * 60 * 1000, toolExec: 15 * 60 * 1000, subagent: 0, planning: 0 },
      }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toContain('active');
    expect(output).toContain('away');
  });

  it('should show total cost in aggregate', () => {
    const sessions = [
      makeAnalysis({ durationMs: 60 * 60 * 1000, estimatedCostUsd: 5.50, summary: 'Expensive' }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toContain('$5.50');
  });

  it('should show tokens with bar (not plain text)', () => {
    const sessions = [makeAnalysis()];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toMatch(/Tokens.*in.*out/);
    expect(output).not.toMatch(/Tokens:.*\u00b7/);
  });

  it('should show models with bars (not plain text)', () => {
    const sessions = [makeAnalysis()];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toMatch(/Opus.*%/);
    expect(output).toMatch(/calls/);
    expect(output).not.toMatch(/Models: Opus/);
  });

  it('should show tools with bars and latency (not plain text)', () => {
    const sessions = [makeAnalysis()];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toMatch(/Bash.*calls/);
    expect(output).toMatch(/Read.*calls/);
    expect(output).toMatch(/avg/);
    expect(output).not.toMatch(/Tools:.*\u00b7/);
  });

  it('should show daily breakdown when multiple days', () => {
    const sessions = [
      makeAnalysis({
        durationMs: 60 * 60 * 1000,
        startTime: Date.parse('2026-01-05T10:00:00Z'),
        endTime: Date.parse('2026-01-05T11:00:00Z'),
      }),
      makeAnalysis({
        durationMs: 30 * 60 * 1000,
        startTime: Date.parse('2026-01-06T14:00:00Z'),
        endTime: Date.parse('2026-01-06T14:30:00Z'),
      }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toMatch(/Mon\s+5/);
    expect(output).toMatch(/Tue\s+6/);
    expect(output).toMatch(/sess/);
    expect(output).toMatch(/turns/);
  });

  it('should NOT show daily breakdown for single day', () => {
    const sessions = [
      makeAnalysis({ startTime: Date.parse('2026-01-05T10:00:00Z') }),
      makeAnalysis({ startTime: Date.parse('2026-01-05T14:00:00Z') }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    // Should have activity heatmap but not daily rows
    expect(output).toContain('Activity');
    expect(output).not.toMatch(/Mon\s+5.*sess/);
  });

  it('should include cache tokens in aggregate totals', () => {
    const sessions = [makeAnalysis({
      tokens: { input: 1000, output: 500, cacheRead: 10000, cacheCreation: 2000 },
    })];
    const output = strip(formatAggregate(sessions, 'Test'));
    // totalTokensIn = 1000+10000+2000 = 13K
    expect(output).toMatch(/13\.0K in/);
  });
});

describe('formatter: compact', () => {
  it('should show one line per session', () => {
    const sessions = [makeAnalysis(), makeAnalysis({ summary: 'Second session' })];
    const output = strip(formatCompact(sessions));
    const lines = output.split('\n').filter(l => l.trim());
    // Header + separator + 2 data rows + separator + totals
    expect(lines.length).toBe(6);
  });

  it('should show header row with column names', () => {
    const output = strip(formatCompact([makeAnalysis()]));
    expect(output).toContain('Time');
    expect(output).toContain('Duration');
    expect(output).toContain('Cost');
    expect(output).toContain('Turns');
  });
});

describe('formatter: csv', () => {
  it('should produce valid CSV with headers', () => {
    const csv = formatCsv([makeAnalysis()]);
    const lines = csv.split('\n');
    expect(lines[0]).toContain('timestamp,duration_min');
    expect(lines).toHaveLength(2); // header + 1 row
  });

  it('should quote summaries with special characters', () => {
    const csv = formatCsv([makeAnalysis({ summary: 'Has "quotes" inside' })]);
    expect(csv).toContain('""quotes""'); // CSV escaping
  });

  it('should include cache tokens in tokens_in column', () => {
    const csv = formatCsv([makeAnalysis({
      tokens: { input: 1000, output: 500, cacheRead: 10000, cacheCreation: 2000 },
    })]);
    const dataRow = csv.split('\n')[1];
    // tokens_in = 1000+10000+2000 = 13000
    expect(dataRow).toContain(',13000,');
  });
});

describe('formatter: markdown', () => {
  it('should produce markdown table with header and separator', () => {
    const md = formatMarkdown([makeAnalysis()]);
    const lines = md.split('\n');
    expect(lines[0]).toContain('|');
    expect(lines[1]).toContain('---');
    expect(lines).toHaveLength(3); // header + separator + 1 row
  });

  it('should escape pipe characters in summary', () => {
    const md = formatMarkdown([makeAnalysis({ summary: 'Has | pipe' })]);
    expect(md).toContain('\\|');
  });
});

describe('formatter: json aggregate', () => {
  it('should wrap in envelope with summary', () => {
    const result = formatJsonAggregate([makeAnalysis()]) as any;
    expect(result.summary).toBeDefined();
    expect(result.sessions).toHaveLength(1);
    expect(result.summary.sessionCount).toBe(1);
    expect(result.summary.totalCostUsd).toBe(1.25);
  });

  it('should aggregate totals from multiple sessions', () => {
    const result = formatJsonAggregate([
      makeAnalysis({ estimatedCostUsd: 1.50 }),
      makeAnalysis({ estimatedCostUsd: 2.50 }),
    ]) as any;
    expect(result.summary.sessionCount).toBe(2);
    expect(result.summary.totalCostUsd).toBe(4);
    expect(result.sessions).toHaveLength(2);
  });
});

describe('formatter: insights', () => {
  it('should show stuck loop warnings in insights section', () => {
    const analysis = makeAnalysis({
      stuckLoops: [
        { toolName: 'Bash', attempts: 4, failures: 3, durationMs: 150000, startTime: 0, endTime: 150000, resolved: true },
        { toolName: 'Edit', attempts: 3, failures: 3, durationMs: 75000, startTime: 0, endTime: 75000, resolved: false },
      ],
    });
    const output = strip(formatSession(analysis));
    expect(output).toContain('Insights');
    expect(output).toContain('Stuck: Bash');
    expect(output).toContain('4 retries');
    expect(output).toContain('resolved');
    expect(output).toContain('Stuck: Edit');
    expect(output).toContain('unresolved');
  });

  it('should show warmup cost in insights section', () => {
    const analysis = makeAnalysis({
      warmupCost: { warmupCostUsd: 0.43, steadyAvgCostUsd: 0.13, warmupCacheCreation: 50000, turnCount: 6 },
    });
    const output = strip(formatSession(analysis));
    expect(output).toContain('Insights');
    expect(output).toContain('Warmup');
    expect(output).toContain('$0.43');
    expect(output).toContain('$0.13');
  });

  it('should hide insights section when no stuck loops and trivial warmup', () => {
    const analysis = makeAnalysis({
      stuckLoops: [],
      warmupCost: { warmupCostUsd: 0.10, steadyAvgCostUsd: 0.09, warmupCacheCreation: 1000, turnCount: 5 },
    });
    const output = strip(formatSession(analysis));
    expect(output).not.toContain('Insights');
  });

  it('should show stuck count in aggregate insights', () => {
    const sessions = [
      makeAnalysis({
        stuckLoops: [
          { toolName: 'Bash', attempts: 3, failures: 2, durationMs: 60000, startTime: 0, endTime: 60000, resolved: true },
          { toolName: 'Edit', attempts: 4, failures: 3, durationMs: 90000, startTime: 0, endTime: 90000, resolved: false },
        ],
        warmupCost: { warmupCostUsd: 0.43, steadyAvgCostUsd: 0.13, warmupCacheCreation: 50000, turnCount: 6 },
      }),
      makeAnalysis({
        stuckLoops: [],
        warmupCost: { warmupCostUsd: 0.40, steadyAvgCostUsd: 0.12, warmupCacheCreation: 45000, turnCount: 5 },
      }),
    ];
    const output = strip(formatAggregate(sessions, 'Test'));
    expect(output).toContain('Insights');
    expect(output).toContain('1 sessions had stuck loops');
    expect(output).toContain('2 total');
    expect(output).toContain('Warmup overhead');
  });
});

describe('formatSession: parallel-subagent benefit insight', () => {
  const seg = (start: number, end: number) => ({
    phase: 'subagent' as const, startTime: start, endTime: end, durationMs: end - start,
  });

  it('shows concurrency + time saved when subagents overlapped', () => {
    // Two agents in one fan-out: [0,180s] and [0,120s] → sum 300s, wall(union) 180s, saved 120s.
    const output = strip(formatSession(makeAnalysis({
      enhancedSegments: [seg(0, 180_000), seg(0, 120_000)],
    })));
    expect(output).toContain('Parallel subagents');
    expect(output).toMatch(/2 ran in 3m wall/);
    expect(output).toMatch(/saved 2m vs sequential/);
  });

  it('shows nothing for a single subagent (no overlap to report)', () => {
    const output = strip(formatSession(makeAnalysis({
      enhancedSegments: [seg(0, 180_000)],
    })));
    expect(output).not.toContain('Parallel subagents');
  });

  it('shows nothing when subagents ran sequentially (no time saved)', () => {
    // [0,60s] then [60s,120s] — adjacent, no overlap → sum == union, nothing saved.
    const output = strip(formatSession(makeAnalysis({
      enhancedSegments: [seg(0, 60_000), seg(60_000, 120_000)],
    })));
    expect(output).not.toContain('Parallel subagents');
  });
});
