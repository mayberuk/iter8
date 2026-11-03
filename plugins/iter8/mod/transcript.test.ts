import { expect, test } from 'claude-code/testing';
import {
  batches, transcriptRow, MESSAGE_MAX_CHARS, TRANSCRIPT_BATCH_MAX,
  type AppendedRow, type TranscriptRow,
} from './transcript';

const AT = '2026-10-10T12:00:00.000Z';

function row(over: Partial<AppendedRow> & { text?: string } = {}): AppendedRow {
  const { text, ...rest } = over;
  return {
    uuid: 'u-1',
    door: 'prompt',
    origin: { kind: 'composer' },
    message: { type: 'user', content: [{ type: 'text', text: text ?? 'hello' }] },
    ...rest,
  };
}

function response(text = 'done'): AppendedRow {
  return {
    uuid: 'u-2',
    door: 'response',
    origin: { kind: 'model' },
    message: { type: 'assistant', content: [{ type: 'text', text }] },
  };
}

test('a prompt the person typed becomes a user row keyed by the row uuid', () => {
  expect(transcriptRow(row(), AT)).toEqual({ key: 'u-1', role: 'user', text: 'hello', at: AT });
  expect(transcriptRow(row({ uuid: 'abc', origin: { kind: 'bridge' } }), AT)).toEqual({ key: 'abc', role: 'user', text: 'hello', at: AT });
});

test('an assistant response becomes an assistant row', () => {
  expect(transcriptRow(response('All set.'), AT)).toEqual({ key: 'u-2', role: 'assistant', text: 'All set.', at: AT });
});

test('prompts that were not typed by a person produce no row', () => {
  for (const kind of ['plugin', 'hook', 'task-notification', 'channel', '']) {
    expect([kind, transcriptRow(row({ origin: { kind } }), AT)]).toEqual([kind, null]);
  }
});

test('a response that is not an assistant message produces no row', () => {
  const user = { ...response(), message: { type: 'user', content: [{ type: 'text', text: 'x' }] } };
  const system = { ...response(), message: { type: 'system', content: [{ type: 'text', text: 'x' }] } };
  expect(transcriptRow(user, AT)).toBeNull();
  expect(transcriptRow(system, AT)).toBeNull();
});

test('rows from any other door produce no row', () => {
  for (const door of ['tool', 'attachment', 'thinking', 'system', 'command', '']) {
    expect([door, transcriptRow(row({ door }), AT)]).toEqual([door, null]);
    expect([door, transcriptRow({ ...response(), door }, AT)]).toEqual([door, null]);
  }
});

test('rows from a subagent produce no row', () => {
  expect(transcriptRow(row({ agentId: 'agent-7' }), AT)).toBeNull();
  expect(transcriptRow({ ...response(), agentId: 'agent-7' }, AT)).toBeNull();
});

test('a row without text produces no row', () => {
  const empty: AppendedRow[] = [
    row({ message: { type: 'user', content: [] } }),
    row({ text: '' }),
    row({ text: '  \n\t ' }),
    row({ message: { type: 'user', content: [{ type: 'tool_result' }] } }),
    { ...response(), message: { type: 'assistant', content: [{ type: 'tool_use' }, { type: 'thinking', text: 'secret' }] } },
    { ...response(), message: { type: 'assistant', content: [{ type: 'image' }] } },
  ];
  for (const [i, r] of empty.entries()) expect([i, transcriptRow(r, AT)]).toEqual([i, null]);
});

test('text blocks are joined with a blank line and other blocks are left out', () => {
  const r: AppendedRow = {
    ...response(),
    message: {
      type: 'assistant',
      content: [
        { type: 'text', text: 'first' },
        { type: 'thinking', text: 'private' },
        { type: 'tool_use' },
        { type: 'text', text: 'second' },
        { type: 'text', text: '' },
        { type: 'text', text: 'third' },
      ],
    },
  };
  expect(transcriptRow(r, AT)?.text).toBe('first\n\nsecond\n\nthird');
});

test('text is cut at the character limit and a surrogate pair is never split', () => {
  expect(MESSAGE_MAX_CHARS).toBe(32000);
  const exact = 'a'.repeat(32000);
  expect(transcriptRow(row({ text: exact }), AT)?.text).toBe(exact);
  expect(transcriptRow(row({ text: exact + 'bcd' }), AT)?.text).toBe(exact);

  const joined = row({ message: { type: 'user', content: [{ type: 'text', text: 'a'.repeat(31998) }, { type: 'text', text: 'b'.repeat(10) }] } });
  expect(transcriptRow(joined, AT)?.text).toBe('a'.repeat(31998) + '\n\n');

  const split = transcriptRow(row({ text: 'a'.repeat(31999) + '😀' }), AT)?.text;
  expect(split).toBe('a'.repeat(31999));
  const whole = transcriptRow(row({ text: 'a'.repeat(31998) + '😀' }), AT)?.text;
  expect(whole).toBe('a'.repeat(31998) + '😀');
});

function rows(count: number): TranscriptRow[] {
  return Array.from({ length: count }, (_, i) => ({ key: `k${i}`, role: 'user' as const, text: `t${i}`, at: AT }));
}

test('120 rows are batched as 50, 50 and 20 in order', () => {
  expect(TRANSCRIPT_BATCH_MAX).toBe(50);
  const input = rows(120);
  const result = batches(input);
  expect(result.map(b => b.length)).toEqual([50, 50, 20]);
  expect(result.flat().map(r => r.key)).toEqual(input.map(r => r.key));
  expect(result[1][0].key).toBe('k50');
  expect(result[2][0].key).toBe('k100');
});

test('batches handles empty, exact and one-over sizes', () => {
  expect(batches([])).toEqual([]);
  expect(batches(rows(1)).map(b => b.length)).toEqual([1]);
  expect(batches(rows(50)).map(b => b.length)).toEqual([50]);
  expect(batches(rows(51)).map(b => b.length)).toEqual([50, 1]);
  expect(batches(rows(100)).map(b => b.length)).toEqual([50, 50]);
});
