import { expect, test } from 'claude-code/testing';
import {
  attach, parseWaitResult, reportTurn, sendTranscript, state, wait,
  type ServiceHost, type ServiceSession,
} from './service';
import type { TranscriptRow } from './transcript';

const BIN = '/plugins/iter8/bin/iter8';
const HOME = '/home/dev/.local/share/iter8';
const SESSION: ServiceSession = { owner: 'O-4f2a', pid: 4242, socketPath: `${HOME}/control.sock` };

const POINTER = 'Review round R4 from larkspur · 2 notes — run `iter8 show R4`';
const PAGE_MESSAGE_TEXT =
  'Page message M9 from larkspur — typed on the iter8 page, not in this terminal. Read it as you would a review note\'s text:\n' +
  '<page-message id="M9" page="larkspur">\nCan you make the heading smaller?\n</page-message>';

const ROUND_DELIVERY = { kind: 'round', pointer: { roundId: 'R4', pageId: 'larkspur', noteCount: 2 }, text: POINTER };
const MESSAGE_DELIVERY = { kind: 'page-message', messageId: 'M9', pageId: 'larkspur', text: PAGE_MESSAGE_TEXT };

function serviceStatus(over: Record<string, unknown> = {}) {
  return {
    state: 'ready',
    version: '0.1.0',
    build: 'abc1234',
    protocolVersion: 2,
    schemaVersion: 3,
    machineId: 'm-1',
    machineName: 'devbox',
    pid: 900,
    home: HOME,
    pool: [4100, 4101],
    overlay: 'present',
    owner: {
      owner: 'O-4f2a',
      agent: 'claude',
      process: { pid: 4242, startedAt: '2026-10-10T11:00:00.000Z', label: 'claude (4242)' },
      cwd: '/home/dev/app',
      generation: 1,
      state: { status: 'live' },
      relabelPending: false,
      listener: 'none',
    },
    ...over,
  };
}

type FetchCall = { url: string; init?: Parameters<ServiceHost['http']['fetch']>[1] };
type RunCall = { argv: readonly string[]; init?: Parameters<ServiceHost['process']['run']>[1] };

function fakeHost(opts: {
  run?: { exitCode: number; stdout: string; stderr: string } | Error;
  fetch?: { status: number; text: string } | Error;
}) {
  const fetches: FetchCall[] = [];
  const runs: RunCall[] = [];
  const host: ServiceHost = {
    http: {
      async fetch(url, init) {
        fetches.push({ url, init });
        const canned = opts.fetch ?? { status: 200, text: '{}' };
        if (canned instanceof Error) throw canned;
        return { status: canned.status, ok: canned.status >= 200 && canned.status < 300, text: canned.text };
      },
    },
    process: {
      async run(argv, init) {
        runs.push({ argv, init });
        const canned = opts.run ?? { exitCode: 0, stdout: '', stderr: '' };
        if (canned instanceof Error) throw canned;
        return canned;
      },
    },
  };
  return { host, fetches, runs };
}

function statusRun(exitCode: number, stdout: string, stderr = '') {
  return { exitCode, stdout, stderr };
}

test('attach runs iter8 status --json with ITER8_NO_INSTALL and a 10 s timeout, and derives the socket from home', async () => {
  const { host, runs, fetches } = fakeHost({ run: statusRun(0, JSON.stringify(serviceStatus())) });
  const result = await attach(host, BIN);
  expect(result).toEqual({ kind: 'attached', session: { owner: 'O-4f2a', pid: 4242, socketPath: `${HOME}/control.sock` } });
  expect(runs.length).toBe(1);
  expect(runs[0].argv).toEqual([BIN, 'status', '--json']);
  expect(runs[0].init).toEqual({ env: { ITER8_NO_INSTALL: '1' }, timeoutMs: 10000 });
  expect(fetches.length).toBe(0);
});

test('attach reports incompatible for another protocol version without touching the socket', async () => {
  const { host, fetches } = fakeHost({ run: statusRun(0, JSON.stringify(serviceStatus({ protocolVersion: 1 }))) });
  expect(await attach(host, BIN)).toEqual({ kind: 'incompatible', protocolVersion: 1 });
  expect(fetches.length).toBe(0);
});

test('attach reports incompatible with a null version when the field is not a number', async () => {
  const { host } = fakeHost({ run: statusRun(0, JSON.stringify(serviceStatus({ protocolVersion: '2' }))) });
  expect(await attach(host, BIN)).toEqual({ kind: 'incompatible', protocolVersion: null });
});

test('attach is not ready while the owner is not registered', async () => {
  const { host } = fakeHost({ run: statusRun(0, JSON.stringify(serviceStatus({ owner: null }))) });
  expect(await attach(host, BIN)).toEqual({ kind: 'not-ready', reason: 'owner not registered yet' });
});

test('attach maps exit 5 to service not running and exits 69 and 78 to not installed', async () => {
  expect(await attach(fakeHost({ run: statusRun(5, '') }).host, BIN)).toEqual({ kind: 'not-ready', reason: 'service not running' });
  expect(await attach(fakeHost({ run: statusRun(69, '') }).host, BIN)).toEqual({ kind: 'not-ready', reason: 'iter8 is not installed' });
  expect(await attach(fakeHost({ run: statusRun(78, '') }).host, BIN)).toEqual({ kind: 'not-ready', reason: 'iter8 is not installed' });
});

test('attach is not ready for any other exit, a rejected run, or output that is not the status shape', async () => {
  const other = await attach(fakeHost({ run: statusRun(1, '') }).host, BIN);
  expect(other.kind).toBe('not-ready');
  const rejected = await attach(fakeHost({ run: new Error('spawn failed') }).host, BIN);
  expect(rejected.kind).toBe('not-ready');
  const garbled = await attach(fakeHost({ run: statusRun(0, 'not json') }).host, BIN);
  expect(garbled.kind).toBe('not-ready');

  const malformed: Record<string, unknown>[] = [
    { home: 'relative/home' },
    { home: 42 },
    { owner: { ...serviceStatus().owner, owner: '' } },
    { owner: { ...serviceStatus().owner, process: { ...serviceStatus().owner.process, pid: 0 } } },
    { owner: { ...serviceStatus().owner, process: { ...serviceStatus().owner.process, pid: 1.5 } } },
    { owner: { ...serviceStatus().owner, process: null } },
    { owner: 'O-4f2a' },
  ];
  for (const over of malformed) {
    const result = await attach(fakeHost({ run: statusRun(0, JSON.stringify(serviceStatus(over))) }).host, BIN);
    expect(result.kind).toBe('not-ready');
  }
});

test('no attach reason repeats stdout or stderr text', async () => {
  const secret = 'SECRET-TOKEN-xyz';
  const runs = [
    statusRun(1, secret, secret),
    statusRun(5, secret, secret),
    statusRun(69, secret, secret),
    statusRun(0, secret, secret),
    statusRun(0, JSON.stringify({ protocolVersion: 2, home: secret, owner: secret }), secret),
  ];
  for (const run of runs) {
    const result = await attach(fakeHost({ run }).host, BIN);
    expect(result.kind).toBe('not-ready');
    if (result.kind === 'not-ready') expect(result.reason.includes(secret)).toBe(false);
  }
  const rejected = await attach(fakeHost({ run: new Error(secret) }).host, BIN);
  if (rejected.kind === 'not-ready') expect(rejected.reason.includes(secret)).toBe(false);
});

test('wait sends GET /agent/wait with the encoded owner and 25 s over the control socket', async () => {
  const { host, fetches } = fakeHost({ fetch: { status: 200, text: JSON.stringify({ outcome: 'timeout' }) } });
  const session = { ...SESSION, owner: 'O a&b' };
  expect(await wait(host, session)).toEqual({ kind: 'timeout' });
  expect(fetches.length).toBe(1);
  expect(fetches[0].url).toBe('http://iter8/agent/wait?owner=O%20a%26b&timeoutSeconds=25');
  expect(fetches[0].init?.method).toBe('GET');
  expect(fetches[0].init?.socketPath).toBe(SESSION.socketPath);
  expect(fetches[0].init?.body).toBeUndefined();
});

test('wait maps every outcome the service can answer', async () => {
  const cases: [unknown, unknown][] = [
    [{ outcome: 'deliver', deliveries: [ROUND_DELIVERY] }, { kind: 'deliver', deliveries: [ROUND_DELIVERY] }],
    [{ outcome: 'timeout' }, { kind: 'timeout' }],
    [{ outcome: 'replaced' }, { kind: 'replaced' }],
    [{ outcome: 'cancelled' }, { kind: 'cancelled' }],
  ];
  for (const [body, expected] of cases) {
    const { host } = fakeHost({ fetch: { status: 200, text: JSON.stringify(body) } });
    expect(await wait(host, SESSION)).toEqual(expected);
  }
});

test('wait maps 404 to unknown-owner, 409 to owner-gone, and everything else to an error', async () => {
  expect(await wait(fakeHost({ fetch: { status: 404, text: '' } }).host, SESSION)).toEqual({ kind: 'unknown-owner' });
  expect(await wait(fakeHost({ fetch: { status: 409, text: '' } }).host, SESSION)).toEqual({ kind: 'owner-gone' });
  for (const status of [400, 500, 503, 204]) {
    const result = await wait(fakeHost({ fetch: { status, text: '{"outcome":"timeout"}' } }).host, SESSION);
    expect(result.kind).toBe('error');
  }
  expect((await wait(fakeHost({ fetch: new Error('socket closed') }).host, SESSION)).kind).toBe('error');
  expect((await wait(fakeHost({ fetch: { status: 200, text: 'not json' } }).host, SESSION)).kind).toBe('error');
});

test('wait error reasons never carry the response body or the rejection message', async () => {
  const secret = 'SECRET-BODY-xyz';
  const bodies = [
    await wait(fakeHost({ fetch: { status: 500, text: secret } }).host, SESSION),
    await wait(fakeHost({ fetch: { status: 200, text: secret } }).host, SESSION),
    await wait(fakeHost({ fetch: new Error(secret) }).host, SESSION),
    await wait(fakeHost({ fetch: { status: 200, text: JSON.stringify({ outcome: secret }) } }).host, SESSION),
  ];
  for (const result of bodies) {
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.reason.includes(secret)).toBe(false);
  }
});

test('parseWaitResult delivers both delivery kinds in arrival order', () => {
  expect(parseWaitResult({ outcome: 'deliver', deliveries: [MESSAGE_DELIVERY, ROUND_DELIVERY] })).toEqual({
    kind: 'deliver',
    deliveries: [MESSAGE_DELIVERY, ROUND_DELIVERY],
  });
});

test('parseWaitResult keeps only the valid deliveries of a mixed body, in order', () => {
  const second = { ...ROUND_DELIVERY, pointer: { roundId: 'R5', pageId: 'larkspur', noteCount: 1 }, text: 'x' };
  const mixed = [
    ROUND_DELIVERY,
    { kind: 'round', pointer: { roundId: 'R0', pageId: 'larkspur', noteCount: 2 }, text: POINTER },
    { kind: 'round', pointer: { roundId: 'R4', pageId: 'Larkspur', noteCount: 2 }, text: POINTER },
    { kind: 'round', pointer: { roundId: 'R4', pageId: 'larkspur', noteCount: 0 }, text: POINTER },
    { kind: 'round', pointer: { roundId: 'R4', pageId: 'larkspur', noteCount: 1.5 }, text: POINTER },
    { kind: 'round', pointer: { roundId: 'R4', pageId: 'larkspur', noteCount: 2 }, text: 7 },
    { kind: 'round', text: POINTER },
    { kind: 'page-message', messageId: 'M0', pageId: 'larkspur', text: PAGE_MESSAGE_TEXT },
    { kind: 'page-message', messageId: 'M9', pageId: 'x', text: PAGE_MESSAGE_TEXT },
    { kind: 'page-message', messageId: 'M9', pageId: 'larkspur' },
    { kind: 'reaction', messageId: 'M9', pageId: 'larkspur', text: 'hi' },
    null,
    'round',
    MESSAGE_DELIVERY,
    second,
  ];
  expect(parseWaitResult({ outcome: 'deliver', deliveries: mixed })).toEqual({
    kind: 'deliver',
    deliveries: [ROUND_DELIVERY, MESSAGE_DELIVERY, second],
  });
});

test('parseWaitResult turns a deliver with nothing valid into a timeout', () => {
  expect(parseWaitResult({ outcome: 'deliver', deliveries: [{ kind: 'reaction' }, null] })).toEqual({ kind: 'timeout' });
  expect(parseWaitResult({ outcome: 'deliver', deliveries: [] })).toEqual({ kind: 'timeout' });
  expect(parseWaitResult({ outcome: 'deliver' })).toEqual({ kind: 'timeout' });
  expect(parseWaitResult({ outcome: 'deliver', deliveries: 'R4' })).toEqual({ kind: 'timeout' });
});

test('parseWaitResult errors only on an unknown outcome or a body that is not an object, and never throws', () => {
  for (const body of [{ outcome: 'later' }, { outcome: 3 }, {}, null, undefined, 'timeout', 7, [], [{ outcome: 'timeout' }]]) {
    expect(parseWaitResult(body).kind).toBe('error');
  }
});

test('reportTurn posts the owner and state as JSON and maps the status', async () => {
  const { host, fetches } = fakeHost({ fetch: { status: 200, text: '{"ok":true}' } });
  expect(await reportTurn(host, SESSION, 'busy')).toBe('ok');
  expect(fetches[0].url).toBe('http://iter8/agent/turn');
  expect(fetches[0].init?.method).toBe('POST');
  expect(fetches[0].init?.socketPath).toBe(SESSION.socketPath);
  expect(fetches[0].init?.headers?.['content-type']).toBe('application/json');
  expect(JSON.parse(fetches[0].init?.body ?? 'null')).toEqual({ owner: 'O-4f2a', state: 'busy' });

  await reportTurn(host, SESSION, 'idle');
  expect(JSON.parse(fetches[1].init?.body ?? 'null')).toEqual({ owner: 'O-4f2a', state: 'idle' });

  expect(await reportTurn(fakeHost({ fetch: { status: 404, text: '' } }).host, SESSION, 'idle')).toBe('unknown-owner');
  expect(await reportTurn(fakeHost({ fetch: { status: 409, text: '' } }).host, SESSION, 'idle')).toBe('owner-gone');
  expect(await reportTurn(fakeHost({ fetch: { status: 500, text: '' } }).host, SESSION, 'idle')).toBe('error');
  expect(await reportTurn(fakeHost({ fetch: new Error('closed') }).host, SESSION, 'idle')).toBe('error');
});

function note(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    pageId: 'larkspur',
    author: { kind: 'user' },
    intent: 'fix',
    body: `body of ${id}`,
    target: { kind: 'page' },
    anchorStatus: 'anchored',
    createdAt: '2026-10-10T11:00:00.000Z',
    resolution: status === 'answered' ? { status, reply: 'because', at: '2026-10-10T11:05:00.000Z' } : { status },
    ...over,
  };
}

function round(id: string, state: Record<string, unknown>, notes: unknown[]) {
  return { id, pageId: 'larkspur', owner: 'O-4f2a', state, notes };
}

function agentState(over: Record<string, unknown> = {}) {
  return {
    session: { owner: 'O-4f2a', agent: 'claude', process: serviceStatus().owner.process, cwd: '/home/dev/app', state: { status: 'live' } },
    focus: { pageId: 'larkspur', roundId: 'R5' },
    pages: [{ pageId: 'larkspur', origin: 'http://localhost:3000', chat: { enabled: true, defaultEnabled: false, reachable: true } }],
    rounds: [
      round('R3', { stage: 'claimed', queuedAt: 'a', idempotencyKey: 'k', claimedAt: 'b' }, [note('N1', 'done')]),
      round('R4', { stage: 'queued', queuedAt: 'a', idempotencyKey: 'k' }, [note('N2', 'open'), note('N3', 'answered')]),
      round('R5', { stage: 'queued', queuedAt: 'a', idempotencyKey: 'k', sendNowAt: '2026-10-10T11:10:00.000Z' }, [note('N4', 'open', { intent: 'question' })]),
    ],
    ...over,
  };
}

test('state requests /agent/state for the owner and maps rounds newest first with sendNow and note status', async () => {
  const { host, fetches } = fakeHost({ fetch: { status: 200, text: JSON.stringify(agentState()) } });
  const view = await state(host, SESSION);
  expect(fetches[0].url).toBe('http://iter8/agent/state?owner=O-4f2a');
  expect(fetches[0].init?.method).toBe('GET');
  expect(fetches[0].init?.socketPath).toBe(SESSION.socketPath);
  expect(view).toEqual({
    focus: { pageId: 'larkspur', roundId: 'R5' },
    pages: [{ pageId: 'larkspur', chat: { enabled: true, reachable: true } }],
    rounds: [
      { id: 'R5', pageId: 'larkspur', stage: 'queued', sendNow: true, notes: [{ id: 'N4', intent: 'question', status: 'open', body: 'body of N4' }] },
      {
        id: 'R4', pageId: 'larkspur', stage: 'queued', sendNow: false,
        notes: [
          { id: 'N2', intent: 'fix', status: 'open', body: 'body of N2' },
          { id: 'N3', intent: 'fix', status: 'answered', body: 'body of N3' },
        ],
      },
      { id: 'R3', pageId: 'larkspur', stage: 'claimed', sendNow: false, notes: [{ id: 'N1', intent: 'fix', status: 'done', body: 'body of N1' }] },
    ],
  });
});

test('state keeps a null focus and a focus without a round', async () => {
  const none = await state(fakeHost({ fetch: { status: 200, text: JSON.stringify(agentState({ focus: null, rounds: [] })) } }).host, SESSION);
  expect(none?.focus).toBeNull();
  expect(none?.rounds).toEqual([]);
  const pageOnly = await state(
    fakeHost({ fetch: { status: 200, text: JSON.stringify(agentState({ focus: { pageId: 'larkspur', roundId: null } })) } }).host,
    SESSION,
  );
  expect(pageOnly?.focus).toEqual({ pageId: 'larkspur', roundId: null });
});

test('state returns null on a failed request, a bad status, or any malformed part', async () => {
  expect(await state(fakeHost({ fetch: new Error('closed') }).host, SESSION)).toBeNull();
  for (const status of [404, 409, 500]) {
    expect(await state(fakeHost({ fetch: { status, text: JSON.stringify(agentState()) } }).host, SESSION)).toBeNull();
  }
  const bodies: unknown[] = [
    'not json',
    null,
    [],
    agentState({ rounds: 'none' }),
    agentState({ pages: {} }),
    agentState({ focus: { pageId: 7, roundId: null } }),
    agentState({ focus: { pageId: 'larkspur' } }),
    agentState({ pages: [{ pageId: 'larkspur', chat: { enabled: 'yes', reachable: true } }] }),
    agentState({ pages: [{ pageId: 'larkspur' }] }),
    agentState({ rounds: [round('R1', { stage: 'queued' }, [note('N1', 'pending')])] }),
    agentState({ rounds: [round('R1', { stage: 'queued' }, [note('N1', 'open', { body: 3 })])] }),
    agentState({ rounds: [round('R1', {}, [])] }),
    agentState({ rounds: [{ ...round('R1', { stage: 'queued' }, []), notes: null }] }),
    agentState({ rounds: [null] }),
  ];
  for (const body of bodies) {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    expect(await state(fakeHost({ fetch: { status: 200, text } }).host, SESSION)).toBeNull();
  }
});

const ROWS: TranscriptRow[] = [
  { key: 'u-1', role: 'user', text: 'make the heading smaller', at: '2026-10-10T12:00:00.000Z' },
  { key: 'u-2', role: 'assistant', text: 'Done.', at: '2026-10-10T12:00:05.000Z' },
];

test('sendTranscript posts the owner and rows as one JSON body and counts what was stored', async () => {
  const { host, fetches } = fakeHost({ fetch: { status: 200, text: JSON.stringify({ pageId: 'larkspur', stored: ['M1', 'M2'] }) } });
  expect(await sendTranscript(host, SESSION, ROWS)).toEqual({ kind: 'stored', pageId: 'larkspur', stored: 2 });
  expect(fetches.length).toBe(1);
  expect(fetches[0].url).toBe('http://iter8/agent/transcript');
  expect(fetches[0].init?.method).toBe('POST');
  expect(fetches[0].init?.socketPath).toBe(SESSION.socketPath);
  expect(fetches[0].init?.headers?.['content-type']).toBe('application/json');
  expect(JSON.parse(fetches[0].init?.body ?? 'null')).toEqual({ owner: 'O-4f2a', rows: ROWS });
});

test('sendTranscript reports a null page when the service stored nothing', async () => {
  const { host } = fakeHost({ fetch: { status: 200, text: JSON.stringify({ pageId: null, stored: [] }) } });
  expect(await sendTranscript(host, SESSION, ROWS)).toEqual({ kind: 'stored', pageId: null, stored: 0 });
});

test('sendTranscript maps 404, 409 and 400, and treats everything else as an error', async () => {
  expect(await sendTranscript(fakeHost({ fetch: { status: 404, text: '' } }).host, SESSION, ROWS)).toEqual({ kind: 'unknown-owner' });
  expect(await sendTranscript(fakeHost({ fetch: { status: 409, text: '' } }).host, SESSION, ROWS)).toEqual({ kind: 'owner-gone' });
  expect(await sendTranscript(fakeHost({ fetch: { status: 400, text: '' } }).host, SESSION, ROWS)).toEqual({ kind: 'rejected' });
  expect(await sendTranscript(fakeHost({ fetch: { status: 500, text: '' } }).host, SESSION, ROWS)).toEqual({ kind: 'error' });
  expect(await sendTranscript(fakeHost({ fetch: new Error('closed') }).host, SESSION, ROWS)).toEqual({ kind: 'error' });
  for (const text of ['not json', '{}', '{"pageId":"larkspur"}', '{"pageId":7,"stored":[]}']) {
    expect(await sendTranscript(fakeHost({ fetch: { status: 200, text } }).host, SESSION, ROWS)).toEqual({ kind: 'error' });
  }
});
