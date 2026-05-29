import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// We test the filtering logic that should exist
// Problem: buildIndexFromFiles gives messageCount=10 to all sessions, so micro-sessions sneak through

describe('finder: session filtering', () => {
  it('should expose a way to get actual message count from JSONL', async () => {
    // This test documents the requirement:
    // When no sessions-index.json exists, we should count actual messages
    // not hardcode messageCount=10
    const dir = join(tmpdir(), 'cctime-test-finder');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Write a JSONL with only 1 real message
    const jsonl = join(dir, 'tiny.jsonl');
    writeFileSync(jsonl, [
      JSON.stringify({ type: 'system', timestamp: '2026-01-01T00:00:00Z' }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:00:01Z', uuid: 'u1', message: { role: 'user', content: 'hi' } }),
    ].join('\n') + '\n');

    // Import dynamically to test the logic
    const { countJsonlMessages } = await import('./finder.js');
    const count = await countJsonlMessages(jsonl);
    // Should be 1 (only user message), not 10
    expect(count).toBeLessThanOrEqual(2);
  });
});

describe('finder: current session detection', () => {
  const KEY = 'CLAUDE_CODE_SESSION_ID';
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[KEY]; });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('returns CLAUDE_CODE_SESSION_ID when running inside a Claude Code session', async () => {
    const { getCurrentSessionId } = await import('./finder.js');
    process.env[KEY] = 'abc123-def';
    expect(getCurrentSessionId()).toBe('abc123-def');
  });

  it('returns undefined when the env var is unset or blank', async () => {
    const { getCurrentSessionId } = await import('./finder.js');
    delete process.env[KEY];
    expect(getCurrentSessionId()).toBeUndefined();
    process.env[KEY] = '   ';
    expect(getCurrentSessionId()).toBeUndefined();
  });
});
