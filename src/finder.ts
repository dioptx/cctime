import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionIndex, SessionIndexEntry } from './types.js';

function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/\//g, '-');
}

const RELEVANT_TYPES = new Set(['assistant', 'user']);

/**
 * Count actual user+assistant messages in a JSONL file.
 * Reads only first few KB to keep it fast.
 */
export async function countJsonlMessages(filePath: string): Promise<number> {
  let count = 0;
  const stream = createReadStream(filePath, { encoding: 'utf-8', end: 32_768 }); // read first 32KB
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (RELEVANT_TYPES.has(obj.type)) count++;
    } catch {
      // skip
    }
  }

  return count;
}

export async function listProjectDirs(): Promise<string[]> {
  const projectsDir = getClaudeProjectsDir();
  const entries = await readdir(projectsDir, { withFileTypes: true });
  return entries
    .filter(e => e.isDirectory())
    .map(e => join(projectsDir, e.name));
}

async function readSessionIndex(projectDir: string): Promise<SessionIndex | null> {
  const indexPath = join(projectDir, 'sessions-index.json');
  try {
    const data = await readFile(indexPath, 'utf-8');
    return JSON.parse(data);
  } catch {
    return buildIndexFromFiles(projectDir);
  }
}

async function buildIndexFromFiles(projectDir: string): Promise<SessionIndex | null> {
  try {
    const files = await readdir(projectDir);
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));
    if (jsonlFiles.length === 0) return null;

    const entries: SessionIndexEntry[] = [];
    for (const file of jsonlFiles) {
      const filePath = join(projectDir, file);
      const sessionId = file.replace('.jsonl', '');
      const fileStat = await stat(filePath);

      // Skip tiny files (< 1KB = likely empty/system-only)
      if (fileStat.size < 1024) continue;

      const messageCount = await countJsonlMessages(filePath);

      entries.push({
        sessionId,
        fullPath: filePath,
        created: fileStat.birthtime.toISOString(),
        modified: fileStat.mtime.toISOString(),
        summary: '',
        messageCount,
        projectPath: '',
      });
    }
    return { version: 1, entries };
  } catch {
    return null;
  }
}

function filterMainSessions(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return entries.filter(e => !e.isSidechain && e.messageCount > 2);
}

/** The session id of the Claude Code session this process is running inside,
 *  if any. Claude Code exposes it to subprocesses as CLAUDE_CODE_SESSION_ID —
 *  this lets `cctime` (no args) default to the ACTUAL current session instead
 *  of "the most recently modified file", which loses to any concurrently-active
 *  session. Returns undefined when run outside Claude Code (e.g. a plain shell). */
export function getCurrentSessionId(): string | undefined {
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  return id && id.trim() ? id.trim() : undefined;
}

/** All main (non-sidechain) sessions across projects, most-recently-modified
 *  first. Shared by getLastSession and the no-arg default selection. */
export async function getAllSessions(projectFilter?: string): Promise<SessionIndexEntry[]> {
  const dirs = await listProjectDirs();
  let allEntries: SessionIndexEntry[] = [];

  for (const dir of dirs) {
    const index = await readSessionIndex(dir);
    if (!index) continue;
    let entries = filterMainSessions(index.entries);
    if (projectFilter) {
      const encoded = encodeProjectPath(projectFilter);
      if (!dir.endsWith(encoded)) continue;
    }
    allEntries.push(...entries);
  }

  allEntries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return allEntries;
}

export async function getLastSession(projectFilter?: string): Promise<SessionIndexEntry | null> {
  const all = await getAllSessions(projectFilter);
  return all[0] ?? null;
}

export async function getTodaySessions(projectFilter?: string): Promise<SessionIndexEntry[]> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  return getSessionsSince(todayMs, projectFilter);
}

export async function getWeekSessions(projectFilter?: string): Promise<SessionIndexEntry[]> {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  weekAgo.setHours(0, 0, 0, 0);
  return getSessionsSince(weekAgo.getTime(), projectFilter);
}

export async function getMonthSessions(projectFilter?: string): Promise<SessionIndexEntry[]> {
  const now = new Date();
  const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  monthAgo.setHours(0, 0, 0, 0);
  return getSessionsSince(monthAgo.getTime(), projectFilter);
}

export async function getSessionsSince(sinceMs: number, projectFilter?: string, untilMs?: number): Promise<SessionIndexEntry[]> {
  const dirs = await listProjectDirs();
  let allEntries: SessionIndexEntry[] = [];

  for (const dir of dirs) {
    const index = await readSessionIndex(dir);
    if (!index) continue;
    if (projectFilter) {
      const encoded = encodeProjectPath(projectFilter);
      if (!dir.endsWith(encoded)) continue;
    }
    let entries = filterMainSessions(index.entries)
      .filter(e => new Date(e.created).getTime() >= sinceMs);
    if (untilMs !== undefined) {
      entries = entries.filter(e => new Date(e.created).getTime() <= untilMs);
    }
    allEntries.push(...entries);
  }

  allEntries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
  return allEntries;
}

export async function getSessionById(sessionId: string, projectFilter?: string): Promise<SessionIndexEntry | null> {
  const dirs = await listProjectDirs();

  for (const dir of dirs) {
    if (projectFilter) {
      const encoded = encodeProjectPath(projectFilter);
      if (!dir.endsWith(encoded)) continue;
    }
    const index = await readSessionIndex(dir);
    if (!index) continue;
    const entry = index.entries.find(e => e.sessionId === sessionId || e.sessionId.startsWith(sessionId));
    if (entry) return entry;
  }

  return null;
}
