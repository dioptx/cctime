import chalk from 'chalk';
import type { SessionAnalysis, EnhancedStats, EnhancedTimeSegment, AggregateJson, StuckLoop, WarmupCost } from './types.js';
import { unionMs } from './analyzer.js';

const BAR_WIDTH = 20;

// Active phases (shown in main chart, % of active time)
type ActivePhase = 'claudeThink' | 'toolExec' | 'subagent' | 'planning' | 'humanWait';
const activePhaseOrder: ActivePhase[] = ['claudeThink', 'toolExec', 'subagent', 'planning', 'humanWait'];

const eColors: Record<ActivePhase, (s: string) => string> = {
  claudeThink: chalk.blue,
  toolExec: chalk.yellow,
  subagent: chalk.magenta,
  planning: chalk.cyan,
  humanWait: chalk.gray,
};

const eLabels: Record<ActivePhase, string> = {
  claudeThink: 'Claude thinking',
  toolExec: 'Tool execution',
  subagent: 'Subagents',
  planning: 'Planning',
  humanWait: 'Waiting on you',
};

// ── Shared helpers ──

function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  if (totalSec < 3600) {
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return sec > 0 ? `${min}m ${sec}s` : `${min}m`;
  }
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  let hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'pm' : 'am';
  hours = hours % 12 || 12;
  return `${hours}:${mins}${ampm}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncName(name: string, maxLen: number = 12): string {
  if (name.length <= maxLen) return name.padEnd(maxLen);
  return name.slice(0, maxLen - 1) + '\u2026';
}

function renderBar(fraction: number, color: (s: string) => string): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  return color('\u2588'.repeat(filled)) + chalk.gray('\u2591'.repeat(empty));
}

function renderSparkline(values: number[]): string {
  if (values.length === 0) return '';
  const chars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  // Show last 10 values
  const recent = values.slice(-10);
  return recent.map(v => {
    const idx = Math.round(((v - min) / range) * (chars.length - 1));
    return chars[idx];
  }).join('');
}

function renderCacheBar(rate: number): string {
  const chars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const barLen = 10;
  const clamped = Math.max(0, Math.min(1, rate));
  const filled = Math.round(clamped * barLen);
  return Array.from({ length: barLen }, (_, i) => {
    const level = i < filled ? Math.min(Math.floor((i / barLen) * chars.length) + 2, chars.length - 1) : 0;
    return chars[level];
  }).join('');
}

function displaySummary(summary: string, startTime: number): string {
  const trimmed = summary.trim();
  if (!trimmed || /^untitled\s*session$/i.test(trimmed)) {
    const d = new Date(startTime);
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const month = months[d.getMonth()];
    const day = d.getDate();
    const hours = d.getHours() % 12 || 12;
    const mins = d.getMinutes().toString().padStart(2, '0');
    const ampm = d.getHours() >= 12 ? 'pm' : 'am';
    return `${month} ${day}, ${hours}:${mins}${ampm} session`;
  }
  return trimmed.length > 42 ? trimmed.slice(0, 41) + '\u2026' : trimmed;
}

function hr(label: string, width: number = 56): string {
  const padded = ` ${label} `;
  const remaining = width - padded.length - 3;
  return chalk.gray(' \u2500\u2500' + padded + '\u2500'.repeat(Math.max(0, remaining)));
}

// ── Single session (enhanced) ──

export function formatSession(analysis: SessionAnalysis): string {
  const lines: string[] = [];
  const { enhancedStats, durationMs } = analysis;
  const activeMs = Math.max(0, durationMs - enhancedStats.humanAway);

  // Header
  lines.push('');
  const awayNote = enhancedStats.humanAway > 0
    ? chalk.gray(` (${formatDuration(enhancedStats.humanAway)} away)`)
    : '';
  lines.push(` ${chalk.bold('cctime')}${chalk.gray(' · ' + formatTime(Date.now()) + ' · ')}${chalk.bold(formatDuration(activeMs))} active${chalk.gray(' of ' + formatDuration(durationMs))}${awayNote}`);

  // Time Breakdown (% of active time)
  lines.push('');
  lines.push(hr('Time Breakdown'));

  for (const phase of activePhaseOrder) {
    const ms = enhancedStats[phase];
    if (ms === 0 && activeMs > 0) continue;
    const fraction = activeMs > 0 ? ms / activeMs : 0;
    const pct = Math.round(fraction * 100);
    const bar = renderBar(fraction, eColors[phase]);
    const label = eLabels[phase].padEnd(16);
    const durStr = formatDuration(ms).padStart(5);
    lines.push(` ${label}${bar} ${durStr}  (${String(pct).padStart(2)}%)`);
  }

  // Tokens & Cost
  lines.push('');
  lines.push(hr('Tokens & Cost'));

  const { tokens } = analysis;
  const totalTok = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation;
  if (totalTok > 0) {
    const inFrac = (tokens.input + tokens.cacheRead + tokens.cacheCreation) / totalTok;
    const inBar = Math.round(inFrac * BAR_WIDTH);
    const outBar = BAR_WIDTH - inBar;
    lines.push(` Tokens  ${chalk.cyan('\u2588'.repeat(inBar))}${chalk.green('\u2588'.repeat(outBar))}  ${chalk.cyan(formatTokens(tokens.input + tokens.cacheRead + tokens.cacheCreation) + ' in')} ${chalk.green(formatTokens(tokens.output) + ' out')}`);
  }
  const cachePct = Math.round(analysis.cacheHitRate * 100);
  lines.push(` Cache   ${renderCacheBar(analysis.cacheHitRate)}  ${cachePct}% hit`);
  lines.push(` Cost    ~${formatCost(analysis.estimatedCostUsd)}  (${formatCost(analysis.costPerMinuteUsd)}/min)   Avg response: ${formatLatency(analysis.avgResponseMs)}   Turns: ${analysis.turnCount}`);

  // Models
  const modelEntries = Object.entries(analysis.models).sort((a, b) => b[1] - a[1]);
  const totalMessages = modelEntries.reduce((s, [, n]) => s + n, 0);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push(hr('Models'));
    for (const [name, count] of modelEntries) {
      const frac = count / totalMessages;
      const pct = Math.round(frac * 100);
      const bar = renderBar(frac, name === 'Opus' ? chalk.magenta : name === 'Haiku' ? chalk.green : chalk.blue);
      lines.push(` ${name.padEnd(8)} ${bar} ${String(pct).padStart(3)}%  (${count} calls)`);
    }
  }

  // Tool usage (by call count, with bars)
  const toolEntries = Object.entries(analysis.tools).sort((a, b) => b[1] - a[1]);
  if (toolEntries.length > 0) {
    lines.push('');
    lines.push(hr('Tools'));

    const maxCalls = toolEntries[0][1];
    const top8 = toolEntries.slice(0, 8);
    for (const [name, count] of top8) {
      const frac = count / maxCalls;
      const bar = renderBar(frac, chalk.yellow);
      const latency = analysis.toolLatencies.find(t => t.name === name);
      const latStr = latency ? chalk.gray(` avg ${formatLatency(latency.avgMs)}`) : '';
      lines.push(` ${truncName(name)} ${bar} ${String(count).padStart(4)} calls${latStr}`);
    }
    if (toolEntries.length > 8) {
      lines.push(chalk.gray(`  + ${toolEntries.length - 8} more tools`));
    }
  }

  // Session footer
  lines.push('');
  lines.push(hr('Session'));

  const summary = displaySummary(analysis.summary, analysis.startTime);
  lines.push(` ${chalk.cyan(summary)}`);

  const sparkline = renderSparkline(analysis.contextTrend);
  lines.push(` Context: ${sparkline}`);

  // Insights section
  const insightLines = formatInsights(analysis.stuckLoops, analysis.warmupCost, analysis.enhancedSegments);
  if (insightLines.length > 0) {
    lines.push('');
    lines.push(hr('Insights'));
    lines.push(...insightLines);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Live mode variant ──

export function formatSessionLive(analysis: SessionAnalysis): string {
  const lines: string[] = [];
  const { enhancedStats, durationMs } = analysis;
  const activeMs = Math.max(0, durationMs - enhancedStats.humanAway);

  // Header with LIVE badge
  lines.push('');
  const awayNote = enhancedStats.humanAway > 0
    ? chalk.gray(` (${formatDuration(enhancedStats.humanAway)} away)`)
    : '';
  lines.push(` ${chalk.bold('cctime')} \u00b7 ${chalk.bgRed.white.bold(' LIVE ')}    ${chalk.bold(formatDuration(activeMs))} active${chalk.gray(' of ' + formatDuration(durationMs))}${awayNote}`);

  // Time Breakdown (% of active time)
  lines.push('');
  lines.push(hr('Time Breakdown'));

  for (const phase of activePhaseOrder) {
    const ms = enhancedStats[phase];
    if (ms === 0 && activeMs > 0) continue;
    const fraction = activeMs > 0 ? ms / activeMs : 0;
    const pct = Math.round(fraction * 100);
    const bar = renderBar(fraction, eColors[phase]);
    const label = eLabels[phase].padEnd(16);
    const durStr = formatDuration(ms).padStart(5);
    lines.push(` ${label}${bar} ${durStr}  (${String(pct).padStart(2)}%)`);
  }

  // Tokens & Cost
  lines.push('');
  lines.push(hr('Tokens & Cost'));

  const { tokens: liveTok } = analysis;
  const liveTotalTok = liveTok.input + liveTok.output + liveTok.cacheRead + liveTok.cacheCreation;
  if (liveTotalTok > 0) {
    const inFrac = (liveTok.input + liveTok.cacheRead + liveTok.cacheCreation) / liveTotalTok;
    const inBar = Math.round(inFrac * BAR_WIDTH);
    const outBar = BAR_WIDTH - inBar;
    lines.push(` Tokens  ${chalk.cyan('\u2588'.repeat(inBar))}${chalk.green('\u2588'.repeat(outBar))}  ${chalk.cyan(formatTokens(liveTok.input + liveTok.cacheRead + liveTok.cacheCreation) + ' in')} ${chalk.green(formatTokens(liveTok.output) + ' out')}`);
  }
  const liveCachePct = Math.round(analysis.cacheHitRate * 100);
  lines.push(` Cache   ${renderCacheBar(analysis.cacheHitRate)}  ${liveCachePct}% hit`);
  lines.push(` Cost    ~${formatCost(analysis.estimatedCostUsd)}  (${formatCost(analysis.costPerMinuteUsd)}/min)   Avg response: ${formatLatency(analysis.avgResponseMs)}   Turns: ${analysis.turnCount}`);

  // Tools (compact for live mode)
  const liveToolEntries = Object.entries(analysis.tools).sort((a, b) => b[1] - a[1]);
  if (liveToolEntries.length > 0) {
    lines.push('');
    lines.push(hr('Tools'));
    const liveMaxCalls = liveToolEntries[0][1];
    for (const [name, count] of liveToolEntries.slice(0, 6)) {
      const frac = count / liveMaxCalls;
      const bar = renderBar(frac, chalk.yellow);
      const latency = analysis.toolLatencies.find(t => t.name === name);
      const latStr = latency ? chalk.gray(` avg ${formatLatency(latency.avgMs)}`) : '';
      lines.push(` ${truncName(name)} ${bar} ${String(count).padStart(4)} calls${latStr}`);
    }
  }

  // Stuck indicator (live mode — one line per active/recent loop)
  if (analysis.stuckLoops && analysis.stuckLoops.length > 0) {
    for (const loop of analysis.stuckLoops) {
      lines.push(` ${chalk.yellow('\u26a0')} ${chalk.yellow(loop.toolName)} stuck (${loop.attempts} retries, ${formatDuration(loop.durationMs)})`);
    }
  }

  // Footer
  lines.push('');
  const liveSummary = displaySummary(analysis.summary, analysis.startTime);
  const liveModelEntries = Object.entries(analysis.models).sort((a, b) => b[1] - a[1]);
  const liveTotalMsgs = liveModelEntries.reduce((s, [, n]) => s + n, 0);
  const liveModelStr = liveTotalMsgs > 0
    ? liveModelEntries.map(([name, count]) => `${name} ${Math.round((count / liveTotalMsgs) * 100)}%`).join(' \u00b7 ')
    : '';
  lines.push(` ${chalk.cyan(liveSummary)}  ${chalk.gray(liveModelStr)}  Context: ${renderSparkline(analysis.contextTrend)}`);
  lines.push(chalk.gray(' Ctrl+C to exit'));

  lines.push('');
  return lines.join('\n');
}

// ── Aggregate (enhanced) ──

export function formatAggregate(analyses: SessionAnalysis[], label: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(` ${chalk.bold('cctime')}${chalk.gray(' \u00b7 ' + label)}`);
  lines.push(`  ${analyses.length} sessions`);

  // Aggregate enhanced stats
  const totalEnhanced: EnhancedStats = { humanWait: 0, humanAway: 0, claudeThink: 0, toolExec: 0, subagent: 0, planning: 0 };
  let totalDuration = 0;
  let totalTokensIn = 0, totalTokensOut = 0;
  let totalCost = 0;
  const allModels: Record<string, number> = {};
  const allTools: Record<string, number> = {};
  const allToolLatencies = new Map<string, { totalMs: number; count: number }>();

  for (const a of analyses) {
    totalDuration += a.durationMs;
    for (const phase of activePhaseOrder) {
      totalEnhanced[phase] += a.enhancedStats[phase];
    }
    totalEnhanced.humanAway += a.enhancedStats.humanAway;
    totalTokensIn += a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation;
    totalTokensOut += a.tokens.output;
    totalCost += a.estimatedCostUsd;
    for (const [m, c] of Object.entries(a.models)) allModels[m] = (allModels[m] || 0) + c;
    for (const [t, c] of Object.entries(a.tools)) allTools[t] = (allTools[t] || 0) + c;
    for (const tl of a.toolLatencies) {
      const existing = allToolLatencies.get(tl.name) || { totalMs: 0, count: 0 };
      existing.totalMs += tl.totalMs;
      existing.count += tl.count;
      allToolLatencies.set(tl.name, existing);
    }
  }

  const totalActive = Math.max(0, totalDuration - totalEnhanced.humanAway);

  // Time breakdown
  lines.push('');
  lines.push(hr('Time Breakdown'));
  const awayAgg = totalEnhanced.humanAway > 0 ? chalk.gray(` (${formatDuration(totalEnhanced.humanAway)} away)`) : '';
  lines.push(`  ${chalk.bold(formatDuration(totalActive))} active${chalk.gray(' of ' + formatDuration(totalDuration))}${awayAgg}`);
  lines.push('');

  for (const phase of activePhaseOrder) {
    const ms = totalEnhanced[phase];
    if (ms === 0) continue;
    const fraction = totalActive > 0 ? ms / totalActive : 0;
    const pct = Math.round(fraction * 100);
    const bar = renderBar(fraction, eColors[phase]);
    const label = eLabels[phase].padEnd(16);
    lines.push(` ${label}${bar} ${formatDuration(ms).padStart(5)}  (${String(pct).padStart(2)}%)`);
  }

  // Tokens & Cost (with bars, matching single-session style)
  lines.push('');
  lines.push(hr('Tokens & Cost'));

  const aggTotalTok = totalTokensIn + totalTokensOut;
  if (aggTotalTok > 0) {
    const inFrac = totalTokensIn / aggTotalTok;
    const inBar = Math.round(inFrac * BAR_WIDTH);
    const outBar = BAR_WIDTH - inBar;
    lines.push(` Tokens  ${chalk.cyan('\u2588'.repeat(inBar))}${chalk.green('\u2588'.repeat(outBar))}  ${chalk.cyan(formatTokens(totalTokensIn) + ' in')} ${chalk.green(formatTokens(totalTokensOut) + ' out')}`);
  }
  const avgCost = analyses.length > 0 ? totalCost / analyses.length : 0;
  lines.push(` Cost    ~${formatCost(totalCost)}  (${analyses.length} sessions, avg ${formatCost(avgCost)}/session)`);

  // Models (with bars)
  const modelEntries = Object.entries(allModels).sort((a, b) => b[1] - a[1]);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push(hr('Models'));
    const totalModelCalls = modelEntries.reduce((s, [, n]) => s + n, 0);
    for (const [name, count] of modelEntries) {
      const frac = count / totalModelCalls;
      const pct = Math.round(frac * 100);
      const bar = renderBar(frac, name === 'Opus' ? chalk.magenta : name === 'Haiku' ? chalk.green : chalk.blue);
      lines.push(` ${name.padEnd(8)} ${bar} ${String(pct).padStart(3)}%  (${count} calls)`);
    }
  }

  // Tools (with bars and latency)
  const toolEntries = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (toolEntries.length > 0) {
    lines.push('');
    lines.push(hr('Tools'));
    const maxCalls = toolEntries[0][1];
    for (const [name, count] of toolEntries) {
      const frac = count / maxCalls;
      const bar = renderBar(frac, chalk.yellow);
      const latData = allToolLatencies.get(name);
      const latStr = latData && latData.count > 0
        ? chalk.gray(` avg ${formatLatency(latData.totalMs / latData.count)}`)
        : '';
      lines.push(` ${truncName(name)} ${bar} ${String(count).padStart(4)} calls${latStr}`);
    }
  }

  // Activity heatmap (hourly distribution)
  lines.push('');
  lines.push(hr('Activity'));

  const hourlyMs = new Array(24).fill(0);
  for (const a of analyses) {
    const startHour = new Date(a.startTime).getHours();
    const activeMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    hourlyMs[startHour] += activeMs;
  }
  const maxHourMs = Math.max(...hourlyMs, 1);
  const sparkChars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const heatmap = hourlyMs.map(ms => {
    if (ms === 0) return chalk.gray('\u2581');
    const idx = Math.round((ms / maxHourMs) * (sparkChars.length - 1));
    return chalk.cyan(sparkChars[idx]);
  }).join('');
  lines.push(`  ${heatmap}`);
  lines.push(chalk.gray('  12a  3a  6a  9a  12p  3p  6p  9p'));

  // Daily breakdown (for multi-day views like --week)
  const dayBuckets = new Map<string, { active: number; cost: number; sessions: number; turns: number }>();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  for (const a of analyses) {
    const d = new Date(a.startTime);
    const key = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    const existing = dayBuckets.get(key) || { active: 0, cost: 0, sessions: 0, turns: 0 };
    existing.active += Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    existing.cost += a.estimatedCostUsd;
    existing.sessions += 1;
    existing.turns += a.turnCount;
    dayBuckets.set(key, existing);
  }

  if (dayBuckets.size > 1) {
    lines.push('');
    const sortedDays = [...dayBuckets.entries()].sort((a, b) => {
      const [ay, am, ad] = a[0].split('/').map(Number);
      const [by, bm, bd] = b[0].split('/').map(Number);
      return ay !== by ? ay - by : am !== bm ? am - bm : ad - bd;
    });
    const maxDayActive = Math.max(...sortedDays.map(([, v]) => v.active), 1);
    for (const [dateStr, data] of sortedDays) {
      const [year, month, day] = dateStr.split('/').map(Number);
      const probe = new Date(year, month - 1, day);
      const dayName = dayNames[probe.getDay()];
      const frac = data.active / maxDayActive;
      const barLen = Math.round(frac * 12);
      const bar = chalk.cyan('\u2588'.repeat(barLen)) + chalk.gray('\u2591'.repeat(12 - barLen));
      lines.push(`  ${dayName} ${String(day).padStart(2)} ${bar} ${formatDuration(data.active).padStart(5)}  ${formatCost(data.cost).padStart(6)}  ${chalk.gray(data.sessions + ' sess · ' + data.turns + ' turns')}`);
    }
  }

  // Aggregate insights
  const aggInsightLines = formatAggregateInsights(analyses);
  if (aggInsightLines.length > 0) {
    lines.push('');
    lines.push(hr('Insights'));
    lines.push(...aggInsightLines);
  }

  lines.push('');
  return lines.join('\n');
}

// ── Aggregate live mode ──

export function formatAggregateLive(analyses: SessionAnalysis[], label: string): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(` ${chalk.bold('cctime')} \u00b7 ${chalk.bgRed.white.bold(' LIVE ')}${chalk.gray(' \u00b7 ' + label)}`);
  lines.push(`  ${analyses.length} sessions`);

  // Aggregate enhanced stats
  const totalEnhanced: EnhancedStats = { humanWait: 0, humanAway: 0, claudeThink: 0, toolExec: 0, subagent: 0, planning: 0 };
  let totalDuration = 0;
  let totalTokensIn = 0, totalTokensOut = 0;
  let totalCost = 0;
  const allModels: Record<string, number> = {};
  const allTools: Record<string, number> = {};
  const allToolLatencies = new Map<string, { totalMs: number; count: number }>();

  for (const a of analyses) {
    totalDuration += a.durationMs;
    for (const phase of activePhaseOrder) {
      totalEnhanced[phase] += a.enhancedStats[phase];
    }
    totalEnhanced.humanAway += a.enhancedStats.humanAway;
    totalTokensIn += a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation;
    totalTokensOut += a.tokens.output;
    totalCost += a.estimatedCostUsd;
    for (const [m, c] of Object.entries(a.models)) allModels[m] = (allModels[m] || 0) + c;
    for (const [t, c] of Object.entries(a.tools)) allTools[t] = (allTools[t] || 0) + c;
    for (const tl of a.toolLatencies) {
      const existing = allToolLatencies.get(tl.name) || { totalMs: 0, count: 0 };
      existing.totalMs += tl.totalMs;
      existing.count += tl.count;
      allToolLatencies.set(tl.name, existing);
    }
  }

  const totalActive = Math.max(0, totalDuration - totalEnhanced.humanAway);

  // Time breakdown
  lines.push('');
  lines.push(hr('Time Breakdown'));
  const awayAgg = totalEnhanced.humanAway > 0 ? chalk.gray(` (${formatDuration(totalEnhanced.humanAway)} away)`) : '';
  lines.push(`  ${chalk.bold(formatDuration(totalActive))} active${chalk.gray(' of ' + formatDuration(totalDuration))}${awayAgg}`);
  lines.push('');

  for (const phase of activePhaseOrder) {
    const ms = totalEnhanced[phase];
    if (ms === 0) continue;
    const fraction = totalActive > 0 ? ms / totalActive : 0;
    const pct = Math.round(fraction * 100);
    const bar = renderBar(fraction, eColors[phase]);
    const pLabel = eLabels[phase].padEnd(16);
    lines.push(` ${pLabel}${bar} ${formatDuration(ms).padStart(5)}  (${String(pct).padStart(2)}%)`);
  }

  // Tokens & Cost
  lines.push('');
  lines.push(hr('Tokens & Cost'));

  const aggTotalTok = totalTokensIn + totalTokensOut;
  if (aggTotalTok > 0) {
    const inFrac = totalTokensIn / aggTotalTok;
    const inBar = Math.round(inFrac * BAR_WIDTH);
    const outBar = BAR_WIDTH - inBar;
    lines.push(` Tokens  ${chalk.cyan('\u2588'.repeat(inBar))}${chalk.green('\u2588'.repeat(outBar))}  ${chalk.cyan(formatTokens(totalTokensIn) + ' in')} ${chalk.green(formatTokens(totalTokensOut) + ' out')}`);
  }
  const avgCost = analyses.length > 0 ? totalCost / analyses.length : 0;
  lines.push(` Cost    ~${formatCost(totalCost)}  (${analyses.length} sessions, avg ${formatCost(avgCost)}/session)`);

  // Models
  const modelEntries = Object.entries(allModels).sort((a, b) => b[1] - a[1]);
  if (modelEntries.length > 0) {
    lines.push('');
    lines.push(hr('Models'));
    const totalModelCalls = modelEntries.reduce((s, [, n]) => s + n, 0);
    for (const [name, count] of modelEntries) {
      const frac = count / totalModelCalls;
      const pct = Math.round(frac * 100);
      const bar = renderBar(frac, name === 'Opus' ? chalk.magenta : name === 'Haiku' ? chalk.green : chalk.blue);
      lines.push(` ${name.padEnd(8)} ${bar} ${String(pct).padStart(3)}%  (${count} calls)`);
    }
  }

  // Tools
  const toolEntries = Object.entries(allTools).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (toolEntries.length > 0) {
    lines.push('');
    lines.push(hr('Tools'));
    const maxCalls = toolEntries[0][1];
    for (const [name, count] of toolEntries) {
      const frac = count / maxCalls;
      const bar = renderBar(frac, chalk.yellow);
      const latData = allToolLatencies.get(name);
      const latStr = latData && latData.count > 0
        ? chalk.gray(` avg ${formatLatency(latData.totalMs / latData.count)}`)
        : '';
      lines.push(` ${truncName(name)} ${bar} ${String(count).padStart(4)} calls${latStr}`);
    }
  }

  // Activity heatmap
  lines.push('');
  lines.push(hr('Activity'));

  const hourlyMs = new Array(24).fill(0);
  for (const a of analyses) {
    const startHour = new Date(a.startTime).getHours();
    const aMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    hourlyMs[startHour] += aMs;
  }
  const maxHourMs = Math.max(...hourlyMs, 1);
  const sparkChars = '\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588';
  const heatmap = hourlyMs.map(ms => {
    if (ms === 0) return chalk.gray('\u2581');
    const idx = Math.round((ms / maxHourMs) * (sparkChars.length - 1));
    return chalk.cyan(sparkChars[idx]);
  }).join('');
  lines.push(`  ${heatmap}`);
  lines.push(chalk.gray('  12a  3a  6a  9a  12p  3p  6p  9p'));

  // Footer
  lines.push('');
  lines.push(chalk.gray(' Ctrl+C to exit'));
  lines.push('');
  return lines.join('\n');
}

// ── Compact view (one line per session) ──

export function formatCompact(analyses: SessionAnalysis[]): string {
  const lines: string[] = [];
  lines.push(chalk.gray(' Time              Duration    Cost   Turns  Summary'));
  lines.push(chalk.gray(' ' + '\u2500'.repeat(70)));
  let totalActive = 0, totalCost = 0, totalTurns = 0;
  for (const a of analyses) {
    const time = formatTime(a.startTime);
    const activeMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    const dur = formatDuration(activeMs);
    const cost = formatCost(a.estimatedCostUsd);
    const summary = displaySummary(a.summary, a.startTime);
    lines.push(` ${time.padEnd(18)}${dur.padEnd(12)}${cost.padEnd(7)}${String(a.turnCount).padStart(5)}  ${summary}`);
    totalActive += activeMs;
    totalCost += a.estimatedCostUsd;
    totalTurns += a.turnCount;
  }
  if (analyses.length > 1) {
    lines.push(chalk.gray(' ' + '\u2500'.repeat(70)));
    lines.push(chalk.bold(` ${'Total'.padEnd(18)}${formatDuration(totalActive).padEnd(12)}${formatCost(totalCost).padEnd(7)}${String(totalTurns).padStart(5)}  ${analyses.length} sessions`));
  }
  return lines.join('\n');
}

// ── CSV export ──

export function formatCsv(analyses: SessionAnalysis[]): string {
  const lines: string[] = [];
  lines.push('timestamp,duration_min,active_min,cost_usd,tokens_in,tokens_out,turns,model,summary');
  for (const a of analyses) {
    const ts = new Date(a.startTime).toISOString();
    const durMin = (a.durationMs / 60000).toFixed(1);
    const activeMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    const activeMin = (activeMs / 60000).toFixed(1);
    const cost = a.estimatedCostUsd.toFixed(4);
    const tokIn = a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation;
    const tokOut = a.tokens.output;
    const model = Object.entries(a.models).sort((x, y) => y[1] - x[1])[0]?.[0] || '-';
    const summary = a.summary.replace(/[\r\n]+/g, ' ').replace(/"/g, '""');
    lines.push(`${ts},${durMin},${activeMin},${cost},${tokIn},${tokOut},${a.turnCount},${model},"${summary}"`);
  }
  return lines.join('\n');
}

// ── Markdown table export ──

export function formatMarkdown(analyses: SessionAnalysis[]): string {
  const lines: string[] = [];
  lines.push('| Time | Duration | Cost | Turns | Tokens In | Tokens Out | Model | Summary |');
  lines.push('|------|----------|------|-------|-----------|------------|-------|---------|');
  for (const a of analyses) {
    const time = formatTime(a.startTime);
    const activeMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    const dur = formatDuration(activeMs);
    const cost = formatCost(a.estimatedCostUsd);
    const tokIn = formatTokens(a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation);
    const tokOut = formatTokens(a.tokens.output);
    const model = Object.entries(a.models).sort((x, y) => y[1] - x[1])[0]?.[0] || '-';
    const summary = displaySummary(a.summary, a.startTime).replace(/\|/g, '\\|');
    lines.push(`| ${time} | ${dur} | ${cost} | ${a.turnCount} | ${tokIn} | ${tokOut} | ${model} | ${summary} |`);
  }
  return lines.join('\n');
}

// ── JSON aggregate envelope ──

export function formatJsonAggregate(analyses: SessionAnalysis[]): AggregateJson {
  let totalCost = 0;
  let totalActive = 0;
  let totalDuration = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let totalTurns = 0;

  for (const a of analyses) {
    totalCost += a.estimatedCostUsd;
    totalDuration += a.durationMs;
    totalActive += Math.max(0, a.durationMs - a.enhancedStats.humanAway);
    totalTokensIn += a.tokens.input + a.tokens.cacheRead + a.tokens.cacheCreation;
    totalTokensOut += a.tokens.output;
    totalTurns += a.turnCount;
  }

  // Compute aggregate insight fields
  let warmupOverheadUsd = 0;
  let stuckLoopSessions = 0;
  let stuckLoopTotal = 0;
  let stuckLoopRetries = 0;

  for (const a of analyses) {
    if (a.warmupCost && a.warmupCost.turnCount > 1) {
      warmupOverheadUsd += a.warmupCost.warmupCostUsd - a.warmupCost.steadyAvgCostUsd;
    }
    if (a.stuckLoops && a.stuckLoops.length > 0) {
      stuckLoopSessions++;
      stuckLoopTotal += a.stuckLoops.length;
      stuckLoopRetries += a.stuckLoops.reduce((s, l) => s + l.attempts, 0);
    }
  }

  return {
    summary: {
      sessionCount: analyses.length,
      totalCostUsd: Math.round(totalCost * 100) / 100,
      totalActiveMs: totalActive,
      totalDurationMs: totalDuration,
      totalTokensIn,
      totalTokensOut,
      totalTurns,
      warmupOverheadUsd: Math.round(warmupOverheadUsd * 100) / 100,
      stuckLoopSessions,
      stuckLoopTotal,
      stuckLoopAvgRetries: stuckLoopTotal > 0 ? Math.round((stuckLoopRetries / stuckLoopTotal) * 10) / 10 : 0,
    },
    sessions: analyses,
  };
}

// ── Insight helpers ──

function formatInsights(stuckLoops: StuckLoop[], warmupCost: WarmupCost, segments?: EnhancedTimeSegment[]): string[] {
  const lines: string[] = [];

  // Parallel-subagent benefit: subagent segments are aggregated by wall-clock
  // union (overlapping fan-out isn't double-counted), but the SUM still carries
  // signal \u2014 sum vs union is the speedup from running agents concurrently.
  // Shown only when \u22652 subagents actually overlapped (saved >1s), so sequential
  // sessions get no spurious line.
  if (segments && segments.length > 0) {
    const sub = segments.filter(s => s.phase === 'subagent');
    if (sub.length >= 2) {
      const sumMs = sub.reduce((acc, s) => acc + s.durationMs, 0);
      const wallMs = unionMs(sub.map(s => [s.startTime, s.endTime] as [number, number]));
      const savedMs = sumMs - wallMs;
      if (wallMs > 0 && savedMs > 1000) {
        const factor = sumMs / wallMs;
        lines.push(` ${chalk.magenta('\u26a1')} Parallel subagents: ${sub.length} ran in ${formatDuration(wallMs)} wall (${formatDuration(sumMs)} of work \u00b7 ${factor.toFixed(1)}\u00d7 concurrent \u00b7 saved ${formatDuration(savedMs)} vs sequential)`);
      }
    }
  }

  // Stuck loop warnings
  if (stuckLoops && stuckLoops.length > 0) {
    for (const loop of stuckLoops) {
      const status = loop.resolved ? 'resolved' : 'unresolved';
      lines.push(` ${chalk.yellow('\u26a0')} Stuck: ${loop.toolName} \u2014 ${loop.attempts} retries over ${formatDuration(loop.durationMs)} (${status})`);
    }
  }

  // Warmup cost (only show if > 1 turn and warmup is > 2x steady)
  if (warmupCost && warmupCost.turnCount > 1 && warmupCost.steadyAvgCostUsd > 0
    && warmupCost.warmupCostUsd > warmupCost.steadyAvgCostUsd * 2) {
    lines.push(` Warmup: ${formatCost(warmupCost.warmupCostUsd)} (turn 1)  \u2192  Steady: avg ${formatCost(warmupCost.steadyAvgCostUsd)}/turn`);
  }

  return lines;
}

function formatAggregateInsights(analyses: SessionAnalysis[]): string[] {
  const lines: string[] = [];

  // Warmup overhead across sessions
  let warmupOverhead = 0;
  let warmupSessions = 0;
  for (const a of analyses) {
    if (a.warmupCost && a.warmupCost.turnCount > 1 && a.warmupCost.steadyAvgCostUsd > 0) {
      const overhead = a.warmupCost.warmupCostUsd - a.warmupCost.steadyAvgCostUsd;
      if (overhead > 0) {
        warmupOverhead += overhead;
        warmupSessions++;
      }
    }
  }
  if (warmupSessions > 0) {
    const avgOverhead = warmupOverhead / warmupSessions;
    lines.push(` Warmup overhead: ${formatCost(warmupOverhead)} across ${warmupSessions} sessions (avg ${formatCost(avgOverhead)}/session)`);
  }

  // Stuck loop summary
  let stuckSessions = 0;
  let totalLoops = 0;
  let totalRetries = 0;
  for (const a of analyses) {
    if (a.stuckLoops && a.stuckLoops.length > 0) {
      stuckSessions++;
      totalLoops += a.stuckLoops.length;
      totalRetries += a.stuckLoops.reduce((s, l) => s + l.attempts, 0);
    }
  }
  if (stuckSessions > 0) {
    const avgRetries = Math.round((totalRetries / totalLoops) * 10) / 10;
    lines.push(` ${stuckSessions} sessions had stuck loops (${totalLoops} total, avg ${avgRetries} retries)`);
  }

  return lines;
}
