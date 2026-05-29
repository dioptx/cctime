import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import type { SessionMessage, MessageContent } from './types.js';

const RELEVANT_TYPES = new Set(['assistant', 'user', 'progress', 'summary', 'system']);

export async function parseSession(filePath: string): Promise<SessionMessage[]> {
  const { messages } = await parseSessionFrom(filePath, 0);
  return messages;
}

export async function parseSessionFrom(
  filePath: string,
  byteOffset: number,
): Promise<{ messages: SessionMessage[]; bytesRead: number }> {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;

  if (byteOffset >= fileSize) {
    return { messages: [], bytesRead: byteOffset };
  }

  const rawMessages: SessionMessage[] = [];
  const stream = createReadStream(filePath, { encoding: 'utf-8', start: byteOffset });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  let lastCompleteOffset = byteOffset;
  let currentOffset = byteOffset;
  let isFirstLine = byteOffset > 0;

  for await (const line of rl) {
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // +1 for newline
    currentOffset += lineBytes;

    // When starting mid-file, the first "line" may be a partial — skip it
    if (isFirstLine) {
      isFirstLine = false;
      try {
        JSON.parse(line);
      } catch {
        lastCompleteOffset = currentOffset;
        continue;
      }
    }

    if (!line.trim()) {
      lastCompleteOffset = currentOffset;
      continue;
    }
    try {
      const obj = JSON.parse(line);
      lastCompleteOffset = currentOffset;
      if (!RELEVANT_TYPES.has(obj.type)) continue;
      if (!obj.timestamp) continue;
      rawMessages.push(obj as SessionMessage);
    } catch {
      // Might be a partial line at EOF — don't advance lastCompleteOffset
    }
  }

  return { messages: deduplicateAssistant(rawMessages), bytesRead: lastCompleteOffset };
}

/**
 * Group assistant messages by requestId, merge content arrays, keep single usage.
 * Streaming chunks share a requestId but each reports the same usage — counting
 * all of them inflates tokens ~2-3x.
 *
 * Fallback: when a transcript omits `requestId` on assistant rows (older Claude
 * Code versions, or partial logs), the streaming chunks still share `message.id`,
 * so we group by `requestId ?? message.id`. Without this, those un-keyed rows pass
 * straight through and re-introduce the very inflation this function exists to
 * prevent. Rows with neither key still pass through unchanged.
 */
function deduplicateAssistant(messages: SessionMessage[]): SessionMessage[] {
  const result: SessionMessage[] = [];
  const requestMap = new Map<string, SessionMessage>();
  const requestOrder: string[] = [];

  const flush = () => {
    for (const key of requestOrder) {
      result.push(requestMap.get(key)!);
    }
    requestMap.clear();
    requestOrder.length = 0;
  };

  for (const msg of messages) {
    const key = msg.type === 'assistant' ? (msg.requestId ?? msg.message?.id) : undefined;
    if (!key) {
      // Non-assistant message, or an assistant row with no usable group key:
      // flush any pending group (preserve ordering) and pass through as-is.
      flush();
      result.push(msg);
      continue;
    }

    if (requestMap.has(key)) {
      mergeAssistantChunk(requestMap.get(key)!, msg);
    } else {
      const clone: SessionMessage = {
        ...msg,
        message: msg.message
          ? { ...msg.message, content: msg.message.content ? copyContent(msg.message.content) : undefined }
          : undefined,
      };
      requestMap.set(key, clone);
      requestOrder.push(key);
    }
  }

  flush();
  return result;
}

function mergeAssistantChunk(target: SessionMessage, source: SessionMessage): void {
  // Use the latest timestamp
  if (source.timestamp > target.timestamp) {
    target.timestamp = source.timestamp;
  }

  // Merge content arrays
  const targetContent = getContentArray(target);
  const sourceContent = getContentArray(source);

  for (const sc of sourceContent) {
    const isDuplicate = targetContent.some(
      tc => tc.type === sc.type && tc.id && tc.id === sc.id,
    );
    if (!isDuplicate) {
      targetContent.push(sc);
    }
  }

  if (target.message) {
    target.message.content = targetContent;
  }

  // Keep the usage with the highest output tokens (last chunk has final count)
  if (source.message?.usage && target.message) {
    const su = source.message.usage;
    const tu = target.message.usage;
    if (!tu || su.output_tokens > tu.output_tokens) {
      target.message.usage = su;
    }
  }

  if (source.message?.model && target.message && !target.message.model) {
    target.message.model = source.message.model;
  }
}

function getContentArray(msg: SessionMessage): MessageContent[] {
  const content = msg.message?.content;
  if (Array.isArray(content)) return content;
  return [];
}

function copyContent(content: string | MessageContent[]): string | MessageContent[] {
  if (typeof content === 'string') return content;
  return content.map(c => ({ ...c }));
}
