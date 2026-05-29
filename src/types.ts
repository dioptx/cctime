// --- Legacy types (backward compat for --json) ---

export type PhaseType = 'planning' | 'coding' | 'subagent' | 'idle';

export interface PhaseStats {
  planning: number;
  coding: number;
  subagent: number;
  idle: number;
}

// --- Enhanced types (v2) ---

export type EnhancedPhaseType = 'humanWait' | 'humanAway' | 'claudeThink' | 'toolExec' | 'subagent' | 'planning';

export interface EnhancedStats {
  humanWait: number;
  humanAway: number;
  claudeThink: number;
  toolExec: number;
  subagent: number;
  planning: number;
}

export interface ToolLatency {
  name: string;
  count: number;
  totalMs: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
}

export interface TurnMetrics {
  turnIndex: number;
  userTimestamp: number;
  assistantTimestamp: number;
  responseMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheCreation: number;
}

// --- Shared types ---

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface MessageContent {
  type: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  text?: string;
  content?: string | MessageContent[];
  is_error?: boolean;
}

export interface StuckLoop {
  toolName: string;
  attempts: number;
  failures: number;
  durationMs: number;
  startTime: number;
  endTime: number;
  resolved: boolean;
}

export interface WarmupCost {
  warmupCostUsd: number;
  steadyAvgCostUsd: number;
  warmupCacheCreation: number;
  turnCount: number;
}

export interface SessionMessage {
  type: 'assistant' | 'user' | 'progress' | 'summary' | 'system' | 'file-history-snapshot' | 'queue-operation';
  timestamp: string;
  uuid: string;
  requestId?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    model?: string;
    usage?: TokenUsage;
    content?: string | MessageContent[];
  };
  data?: {
    type?: string;
  };
  summary?: string;
}

export interface TimeSegment {
  phase: PhaseType;
  startTime: number;
  endTime: number;
  durationMs: number;
}

export interface EnhancedTimeSegment {
  phase: EnhancedPhaseType;
  startTime: number;
  endTime: number;
  durationMs: number;
  toolName?: string;
}

export interface SessionAnalysis {
  sessionId: string;
  summary: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  segments: TimeSegment[];
  stats: PhaseStats;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  cacheHitRate: number;
  models: Record<string, number>;
  tools: Record<string, number>;
  // Enhanced v2 fields
  enhancedStats: EnhancedStats;
  enhancedSegments: EnhancedTimeSegment[];
  toolLatencies: ToolLatency[];
  turnMetrics: TurnMetrics[];
  turnCount: number;
  avgResponseMs: number;
  estimatedCostUsd: number;
  costPerMinuteUsd: number;
  contextTrend: number[];
  stuckLoops: StuckLoop[];
  warmupCost: WarmupCost;
}

export interface SessionIndexEntry {
  sessionId: string;
  fullPath: string;
  fileMtime?: number;
  created: string;
  modified: string;
  summary: string;
  messageCount: number;
  projectPath: string;
  isSidechain?: boolean;
}

export interface SessionIndex {
  version: number;
  entries: SessionIndexEntry[];
}

export interface AggregateJson {
  summary: {
    sessionCount: number;
    totalCostUsd: number;
    totalActiveMs: number;
    totalDurationMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    totalTurns: number;
    warmupOverheadUsd: number;
    stuckLoopSessions: number;
    stuckLoopTotal: number;
    stuckLoopAvgRetries: number;
  };
  sessions: SessionAnalysis[];
}
