import type {
  SessionMessage, SessionAnalysis, TimeSegment, PhaseType, PhaseStats,
  EnhancedTimeSegment, EnhancedPhaseType, EnhancedStats, ToolLatency, TurnMetrics,
  MessageContent, StuckLoop, WarmupCost,
} from './types.js';
import { estimateCost } from './pricing.js';

const IDLE_THRESHOLD_MS = 2 * 60 * 1000; // 2 minutes
// A single uninterrupted model response effectively never exceeds this. A longer
// gap before an assistant message means the session was SUSPENDED mid-turn
// (overnight pause, credit stall, remote-control handoff) — not the model
// "thinking" for hours. We cap the thinking slice at this and attribute the
// remainder to humanAway, so long-pause sessions aren't reported as huge
// "Claude thinking" time. (Only the assistant-end→user gap was capped before;
// the user→assistant and tool_result→assistant gaps were not.)
const THINK_CAP_MS = 10 * 60 * 1000; // 10 minutes
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);

export function analyzeSession(sessionId: string, messages: SessionMessage[]): SessionAnalysis {
  const mainMessages = messages.filter(m => !m.isSidechain);
  const allAssistant = mainMessages.filter(m => m.type === 'assistant');

  if (mainMessages.length === 0) {
    return emptyAnalysis(sessionId);
  }

  // Legacy 4-phase (backward compat)
  const segments = detectPhases(mainMessages);
  const stats = computeStats(segments);

  // Enhanced 5-phase
  const enhancedSegments = detectEnhancedPhases(mainMessages);
  const enhancedStats = computeEnhancedStats(enhancedSegments);

  const tokens = extractTokens(allAssistant);
  const models = extractModels(allAssistant);
  const tools = extractTools(allAssistant);
  const cacheHitRate = computeCacheHitRate(tokens);
  const toolLatencies = extractToolLatencies(mainMessages);
  const turnMetrics = extractTurnMetrics(mainMessages);
  const contextTrend = extractContextTrend(allAssistant);

  const totalCost = computeSessionCost(allAssistant);
  const turnCount = turnMetrics.length;
  const avgResponseMs = turnCount > 0
    ? turnMetrics.reduce((s, t) => s + t.responseMs, 0) / turnCount
    : 0;

  const summary = extractSummary(messages);
  const startTime = segments.length > 0 ? segments[0].startTime : Date.parse(mainMessages[0].timestamp);
  const endTime = segments.length > 0 ? segments[segments.length - 1].endTime : Date.parse(mainMessages[mainMessages.length - 1].timestamp);
  const durationMs = endTime - startTime;

  const activeMs = Math.max(0, durationMs - enhancedStats.humanAway);
  const costPerMinuteUsd = activeMs > 0 ? totalCost / (activeMs / 60000) : 0;

  const stuckLoops = extractStuckLoops(mainMessages);
  const warmupCost = extractWarmupCost(allAssistant);

  return {
    sessionId,
    summary,
    startTime,
    endTime,
    durationMs,
    segments,
    stats,
    tokens,
    cacheHitRate,
    models,
    tools,
    enhancedStats,
    enhancedSegments,
    toolLatencies,
    turnMetrics,
    turnCount,
    avgResponseMs,
    estimatedCostUsd: totalCost,
    costPerMinuteUsd,
    contextTrend,
    stuckLoops,
    warmupCost,
  };
}

// ── Legacy 4-phase detection (unchanged, for backward compat) ──

function detectPhases(messages: SessionMessage[]): TimeSegment[] {
  const segments: TimeSegment[] = [];
  let planModeActive = false;
  const activeSubagents = new Map<string, number>();
  let lastAssistantTime: number | null = null;
  let currentPhaseStart: number | null = null;
  let currentPhase: PhaseType = 'coding';

  function emitSegment(phase: PhaseType, start: number, end: number) {
    if (end <= start) return;
    segments.push({ phase, startTime: start, endTime: end, durationMs: end - start });
  }

  function closeCurrentPhase(atTime: number) {
    if (currentPhaseStart !== null && atTime > currentPhaseStart) {
      emitSegment(currentPhase, currentPhaseStart, atTime);
    }
    currentPhaseStart = atTime;
  }

  for (const msg of messages) {
    const ts = Date.parse(msg.timestamp);
    if (isNaN(ts)) continue;

    if (msg.type === 'user' && lastAssistantTime !== null) {
      const gap = ts - lastAssistantTime;
      if (gap >= IDLE_THRESHOLD_MS) {
        closeCurrentPhase(lastAssistantTime);
        emitSegment('idle', lastAssistantTime, ts);
        currentPhaseStart = ts;
        currentPhase = planModeActive ? 'planning' : 'coding';
        lastAssistantTime = null;
      }
    }

    if (msg.type === 'assistant') {
      lastAssistantTime = ts;
      const contents = getContentArray(msg);
      for (const c of contents) {
        if (c.type !== 'tool_use') continue;
        if (c.name === 'EnterPlanMode') {
          if (!planModeActive) { closeCurrentPhase(ts); planModeActive = true; currentPhase = 'planning'; }
        } else if (c.name === 'ExitPlanMode') {
          if (planModeActive) { closeCurrentPhase(ts); planModeActive = false; currentPhase = 'coding'; }
        } else if (c.name && SUBAGENT_TOOLS.has(c.name) && c.id) {
          activeSubagents.set(c.id, ts);
          if (activeSubagents.size === 1) { closeCurrentPhase(ts); currentPhase = 'subagent'; }
        }
      }
    }

    if (msg.type === 'user') {
      const contents = getContentArray(msg);
      for (const c of contents) {
        if (c.type === 'tool_result' && c.tool_use_id && activeSubagents.has(c.tool_use_id)) {
          activeSubagents.delete(c.tool_use_id);
          if (activeSubagents.size === 0) { closeCurrentPhase(ts); currentPhase = planModeActive ? 'planning' : 'coding'; }
        }
      }
      if (!planModeActive) {
        const text = getTextContent(msg);
        if (text.includes('Plan mode is active')) { closeCurrentPhase(ts); planModeActive = true; currentPhase = 'planning'; }
      }
    }

    if (currentPhaseStart === null) {
      currentPhaseStart = ts;
      currentPhase = planModeActive ? 'planning' : 'coding';
    }
  }

  const lastTs = Date.parse(messages[messages.length - 1].timestamp);
  if (currentPhaseStart !== null && lastTs > currentPhaseStart) {
    emitSegment(currentPhase, currentPhaseStart, lastTs);
  }

  return segments;
}

// ── Enhanced 5-phase detection ──

function detectEnhancedPhases(messages: SessionMessage[]): EnhancedTimeSegment[] {
  const segments: EnhancedTimeSegment[] = [];
  let planModeActive = false;

  // Track pending tool_use calls: id -> { name, timestamp }
  const pendingTools = new Map<string, { name: string; ts: number }>();
  // Track pending subagent calls (Task/Agent tool): id -> { name, timestamp }
  const pendingSubagents = new Map<string, { name: string; ts: number }>();

  let lastAssistantEndTs: number | null = null;
  let lastExternalUserTs: number | null = null;
  let lastToolResultTs: number | null = null;

  function emit(phase: EnhancedPhaseType, start: number, end: number, toolName?: string) {
    if (end <= start) return;
    segments.push({ phase, startTime: start, endTime: end, durationMs: end - start, toolName });
  }

  // Emit a "Claude thinking" (or planning) slice, capped at THINK_CAP_MS. Any
  // excess is a mid-turn suspension, not thinking, so it's booked as humanAway.
  function emitThink(start: number, end: number) {
    const phase: EnhancedPhaseType = planModeActive ? 'planning' : 'claudeThink';
    if (end - start <= THINK_CAP_MS) {
      emit(phase, start, end);
    } else {
      emit(phase, start, start + THINK_CAP_MS);
      emit('humanAway', start + THINK_CAP_MS, end);
    }
  }

  for (const msg of messages) {
    const ts = Date.parse(msg.timestamp);
    if (isNaN(ts)) continue;

    if (msg.type === 'user') {
      const contents = getContentArray(msg);
      const hasToolResult = contents.some(c => c.type === 'tool_result');

      if (hasToolResult) {
        // This is a tool_result message — attribute time from tool_use to now as toolExec or subagent
        for (const c of contents) {
          if (c.type !== 'tool_result' || !c.tool_use_id) continue;

          if (pendingSubagents.has(c.tool_use_id)) {
            const { name, ts: startTs } = pendingSubagents.get(c.tool_use_id)!;
            emit('subagent', startTs, ts, name);
            pendingSubagents.delete(c.tool_use_id);
          } else if (pendingTools.has(c.tool_use_id)) {
            const { name, ts: startTs } = pendingTools.get(c.tool_use_id)!;
            emit('toolExec', startTs, ts, name);
            pendingTools.delete(c.tool_use_id);
          }
        }
        lastToolResultTs = ts;
      } else {
        // External user message (typed by human)
        if (lastAssistantEndTs !== null) {
          const gap = ts - lastAssistantEndTs;
          emit(gap < IDLE_THRESHOLD_MS ? 'humanWait' : 'humanAway', lastAssistantEndTs, ts);
        }
        lastExternalUserTs = ts;
        lastAssistantEndTs = null;
        lastToolResultTs = null;
      }

      // Plan mode detection
      if (!planModeActive) {
        const text = getTextContent(msg);
        if (text.includes('Plan mode is active')) {
          planModeActive = true;
        }
      }
    }

    if (msg.type === 'assistant') {
      const contents = getContentArray(msg);

      // Gap from last external user message → this assistant = Claude thinking (first response)
      if (lastExternalUserTs !== null) {
        emitThink(lastExternalUserTs, ts);
        lastExternalUserTs = null;
      }
      // Gap from last tool_result → this assistant = Claude thinking (mid-turn, processing results)
      else if (lastToolResultTs !== null) {
        emitThink(lastToolResultTs, ts);
      }

      lastAssistantEndTs = ts;
      lastToolResultTs = null;

      // Track tool_use calls
      for (const c of contents) {
        if (c.type !== 'tool_use' || !c.id) continue;

        if (c.name === 'EnterPlanMode') {
          planModeActive = true;
        } else if (c.name === 'ExitPlanMode') {
          planModeActive = false;
        } else if (c.name && SUBAGENT_TOOLS.has(c.name)) {
          pendingSubagents.set(c.id, { name: c.name, ts });
        } else {
          pendingTools.set(c.id, { name: c.name ?? 'unknown', ts });
        }
      }
    }
  }

  return segments;
}

/** Wall-clock union (ms) of possibly-overlapping [start, end] spans. */
export function unionMs(spans: Array<[number, number]>): number {
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

function computeEnhancedStats(segments: EnhancedTimeSegment[]): EnhancedStats {
  const stats: EnhancedStats = { humanWait: 0, humanAway: 0, claudeThink: 0, toolExec: 0, subagent: 0, planning: 0 };

  // claudeThink / planning / humanWait / humanAway are emitted as sequential,
  // non-overlapping slices, so summing them is correct. But toolExec and
  // subagent emit one segment PER tool/agent — when calls are fanned out in
  // parallel (e.g. 5 review subagents from a single assistant turn) those
  // segments overlap, and summing them double-counts the concurrency. Aggregate
  // those two by WALL-CLOCK UNION instead so the breakdown reflects real elapsed
  // time (and the active-time percentages stay a true partition that sums to
  // <=100%, instead of e.g. 109%).
  const subSpans: Array<[number, number]> = [];
  const toolSpans: Array<[number, number]> = [];
  for (const seg of segments) {
    if (seg.phase === 'subagent') subSpans.push([seg.startTime, seg.endTime]);
    else if (seg.phase === 'toolExec') toolSpans.push([seg.startTime, seg.endTime]);
    else stats[seg.phase] += seg.durationMs;
  }

  // subagent = wall-clock with >=1 subagent open.
  // toolExec  = wall-clock busy with a tool but NOT already counted as subagent
  //             (subagent wins on the rare cross-kind overlap, e.g. Agent + Bash
  //             dispatched in the same turn), so the two never double-count.
  const subagentMs = unionMs(subSpans);
  const busyMs = unionMs([...subSpans, ...toolSpans]);
  stats.subagent = subagentMs;
  stats.toolExec = Math.max(0, busyMs - subagentMs);
  return stats;
}

// ── Tool latency extraction ──

function extractToolLatencies(messages: SessionMessage[]): ToolLatency[] {
  // Build map of tool_use_id -> { name, startTs }
  const toolStarts = new Map<string, { name: string; ts: number }>();
  const toolDurations = new Map<string, number[]>(); // name -> durations[]

  for (const msg of messages) {
    const ts = Date.parse(msg.timestamp);
    if (isNaN(ts)) continue;

    if (msg.type === 'assistant') {
      for (const c of getContentArray(msg)) {
        if (c.type === 'tool_use' && c.id && c.name) {
          toolStarts.set(c.id, { name: c.name, ts });
        }
      }
    }

    if (msg.type === 'user') {
      for (const c of getContentArray(msg)) {
        if (c.type === 'tool_result' && c.tool_use_id) {
          const start = toolStarts.get(c.tool_use_id);
          if (start) {
            const duration = Math.max(0, ts - start.ts);
            if (!toolDurations.has(start.name)) toolDurations.set(start.name, []);
            toolDurations.get(start.name)!.push(duration);
            toolStarts.delete(c.tool_use_id);
          }
        }
      }
    }
  }

  const latencies: ToolLatency[] = [];
  for (const [name, durations] of toolDurations) {
    durations.sort((a, b) => a - b);
    const count = durations.length;
    const totalMs = durations.reduce((s, d) => s + d, 0);
    latencies.push({
      name,
      count,
      totalMs,
      avgMs: totalMs / count,
      p50Ms: durations[Math.floor(count * 0.5)],
      p95Ms: durations[Math.floor(count * 0.95)],
    });
  }

  latencies.sort((a, b) => b.avgMs - a.avgMs);
  return latencies;
}

// ── Turn metrics ──

function extractTurnMetrics(messages: SessionMessage[]): TurnMetrics[] {
  const turns: TurnMetrics[] = [];
  let turnIndex = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type !== 'user') continue;

    // Skip tool_result messages (not external user input)
    const contents = getContentArray(msg);
    if (contents.some(c => c.type === 'tool_result')) continue;

    const userTs = Date.parse(msg.timestamp);
    if (isNaN(userTs)) continue;

    // Find next assistant message
    let assistantMsg: SessionMessage | null = null;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].type === 'assistant') {
        assistantMsg = messages[j];
        break;
      }
    }

    if (!assistantMsg) continue;
    const assistantTs = Date.parse(assistantMsg.timestamp);
    if (isNaN(assistantTs)) continue;

    const usage = assistantMsg.message?.usage;
    turns.push({
      turnIndex: turnIndex++,
      userTimestamp: userTs,
      assistantTimestamp: assistantTs,
      responseMs: Math.max(0, assistantTs - userTs),
      inputTokens: usage?.input_tokens || 0,
      outputTokens: usage?.output_tokens || 0,
      cacheRead: usage?.cache_read_input_tokens || 0,
      cacheCreation: usage?.cache_creation_input_tokens || 0,
    });
  }

  return turns;
}

// ── Context trend ──

function extractContextTrend(assistantMessages: SessionMessage[]): number[] {
  const trend: number[] = [];
  // Deduplicated assistant messages already — each represents one API call
  for (const msg of assistantMessages) {
    const u = msg.message?.usage;
    if (!u) continue;
    const total = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    trend.push(total);
  }
  return trend;
}

// ── Cost estimation ──

function computeSessionCost(assistantMessages: SessionMessage[]): number {
  let total = 0;
  for (const msg of assistantMessages) {
    const usage = msg.message?.usage;
    const model = msg.message?.model;
    if (!usage) continue;
    total += estimateCost(model || 'sonnet', usage);
  }
  return total;
}

// ── Stuck loop detection ──

function extractStuckLoops(messages: SessionMessage[]): StuckLoop[] {
  // Build ordered list of tool calls with error status
  interface ToolCall {
    toolName: string;
    startTs: number;
    endTs: number;
    isError: boolean;
  }

  const toolStarts = new Map<string, { name: string; ts: number }>();
  const calls: ToolCall[] = [];

  for (const msg of messages) {
    const ts = Date.parse(msg.timestamp);
    if (isNaN(ts)) continue;

    if (msg.type === 'assistant') {
      for (const c of getContentArray(msg)) {
        if (c.type === 'tool_use' && c.id && c.name) {
          toolStarts.set(c.id, { name: c.name, ts });
        }
      }
    }

    if (msg.type === 'user') {
      for (const c of getContentArray(msg)) {
        if (c.type === 'tool_result' && c.tool_use_id) {
          const start = toolStarts.get(c.tool_use_id);
          if (start) {
            calls.push({
              toolName: start.name,
              startTs: start.ts,
              endTs: ts,
              isError: c.is_error === true,
            });
            toolStarts.delete(c.tool_use_id);
          }
        }
      }
    }
  }

  // Walk calls and detect consecutive chains of same tool with errors
  const loops: StuckLoop[] = [];
  let chainStart = 0;

  while (chainStart < calls.length) {
    const toolName = calls[chainStart].toolName;
    let chainEnd = chainStart;

    // Extend chain while same tool and prior calls errored
    while (chainEnd + 1 < calls.length
      && calls[chainEnd + 1].toolName === toolName
      && calls[chainEnd].isError) {
      chainEnd++;
    }

    // Count failures in this chain
    const chainCalls = calls.slice(chainStart, chainEnd + 1);
    const failures = chainCalls.filter(c => c.isError).length;

    if (failures >= 2) {
      loops.push({
        toolName,
        attempts: chainCalls.length,
        failures,
        durationMs: chainCalls[chainCalls.length - 1].endTs - chainCalls[0].startTs,
        startTime: chainCalls[0].startTs,
        endTime: chainCalls[chainCalls.length - 1].endTs,
        resolved: !chainCalls[chainCalls.length - 1].isError,
      });
    }

    chainStart = chainEnd + 1;
  }

  return loops;
}

// ── Warmup cost extraction ──

function extractWarmupCost(assistantMessages: SessionMessage[]): WarmupCost {
  if (assistantMessages.length === 0) {
    return { warmupCostUsd: 0, steadyAvgCostUsd: 0, warmupCacheCreation: 0, turnCount: 0 };
  }

  const costs: number[] = [];
  for (const msg of assistantMessages) {
    const usage = msg.message?.usage;
    const model = msg.message?.model;
    if (!usage) continue;
    costs.push(estimateCost(model || 'sonnet', usage));
  }

  if (costs.length === 0) {
    return { warmupCostUsd: 0, steadyAvgCostUsd: 0, warmupCacheCreation: 0, turnCount: 0 };
  }

  const warmupCostUsd = costs[0];
  const steadyAvgCostUsd = costs.length > 1
    ? costs.slice(1).reduce((s, c) => s + c, 0) / (costs.length - 1)
    : 0;

  const firstUsage = assistantMessages.find(m => m.message?.usage)?.message?.usage;
  const warmupCacheCreation = firstUsage?.cache_creation_input_tokens || 0;

  return {
    warmupCostUsd,
    steadyAvgCostUsd,
    warmupCacheCreation,
    turnCount: costs.length,
  };
}

// ── Shared helpers ──

function extractSummary(messages: SessionMessage[]): string {
  for (const m of messages) {
    if (m.type === 'summary' && m.summary) return m.summary;
  }
  return 'Untitled session';
}

function computeStats(segments: TimeSegment[]): PhaseStats {
  const stats: PhaseStats = { planning: 0, coding: 0, subagent: 0, idle: 0 };
  for (const seg of segments) {
    stats[seg.phase] += seg.durationMs;
  }
  return stats;
}

function extractTokens(assistantMessages: SessionMessage[]) {
  let input = 0, output = 0, cacheRead = 0, cacheCreation = 0;
  for (const msg of assistantMessages) {
    const u = msg.message?.usage;
    if (!u) continue;
    input += u.input_tokens || 0;
    output += u.output_tokens || 0;
    cacheRead += u.cache_read_input_tokens || 0;
    cacheCreation += u.cache_creation_input_tokens || 0;
  }
  return { input, output, cacheRead, cacheCreation };
}

function extractModels(assistantMessages: SessionMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of assistantMessages) {
    const model = msg.message?.model;
    if (!model) continue;
    const short = shortenModel(model);
    if (!short) continue;
    counts[short] = (counts[short] || 0) + 1;
  }
  return counts;
}

function shortenModel(model: string): string {
  if (model.includes('opus')) return 'Opus';
  if (model.includes('sonnet')) return 'Sonnet';
  if (model.includes('haiku')) return 'Haiku';
  if (model.startsWith('<')) return '';
  return model;
}

function extractTools(assistantMessages: SessionMessage[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const msg of assistantMessages) {
    const contents = getContentArray(msg);
    for (const c of contents) {
      if (c.type === 'tool_use' && c.name) {
        counts[c.name] = (counts[c.name] || 0) + 1;
      }
    }
  }
  return counts;
}

function getContentArray(msg: SessionMessage): MessageContent[] {
  const content = msg.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

function getTextContent(msg: SessionMessage): string {
  const content = msg.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === 'text').map(c => c.text || '').join(' ');
  }
  return '';
}

function computeCacheHitRate(tokens: { input: number; cacheRead: number; cacheCreation: number }): number {
  const total = tokens.input + tokens.cacheRead + tokens.cacheCreation;
  if (total === 0) return 0;
  return tokens.cacheRead / total;
}

function emptyAnalysis(sessionId: string): SessionAnalysis {
  return {
    sessionId,
    summary: 'Empty session',
    startTime: 0,
    endTime: 0,
    durationMs: 0,
    segments: [],
    stats: { planning: 0, coding: 0, subagent: 0, idle: 0 },
    tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    cacheHitRate: 0,
    models: {},
    tools: {},
    enhancedStats: { humanWait: 0, humanAway: 0, claudeThink: 0, toolExec: 0, subagent: 0, planning: 0 },
    enhancedSegments: [],
    toolLatencies: [],
    turnMetrics: [],
    turnCount: 0,
    avgResponseMs: 0,
    estimatedCostUsd: 0,
    costPerMinuteUsd: 0,
    contextTrend: [],
    stuckLoops: [],
    warmupCost: { warmupCostUsd: 0, steadyAvgCostUsd: 0, warmupCacheCreation: 0, turnCount: 0 },
  };
}
