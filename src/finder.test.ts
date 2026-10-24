import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { encodeProjectPath } from './finder.js';

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

  // integration — regression: current Claude Code session files begin with a
  // long run of `queue-operation` records (well past 32KB) before the first
  // real message. The old 32KB read cap counted zero user/assistant messages,
  // so filterMainSessions (messageCount > 2) dropped EVERY session → "No
  // sessions found." countJsonlMessages must find the real messages regardless
  // of how much precedes them.
  it('should count messages after a >32KB run of queue-operation records', async () => {
    const dir = join(tmpdir(), 'cctime-test-finder-queueop');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    // Build a header of queue-operation records larger than 32KB.
    const queueOps: string[] = [];
    let bytes = 0;
    let i = 0;
    while (bytes < 40_000) {
      const line = JSON.stringify({
        type: 'queue-operation',
        timestamp: '2026-01-01T00:00:00Z',
        uuid: `q${i}`,
        data: { type: 'enqueue', padding: 'x'.repeat(64) },
      });
      queueOps.push(line);
      bytes += line.length + 1;
      i++;
    }

    const realMessages = [
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:00Z', uuid: 'u1', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-01-01T00:01:01Z', uuid: 'a1', requestId: 'req_1', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }),
      JSON.stringify({ type: 'user', timestamp: '2026-01-01T00:01:02Z', uuid: 'u2', message: { role: 'user', content: 'thanks' } }),
    ];

    const jsonl = join(dir, 'queueop.jsonl');
    writeFileSync(jsonl, [...queueOps, ...realMessages].join('\n') + '\n');

    const { countJsonlMessages } = await import('./finder.js');
    const count = await countJsonlMessages(jsonl);
    // Must clear the filterMainSessions `> 2` bar so the session is NOT dropped.
    expect(count).toBeGreaterThan(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('finder: encodeProjectPath', () => {
  // unit — regression: Claude Code encodes EVERY non-alphanumeric char to `-`,
  // not just `/`. Encoding only `/` meant `--project` filtering silently
  // matched nothing for any path containing a `.` or `_`.
  it('should encode dots to dashes so dotted paths match the on-disk dir', () => {
    // /Users/me/.config -> -Users-me--config (dot and both slashes become `-`)
    expect(encodeProjectPath('/Users/me/.config')).toBe('-Users-me--config');
  });

  it('should encode underscores to dashes', () => {
    expect(encodeProjectPath('/Users/me/my_project')).toBe('-Users-me-my-project');
  });

  it('should still encode plain slashes (no regression)', () => {
    expect(encodeProjectPath('/Users/me/plain')).toBe('-Users-me-plain');
  });

  // functional — the encoded filter must be a suffix of the real on-disk dir
  // name Claude Code would create for a dotted project path.
  it('should produce a suffix that matches the real projects dir name', () => {
    const projectPath = '/Users/me/.vim/plugin_dir';
    const onDiskDirName = '-Users-me--vim-plugin-dir'; // what Claude Code writes
    expect(onDiskDirName.endsWith(encodeProjectPath(projectPath))).toBe(true);
  });
});
