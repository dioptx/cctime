import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseSession } from './parser.js';

const TMP = join(tmpdir(), 'cctime-test-parser');

function setup() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
}

function writeJsonl(name: string, lines: object[]): string {
  const path = join(TMP, name);
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

describe('parser: token deduplication', () => {
  it('should merge assistant chunks with same requestId into one message', async () => {
    setup();
    const path = writeJsonl('dedup.jsonl', [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', uuid: 'a1', requestId: 'req_1', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'chunk1' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', uuid: 'a2', requestId: 'req_1', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'chunk2' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', uuid: 'a3', requestId: 'req_1', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'Read' }] } },
    ]);

    const messages = await parseSession(path);
    const assistants = messages.filter(m => m.type === 'assistant');

    // Should be 1 merged message, not 3
    expect(assistants).toHaveLength(1);

    // Should have the highest output_tokens (80, from last chunk)
    expect(assistants[0].message?.usage?.output_tokens).toBe(80);

    // Should have merged content (text + text + tool_use)
    const content = assistants[0].message?.content;
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) {
      expect(content.length).toBe(3);
      expect(content.map(c => c.type)).toEqual(['text', 'text', 'tool_use']);
    }
  });

  it('should NOT merge assistant messages with different requestIds', async () => {
    setup();
    const path = writeJsonl('no-dedup.jsonl', [
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', uuid: 'a1', requestId: 'req_1', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'response 1' }] } },
      { type: 'user', timestamp: '2026-01-01T00:00:02Z', uuid: 'u1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', uuid: 'a2', requestId: 'req_2', message: { role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'response 2' }] } },
    ]);

    const messages = await parseSession(path);
    const assistants = messages.filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(2);
  });

  it('should merge chunks that lack requestId by falling back to message.id', async () => {
    // Some transcripts omit requestId on assistant rows; the streaming chunks
    // still share message.id. Without the fallback these would NOT be merged and
    // their (identical) usage would be summed downstream — the ~2-3x inflation.
    setup();
    const path = writeJsonl('dedup-no-reqid.jsonl', [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1', message: { role: 'user', content: 'hello' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'chunk1' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:02Z', uuid: 'a2', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'chunk2' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', uuid: 'a3', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 80, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', id: 'tu_1', name: 'Read' }] } },
    ]);

    const messages = await parseSession(path);
    const assistants = messages.filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(1);
    expect(assistants[0].message?.usage?.output_tokens).toBe(80);
  });

  it('should NOT merge no-requestId assistants with different message.ids', async () => {
    setup();
    const path = writeJsonl('no-dedup-msgid.jsonl', [
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', uuid: 'a1', message: { id: 'msg_1', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'response 1' }] } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', uuid: 'a2', message: { id: 'msg_2', role: 'assistant', model: 'claude-opus-4-6', usage: { input_tokens: 200, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'response 2' }] } },
    ]);

    const messages = await parseSession(path);
    const assistants = messages.filter(m => m.type === 'assistant');
    expect(assistants).toHaveLength(2);
  });

  it('should handle empty file', async () => {
    setup();
    const path = writeJsonl('empty.jsonl', []);
    // writeJsonl writes '\n' for empty array
    const messages = await parseSession(path);
    expect(messages).toHaveLength(0);
  });

  it('should handle file with all invalid JSON lines', async () => {
    setup();
    const path = join(TMP, 'invalid.jsonl');
    writeFileSync(path, 'not json\nalso not json\n{broken\n');
    const messages = await parseSession(path);
    expect(messages).toHaveLength(0);
  });

  it('should handle string content messages', async () => {
    setup();
    const path = writeJsonl('string-content.jsonl', [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1', message: { role: 'user', content: 'just a string, not array' } },
      { type: 'assistant', timestamp: '2026-01-01T00:00:01Z', uuid: 'a1', requestId: 'req_1', message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: 'plain text response' } },
    ]);
    const messages = await parseSession(path);
    expect(messages).toHaveLength(2);
  });

  it('should filter out irrelevant message types', async () => {
    setup();
    const path = writeJsonl('mixed.jsonl', [
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u1', message: { role: 'user', content: 'hi' } },
      { type: 'file-history-snapshot', timestamp: '2026-01-01T00:00:01Z', uuid: 'f1' },
      { type: 'queue-operation', timestamp: '2026-01-01T00:00:02Z', uuid: 'q1' },
      { type: 'assistant', timestamp: '2026-01-01T00:00:03Z', uuid: 'a1', requestId: 'req_1', message: { role: 'assistant', model: 'claude-sonnet-4-5', usage: { input_tokens: 50, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [{ type: 'text', text: 'hi' }] } },
    ]);
    const messages = await parseSession(path);
    // file-history-snapshot and queue-operation should be filtered out
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.type)).toEqual(['user', 'assistant']);
  });

  it('should skip messages without timestamp', async () => {
    setup();
    const path = writeJsonl('no-ts.jsonl', [
      { type: 'user', uuid: 'u1', message: { role: 'user', content: 'no timestamp' } },
      { type: 'user', timestamp: '2026-01-01T00:00:00Z', uuid: 'u2', message: { role: 'user', content: 'has timestamp' } },
    ]);
    const messages = await parseSession(path);
    expect(messages).toHaveLength(1);
  });
});
