import { watch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseSession, parseSessionFrom } from './parser.js';
import { encodeProjectPath } from './finder.js';
import { analyzeSession } from './analyzer.js';
import { formatSessionLive, formatAggregateLive } from './formatter.js';
import type { SessionMessage, SessionAnalysis, SessionIndexEntry } from './types.js';

const ACTIVE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const DEBOUNCE_MS = 300;

interface ActiveSession {
  sessionId: string;
  fullPath: string;
  mtime: number;
}

export async function findActiveSession(projectFilter?: string): Promise<ActiveSession | null> {
  const projectsDir = join(homedir(), '.claude', 'projects');
  const now = Date.now();
  let best: ActiveSession | null = null;

  let dirs: string[];
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    dirs = entries.filter(e => e.isDirectory()).map(e => join(projectsDir, e.name));
  } catch {
    return null;
  }

  if (projectFilter) {
    const encoded = encodeProjectPath(projectFilter);
    dirs = dirs.filter(d => d.endsWith(encoded));
  }

  for (const dir of dirs) {
    let files: string[];
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const fullPath = join(dir, file);
      try {
        const s = await stat(fullPath);
        const mtime = s.mtime.getTime();
        if (now - mtime > ACTIVE_THRESHOLD_MS) continue;
        if (!best || mtime > best.mtime) {
          best = {
            sessionId: file.replace('.jsonl', ''),
            fullPath,
            mtime,
          };
        }
      } catch {
        continue;
      }
    }
  }

  return best;
}

export async function startLiveMode(projectFilter?: string): Promise<void> {
  const found = await findActiveSession(projectFilter);
  if (!found) {
    console.error('No active session found (modified within last 5 minutes).');
    console.error('Start a Claude Code session, then run cctime --live in another terminal.');
    process.exit(1);
  }
  let session = found;

  console.log(`Watching: ${session.fullPath}`);

  let allMessages: SessionMessage[] = [];
  let byteOffset = 0;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isRefreshing = false;

  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      const { messages: newMessages, bytesRead } = await parseSessionFrom(session.fullPath, byteOffset);
      if (newMessages.length > 0) {
        allMessages.push(...newMessages);
      }
      byteOffset = bytesRead;

      const analysis = analyzeSession(session.sessionId, allMessages);

      // Clear screen and redraw
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(formatSessionLive(analysis));
    } catch (err: any) {
      // File might be mid-write; just skip this refresh
    } finally {
      isRefreshing = false;
    }
  }

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  // Initial render
  await refresh();

  // Watch for changes
  function attachWatcher() {
    watcher = watch(session.fullPath, () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
    });
    watcher.on('error', async () => {
      // File may have been deleted — try to find new active session
      if (watcher) { watcher.close(); watcher = null; }
      const newSession = await findActiveSession(projectFilter);
      if (newSession) {
        session.fullPath = newSession.fullPath;
        session.sessionId = newSession.sessionId;
        allMessages = [];
        byteOffset = 0;
        attachWatcher();
        await refresh();
      }
    });
  }
  attachWatcher();

  // Periodic refresh for wall-clock staleness (e.g., humanWait timer)
  const periodicTimer = setInterval(refresh, 5000);

  // Graceful shutdown
  let cleaningUp = false;
  function cleanup() {
    if (cleaningUp) {
      process.exit(1);
    }
    cleaningUp = true;
    try {
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(periodicTimer);
      process.stdout.write('\x1b[?25h');
    } catch {
      // Ignore cleanup errors
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

export async function startAggregateLiveMode(
  getEntries: () => Promise<SessionIndexEntry[]>,
  label: string,
  projectFilter?: string,
): Promise<void> {
  // Find the active session to watch for changes
  const found = await findActiveSession(projectFilter);
  if (!found) {
    console.error('No active session found (modified within last 5 minutes).');
    console.error('Start a Claude Code session, then run cctime --live in another terminal.');
    process.exit(1);
  }
  const active = found;

  let activeMessages: SessionMessage[] = [];
  let byteOffset = 0;
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isRefreshing = false;

  // Cache completed session analyses (keyed by sessionId)
  const completedCache = new Map<string, SessionAnalysis>();

  async function refresh() {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      // Re-fetch entry list (picks up new sessions started during the day)
      const entries = await getEntries();

      // Parse + analyze all non-active sessions (use cache for completed ones)
      const analyses: SessionAnalysis[] = [];
      for (const entry of entries) {
        if (entry.sessionId === active.sessionId) continue;
        const cached = completedCache.get(entry.sessionId);
        if (cached) {
          analyses.push(cached);
        } else {
          const messages = await parseSession(entry.fullPath);
          const analysis = analyzeSession(entry.sessionId, messages);
          if (analysis.summary === 'Untitled session' && entry.summary) {
            analysis.summary = entry.summary;
          }
          completedCache.set(entry.sessionId, analysis);
          analyses.push(analysis);
        }
      }

      // Incrementally parse the active session
      const { messages: newMessages, bytesRead } = await parseSessionFrom(active.fullPath, byteOffset);
      if (newMessages.length > 0) {
        activeMessages.push(...newMessages);
      }
      byteOffset = bytesRead;

      const activeAnalysis = analyzeSession(active.sessionId, activeMessages);
      analyses.push(activeAnalysis);

      // Clear screen and redraw
      process.stdout.write('\x1b[2J\x1b[H');
      process.stdout.write(formatAggregateLive(analyses, label));
    } catch {
      // Skip on transient errors
    } finally {
      isRefreshing = false;
    }
  }

  // Hide cursor
  process.stdout.write('\x1b[?25l');

  // Initial render
  await refresh();

  // Watch active session file for changes
  watcher = watch(active.fullPath, () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(refresh, DEBOUNCE_MS);
  });
  watcher.on('error', () => {
    // Ignore — periodic refresh will keep updating
  });

  // Periodic refresh (picks up new sessions, updates wall-clock timers)
  const periodicTimer = setInterval(refresh, 5000);

  let cleaningUp = false;
  function cleanup() {
    if (cleaningUp) {
      process.exit(1);
    }
    cleaningUp = true;
    try {
      if (watcher) { watcher.close(); watcher = null; }
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(periodicTimer);
      process.stdout.write('\x1b[?25h');
    } catch {
      // Ignore cleanup errors
    } finally {
      process.exit(0);
    }
  }

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}
