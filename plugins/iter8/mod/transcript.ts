export type AppendedRow = {
  uuid: string;
  door: string;
  agentId?: string;
  origin: { kind: string };
  message: { type: string; content: readonly { type: string; text?: string }[] };
};

export type TranscriptRow = { key: string; role: 'user' | 'assistant'; text: string; at: string };

export const TRANSCRIPT_BATCH_MAX = 50;
export const MESSAGE_MAX_CHARS = 32000;

function cut(text: string): string {
  if (text.length <= MESSAGE_MAX_CHARS) return text;
  const head = text.slice(0, MESSAGE_MAX_CHARS);
  const last = head.charCodeAt(head.length - 1);
  // A lone surrogate does not survive UTF-8 encoding, so the cut never splits a pair.
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

function rowText(row: AppendedRow): string {
  return row.message.content
    .flatMap(block => (block.type === 'text' && typeof block.text === 'string' && block.text !== '' ? [block.text] : []))
    .join('\n\n');
}

export function transcriptRow(row: AppendedRow, at: string): TranscriptRow | null {
  if (row.agentId !== undefined && row.agentId !== null) return null;
  let role: TranscriptRow['role'];
  if (row.door === 'prompt') {
    if (row.origin.kind !== 'composer' && row.origin.kind !== 'bridge') return null;
    role = 'user';
  } else if (row.door === 'response') {
    if (row.message.type !== 'assistant') return null;
    role = 'assistant';
  } else {
    return null;
  }
  const text = rowText(row);
  if (text.trim() === '') return null;
  return { key: row.uuid, role, text: cut(text), at };
}

export function batches(rows: readonly TranscriptRow[]): TranscriptRow[][] {
  const groups: TranscriptRow[][] = [];
  for (let i = 0; i < rows.length; i += TRANSCRIPT_BATCH_MAX) groups.push(rows.slice(i, i + TRANSCRIPT_BATCH_MAX));
  return groups;
}
