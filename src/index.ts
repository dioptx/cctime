#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { program } from 'commander';
import { getLastSession, getAllSessions, getCurrentSessionId, getTodaySessions, getWeekSessions, getMonthSessions, getSessionsSince, getSessionById } from './finder.js';
import { parseSession } from './parser.js';
import { analyzeSession } from './analyzer.js';
import { formatSession, formatAggregate, formatCompact, formatCsv, formatMarkdown, formatJsonAggregate } from './formatter.js';
import { startLiveMode, startAggregateLiveMode } from './live.js';
import type { SessionIndexEntry, SessionAnalysis } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

async function analyzeEntry(entry: SessionIndexEntry): Promise<SessionAnalysis> {
  const messages = await parseSession(entry.fullPath);
  const analysis = analyzeSession(entry.sessionId, messages);
  if (analysis.summary === 'Untitled session' && entry.summary) {
    analysis.summary = entry.summary;
  }
  return analysis;
}

async function analyzeEntries(entries: SessionIndexEntry[]): Promise<SessionAnalysis[]> {
  const results: SessionAnalysis[] = [];
  const BATCH_SIZE = 50;
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(analyzeEntry));
    results.push(...batchResults);
  }
  return results;
}

function parseDate(input: string): number {
  if (input === 'today') {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  if (input === 'yesterday') {
    const d = new Date(); d.setDate(d.getDate() - 1); d.setHours(0, 0, 0, 0); return d.getTime();
  }
  const ms = Date.parse(input);
  if (isNaN(ms)) {
    console.error(`Invalid date: "${input}". Use ISO format (2026-02-15), "today", or "yesterday".`);
    process.exit(1);
  }
  return ms;
}

type SortField = 'cost' | 'duration' | 'tokens' | 'turns' | 'time';

function sortAnalyses(analyses: SessionAnalysis[], field: SortField): SessionAnalysis[] {
  const sorted = [...analyses];
  switch (field) {
    case 'cost': return sorted.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd);
    case 'duration': return sorted.sort((a, b) =>
      Math.max(0, b.durationMs - b.enhancedStats.humanAway) -
      Math.max(0, a.durationMs - a.enhancedStats.humanAway));
    case 'tokens': return sorted.sort((a, b) =>
      (b.tokens.input + b.tokens.output + b.tokens.cacheRead + b.tokens.cacheCreation) -
      (a.tokens.input + a.tokens.output + a.tokens.cacheRead + a.tokens.cacheCreation));
    case 'turns': return sorted.sort((a, b) => b.turnCount - a.turnCount);
    case 'time': default: return sorted.sort((a, b) => b.startTime - a.startTime);
  }
}

function filterAnalyses(analyses: SessionAnalysis[], opts: {
  model?: string;
  minDuration?: string;
  minCost?: string;
}): SessionAnalysis[] {
  let filtered = analyses;

  if (opts.model) {
    const modelLower = opts.model.toLowerCase();
    filtered = filtered.filter(a => {
      return Object.keys(a.models).some(m => m.toLowerCase().includes(modelLower));
    });
  }

  if (opts.minDuration) {
    const minMs = parseFloat(opts.minDuration) * 60000;
    filtered = filtered.filter(a => {
      const activeMs = Math.max(0, a.durationMs - a.enhancedStats.humanAway);
      return activeMs >= minMs;
    });
  }

  if (opts.minCost) {
    const minUsd = parseFloat(opts.minCost);
    filtered = filtered.filter(a => a.estimatedCostUsd >= minUsd);
  }

  return filtered;
}

function outputAnalyses(analyses: SessionAnalysis[], label: string, opts: {
  json?: boolean;
  compact?: boolean;
  csv?: boolean;
  markdown?: boolean;
  sort?: string;
}): void {
  let sorted = opts.sort ? sortAnalyses(analyses, opts.sort as SortField) : analyses;

  if (opts.csv) {
    console.log(formatCsv(sorted));
  } else if (opts.markdown) {
    console.log(formatMarkdown(sorted));
  } else if (opts.compact) {
    console.log(formatCompact(sorted));
  } else if (opts.json) {
    console.log(JSON.stringify(formatJsonAggregate(sorted), null, 2));
  } else {
    console.log(formatAggregate(sorted, label));
  }
}

program
  .name('cctime')
  .description('Real-time Claude Code session analytics — live dashboard, time breakdown, cost tracking')
  .version(pkg.version)
  .option('--all', 'All sessions today')
  .option('--day', 'Today\'s sessions')
  .option('--week', 'Weekly rollup')
  .option('--month', 'Monthly rollup (30 days)')
  .option('--live', 'Live-updating dashboard (watches active session)')
  .option('--session <id>', 'Analyze a specific session by ID (or prefix)')
  .option('--since <date>', 'Sessions since date (ISO, "today", "yesterday")')
  .option('--until <date>', 'Sessions until date')
  .option('--project <path>', 'Filter by project path')
  .option('--model <name>', 'Filter by model (e.g., opus, sonnet, haiku)')
  .option('--min-duration <mins>', 'Minimum active duration in minutes')
  .option('--min-cost <usd>', 'Minimum cost in USD')
  .option('--sort <field>', 'Sort by: cost, duration, tokens, turns, time (default)')
  .option('--json', 'Machine-readable JSON output')
  .option('--compact', 'One-line-per-session view')
  .option('--csv', 'CSV export (pipe-friendly)')
  .option('--markdown', 'Markdown table export')
  .option('--no-color', 'Disable color output')
  .option('--color', 'Force color output')
  .action(async (opts) => {
    // Wire color flags to env vars for chalk
    if (opts.color === false) process.env.NO_COLOR = '1';
    if (opts.color === true) process.env.FORCE_COLOR = '1';

    try {
      // Live mode — single session (no period flag)
      if (opts.live && !opts.day && !opts.all && !opts.week && !opts.month && !opts.since) {
        await startLiveMode(opts.project);
        return;
      }

      // Single session by ID
      if (opts.session) {
        const entry = await getSessionById(opts.session, opts.project);
        if (!entry) {
          console.error(`Session not found: "${opts.session}"`);
          console.error('Use --all or --week to list available sessions.');
          process.exit(1);
        }
        const analysis = await analyzeEntry(entry);
        if (opts.csv || opts.compact || opts.markdown) {
          outputAnalyses([analysis], 'Session', opts);
        } else if (opts.json) {
          console.log(JSON.stringify(analysis, null, 2));
        } else {
          console.log(formatSession(analysis));
        }
        return;
      }

      // Date range queries
      let entries: SessionIndexEntry[];
      let label: string;

      if (opts.since) {
        const sinceMs = parseDate(opts.since);
        const untilMs = opts.until ? parseDate(opts.until) : undefined;
        entries = await getSessionsSince(sinceMs, opts.project, untilMs);
        const sinceStr = new Date(sinceMs).toLocaleDateString();
        label = untilMs ? `${sinceStr} — ${new Date(untilMs).toLocaleDateString()}` : `Since ${sinceStr}`;
      } else if (opts.month) {
        entries = await getMonthSessions(opts.project);
        label = 'This Month';
      } else if (opts.week) {
        entries = await getWeekSessions(opts.project);
        label = 'This Week';
      } else if (opts.day || opts.all) {
        entries = await getTodaySessions(opts.project);
        label = 'Today';
      } else {
        // Default: the CURRENT session if we're running inside one, else the
        // most recently active. Prefer CLAUDE_CODE_SESSION_ID so `cctime` (no
        // args) reports the session you're actually in — not whichever
        // concurrent session happened to write its file last. Resolve the
        // current id via getSessionById (the same authoritative lookup --session
        // uses): it matches by id and skips the messageCount>2 "main session"
        // filter, which can otherwise drop an active session whose cached index
        // count is stale/low.
        const currentId = getCurrentSessionId();
        let entry: SessionIndexEntry | null = currentId
          ? await getSessionById(currentId, opts.project)
          : null;
        if (!entry) {
          const all = await getAllSessions(opts.project);
          if (all.length === 0) {
            console.error('No sessions found.');
            console.error('Try running Claude Code first to create session files.');
            process.exit(1);
          }
          entry = all[0];
          // Heads-up when the pick is ambiguous: several sessions were written
          // to in the last few minutes, so "most recent" may not be the one you
          // mean. (Silent when we matched the current session — that's exact.)
          const ACTIVE_WINDOW_MS = 5 * 60 * 1000;
          const now = Date.now();
          const recentlyActive = all.filter(e => now - new Date(e.modified).getTime() < ACTIVE_WINDOW_MS);
          if (recentlyActive.length > 1) {
            console.error(`cctime: ${recentlyActive.length} sessions were active in the last 5 min; showing the most recent (${entry.sessionId.slice(0, 8)}). Use --session <id> to pick another.`);
          }
        }
        const analysis = await analyzeEntry(entry);
        if (opts.csv || opts.compact || opts.markdown) {
          outputAnalyses([analysis], 'Session', opts);
        } else if (opts.json) {
          console.log(JSON.stringify(analysis, null, 2));
        } else {
          console.log(formatSession(analysis));
        }
        return;
      }

      // Aggregate live mode — live-updating view of the period
      if (opts.live) {
        let getEntries: () => Promise<SessionIndexEntry[]>;
        if (opts.since) {
          const sinceMs = parseDate(opts.since);
          const untilMs = opts.until ? parseDate(opts.until) : undefined;
          getEntries = () => getSessionsSince(sinceMs, opts.project, untilMs);
        } else if (opts.month) {
          getEntries = () => getMonthSessions(opts.project);
        } else if (opts.week) {
          getEntries = () => getWeekSessions(opts.project);
        } else {
          getEntries = () => getTodaySessions(opts.project);
        }
        await startAggregateLiveMode(getEntries, label, opts.project);
        return;
      }

      if (entries.length === 0) {
        console.error('No sessions found matching your filters.');
        console.error('Try running Claude Code first, or adjust --since/--project filters.');
        process.exit(1);
      }

      let analyses = await analyzeEntries(entries);
      const totalBefore = analyses.length;
      analyses = filterAnalyses(analyses, opts);

      if (analyses.length === 0 && totalBefore > 0) {
        console.error(`Found ${totalBefore} sessions but all were filtered out.`);
        if (opts.minDuration) console.error(`  --min-duration ${opts.minDuration}: try a lower threshold`);
        if (opts.minCost) console.error(`  --min-cost ${opts.minCost}: try a lower threshold`);
        if (opts.model) console.error(`  --model ${opts.model}: no sessions used this model`);
        process.exit(1);
      }

      outputAnalyses(analyses, label, opts);
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  });

program.parse();
