import { expect, test } from 'claude-code/testing';
import { PANE_ID, paneTree, type PaneRound, type PaneView } from './pane';

type Node = { type: 'Box' | 'Text'; props: { children?: unknown; [key: string]: unknown } };

const ui = {
  Box: (props: object): Node => ({ type: 'Box', props }),
  Text: (props: object): Node => ({ type: 'Text', props }),
};

function textOf(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object') return textOf((node as Node).props.children);
  return '';
}

function lines(tree: unknown): string[] {
  const children = (tree as Node).props.children as unknown[];
  return children.map(textOf);
}

function all(node: unknown, found: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const child of node) all(child, found);
  } else if (node && typeof node === 'object') {
    found.push(node as Node);
    all((node as Node).props.children, found);
  }
  return found;
}

function round(id: string, overrides: Partial<PaneRound> = {}): PaneRound {
  return {
    id,
    pageId: 'larkspur',
    stage: 'review',
    sendNow: false,
    notes: [{ id: `${id}-n1`, intent: 'fix', status: 'open', body: `${id} first note` }],
    ...overrides,
  };
}

function view(overrides: Partial<PaneView> = {}): PaneView {
  return { connection: 'live', focus: null, rounds: [], pages: [], waiting: 0, ...overrides };
}

const threeNotes: PaneRound['notes'] = [
  { id: 'N1', intent: 'fix', status: 'open', body: 'Make the heading smaller' },
  { id: 'N2', intent: 'question', status: 'done', body: 'Why is the gap so wide' },
  { id: 'N3', intent: 'praise', status: 'answered', body: 'Nice spacing here' },
];

test('PANE_ID is the id the pane is opened under', () => {
  expect(PANE_ID).toBe('iter8-round');
});

test('the header counts done and answered notes as resolved', () => {
  const tree = paneTree(ui, view({ rounds: [round('R4', { notes: threeNotes })] }), 80);
  expect(lines(tree)[0]).toBe('R4 · larkspur · review · 2 of 3 resolved');
  const header = all(tree).find(node => node.type === 'Text' && node.props.bold === true);
  expect(textOf(header)).toBe('R4 · larkspur · review · 2 of 3 resolved');
});

test('each note is one row with its status mark, intent word and body', () => {
  const tree = paneTree(ui, view({ rounds: [round('R4', { notes: threeNotes })] }), 80);
  expect(lines(tree).slice(1)).toEqual([
    '○ fix Make the heading smaller',
    '✓ question Why is the gap so wide',
    '↩ praise Nice spacing here',
  ]);
});

test('a round marked send now says so in the header', () => {
  const sendNow = paneTree(ui, view({ rounds: [round('R4', { sendNow: true })] }), 80);
  expect(lines(sendNow)[0]).toBe('R4 · larkspur · review · Send now · 0 of 1 resolved');
  const normal = paneTree(ui, view({ rounds: [round('R4')] }), 80);
  expect(textOf(lines(normal)[0]).includes('Send now')).toBe(false);
});

test('focus on an older round draws that round, not the newest', () => {
  const rounds = [round('R5', { notes: threeNotes }), round('R4')];
  const tree = paneTree(ui, view({ rounds, focus: { pageId: 'larkspur', roundId: 'R4' } }), 80);
  const drawn = lines(tree);
  expect(drawn[0]).toBe('R4 · larkspur · review · 0 of 1 resolved');
  expect(drawn).toContain('○ fix R4 first note');
  expect(drawn).toContain('R5 · larkspur · review · 3 notes');
});

test('without a matching focus the newest round, listed first, is active', () => {
  const rounds = [round('R5'), round('R4')];
  for (const focus of [null, { pageId: 'larkspur', roundId: null }, { pageId: 'larkspur', roundId: 'R9' }]) {
    expect(lines(paneTree(ui, view({ rounds, focus }), 80))[0]).toBe('R5 · larkspur · review · 0 of 1 resolved');
  }
});

test('a long body is truncated on one line, not wrapped, in the width left after the prefix', () => {
  const body = `${'word '.repeat(60)}\nsecond line never shows`;
  const tree = paneTree(ui, view({ rounds: [round('R4', { notes: [{ id: 'N1', intent: 'fix', status: 'open', body }] })] }), 40);
  const bodyText = all(tree).find(node => node.type === 'Text' && node.props.wrap === 'truncate-end');
  expect(bodyText).toBeDefined();
  expect(textOf(bodyText).includes('second line')).toBe(false);
  expect(textOf(bodyText).includes('\n')).toBe(false);
  const bodyBox = all(tree).find(node => node.type === 'Box' && node.props.width !== undefined);
  expect(bodyBox?.props.width).toBe(40 - '○ fix '.length);
});

test('a control character in a body does not reach the drawing', () => {
  const body = 'tab\there\u001b[31m red';
  const tree = paneTree(ui, view({ rounds: [round('R4', { notes: [{ id: 'N1', intent: 'fix', status: 'open', body }] })] }), 80);
  expect(/[\u0000-\u001f\u007f]/.test(lines(tree).slice(1).join(''))).toBe(false);
});

test('the waiting line appears only while deliveries are waiting', () => {
  const rounds = [round('R4')];
  expect(lines(paneTree(ui, view({ rounds, waiting: 2 }), 80))).toContain('2 waiting for Claude to finish this turn');
  const none = lines(paneTree(ui, view({ rounds, waiting: 0 }), 80));
  expect(none.some(line => line.includes('waiting for Claude'))).toBe(false);
});

test('every other round is listed once as a dim line', () => {
  const rounds = [round('R6', { stage: 'collecting' }), round('R5', { notes: threeNotes }), round('R4')];
  const tree = paneTree(ui, view({ rounds }), 80);
  const drawn = lines(tree);
  expect(drawn.filter(line => line.startsWith('R5 '))).toEqual(['R5 · larkspur · review · 3 notes']);
  expect(drawn.filter(line => line.startsWith('R4 '))).toEqual(['R4 · larkspur · review · 1 note']);
  expect(drawn.filter(line => line.startsWith('R6 '))).toHaveLength(1);
  const dimmed = all(tree).filter(node => node.type === 'Text' && node.props.dimColor === true).map(textOf);
  expect(dimmed).toContain('R5 · larkspur · review · 3 notes');
  expect(dimmed).toContain('R4 · larkspur · review · 1 note');
});

test('no note body is drawn for a round other than the active one', () => {
  const rounds = [round('R5'), round('R4')];
  const drawn = lines(paneTree(ui, view({ rounds }), 80)).join('\n');
  expect(drawn.includes('R5 first note')).toBe(true);
  expect(drawn.includes('R4 first note')).toBe(false);
});

test('each paired page gets one chat line', () => {
  const pages = [
    { pageId: 'larkspur', chat: { enabled: true, reachable: true } },
    { pageId: 'marigold', chat: { enabled: false, reachable: true } },
    { pageId: 'nettle', chat: { enabled: true, reachable: false } },
  ];
  const drawn = lines(paneTree(ui, view({ rounds: [round('R4')], pages }), 80));
  expect(drawn).toContain('larkspur chat: on');
  expect(drawn).toContain('marigold chat: off');
  expect(drawn).toContain('nettle chat: on, not reachable');
});

test('a live connection with no rounds says there are none', () => {
  expect(lines(paneTree(ui, view(), 80))).toEqual(['No open rounds for this session.']);
});

test('each connection state that is not live draws its message alone', () => {
  const rounds = [round('R4')];
  const pages = [{ pageId: 'larkspur', chat: { enabled: true, reachable: true } }];
  const expected = {
    connecting: 'Connecting to iter8…',
    unavailable: 'iter8 service unavailable — rounds still reach Claude through the shell hooks',
    incompatible: 'This iter8 version predates the mod — the shell hooks deliver rounds',
  } as const;
  for (const connection of ['connecting', 'unavailable', 'incompatible'] as const) {
    expect(lines(paneTree(ui, view({ connection, rounds, pages, waiting: 3 }), 80))).toEqual([expected[connection]]);
  }
});

test('only bold and dimColor styling is used', () => {
  const rounds = [round('R5', { sendNow: true, notes: threeNotes }), round('R4')];
  const pages = [{ pageId: 'larkspur', chat: { enabled: true, reachable: false } }];
  const tree = paneTree(ui, view({ rounds, pages, waiting: 1 }), 80);
  const allowed = new Set(['children', 'bold', 'dimColor', 'wrap', 'flexDirection', 'width']);
  for (const node of all(tree)) {
    for (const key of Object.keys(node.props)) expect(allowed.has(key)).toBe(true);
  }
});
