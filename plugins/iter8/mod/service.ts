import type { AgentDelivery } from './delivery';
import type { TranscriptRow } from './transcript';

export type ServiceHost = {
  http: {
    fetch(
      url: string,
      init?: { method?: string; headers?: Record<string, string>; body?: string; socketPath?: string },
    ): Promise<{ status: number; ok: boolean; text: string }>;
  };
  process: {
    run(
      argv: readonly string[],
      init?: { env?: Record<string, string>; timeoutMs?: number },
    ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  };
};

export type ServiceSession = { owner: string; pid: number; socketPath: string };

export type AttachResult =
  | { kind: 'attached'; session: ServiceSession }
  | { kind: 'not-ready'; reason: string }
  | { kind: 'incompatible'; protocolVersion: number | null };

export type WaitResult =
  | { kind: 'deliver'; deliveries: AgentDelivery[] }
  | { kind: 'timeout' }
  | { kind: 'replaced' }
  | { kind: 'cancelled' }
  | { kind: 'unknown-owner' }
  | { kind: 'owner-gone' }
  | { kind: 'error'; reason: string };

export type OwnerCallResult = 'ok' | 'unknown-owner' | 'owner-gone' | 'error';

export type StateView = {
  focus: { pageId: string; roundId: string | null } | null;
  pages: { pageId: string; chat: { enabled: boolean; reachable: boolean } }[];
  rounds: {
    id: string;
    pageId: string;
    stage: string;
    sendNow: boolean;
    notes: { id: string; intent: string; status: 'open' | 'done' | 'answered'; body: string }[];
  }[];
};

export type TranscriptOutcome =
  | { kind: 'stored'; pageId: string | null; stored: number }
  | { kind: 'unknown-owner' }
  | { kind: 'owner-gone' }
  | { kind: 'rejected' }
  | { kind: 'error' };

const PROTOCOL_VERSION = 2;
const STATUS_TIMEOUT_MS = 10_000;
const WAIT_SECONDS = 25;
const EXIT_SERVICE_NOT_RUNNING = 5;
const EXIT_NOT_INSTALLED = [69, 78];

const ROUND_ID = /^R[1-9][0-9]*$/;
const MESSAGE_ID = /^M[1-9][0-9]*$/;
const PAGE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const NOTE_STATUSES = ['open', 'done', 'answered'] as const;

const JSON_HEADERS = { 'content-type': 'application/json' };

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function ownerUrl(route: string, owner: string, extra = ''): string {
  return `http://iter8${route}?owner=${encodeURIComponent(owner)}${extra}`;
}

async function call(
  host: ServiceHost,
  session: ServiceSession,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
): Promise<{ status: number; text: string } | null> {
  try {
    const response = await host.http.fetch(url, {
      method,
      socketPath: session.socketPath,
      ...(body === undefined ? {} : { headers: JSON_HEADERS, body: JSON.stringify(body) }),
    });
    return { status: response.status, text: response.text };
  } catch {
    return null;
  }
}

export async function attach(host: ServiceHost, bin: string): Promise<AttachResult> {
  let run: { exitCode: number; stdout: string };
  try {
    run = await host.process.run([bin, 'status', '--json'], {
      env: { ITER8_NO_INSTALL: '1' },
      timeoutMs: STATUS_TIMEOUT_MS,
    });
  } catch {
    return { kind: 'not-ready', reason: 'iter8 status could not run' };
  }
  if (run.exitCode === EXIT_SERVICE_NOT_RUNNING) return { kind: 'not-ready', reason: 'service not running' };
  if (EXIT_NOT_INSTALLED.includes(run.exitCode)) return { kind: 'not-ready', reason: 'iter8 is not installed' };
  if (run.exitCode !== 0) return { kind: 'not-ready', reason: `iter8 status exited with ${run.exitCode}` };

  const status = parseJson(run.stdout);
  const unreadable: AttachResult = { kind: 'not-ready', reason: 'iter8 status output was not understood' };
  if (!isRecord(status) || !('protocolVersion' in status)) return unreadable;
  if (status.protocolVersion !== PROTOCOL_VERSION) {
    const version = status.protocolVersion;
    return { kind: 'incompatible', protocolVersion: typeof version === 'number' ? version : null };
  }
  if (status.owner === null) return { kind: 'not-ready', reason: 'owner not registered yet' };

  const { home, owner } = status;
  if (!isString(home) || !home.startsWith('/') || !isRecord(owner) || !isRecord(owner.process)) return unreadable;
  const pid = owner.process.pid;
  if (!isString(owner.owner) || owner.owner === '' || typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    return unreadable;
  }
  return { kind: 'attached', session: { owner: owner.owner, pid, socketPath: `${home}/control.sock` } };
}

function parseDelivery(value: unknown): AgentDelivery | null {
  if (!isRecord(value) || !isString(value.text)) return null;
  if (value.kind === 'round') {
    const pointer = value.pointer;
    if (!isRecord(pointer)) return null;
    const { roundId, pageId, noteCount } = pointer;
    if (!isString(roundId) || !ROUND_ID.test(roundId)) return null;
    if (!isString(pageId) || !PAGE_ID.test(pageId)) return null;
    if (typeof noteCount !== 'number' || !Number.isInteger(noteCount) || noteCount <= 0) return null;
    return { kind: 'round', pointer: { roundId, pageId, noteCount }, text: value.text };
  }
  if (value.kind === 'page-message') {
    const { messageId, pageId } = value;
    if (!isString(messageId) || !MESSAGE_ID.test(messageId)) return null;
    if (!isString(pageId) || !PAGE_ID.test(pageId)) return null;
    return { kind: 'page-message', messageId, pageId, text: value.text };
  }
  return null;
}

export function parseWaitResult(body: unknown): WaitResult {
  if (!isRecord(body)) return { kind: 'error', reason: 'wait result was not an object' };
  switch (body.outcome) {
    case 'deliver': {
      const raw = Array.isArray(body.deliveries) ? body.deliveries : [];
      const deliveries = raw.flatMap(item => {
        const delivery = parseDelivery(item);
        return delivery === null ? [] : [delivery];
      });
      return deliveries.length === 0 ? { kind: 'timeout' } : { kind: 'deliver', deliveries };
    }
    case 'timeout':
    case 'replaced':
    case 'cancelled':
      return { kind: body.outcome };
    default:
      return { kind: 'error', reason: 'wait result had an unknown outcome' };
  }
}

export async function wait(host: ServiceHost, session: ServiceSession): Promise<WaitResult> {
  const response = await call(
    host,
    session,
    'GET',
    ownerUrl('/agent/wait', session.owner, `&timeoutSeconds=${WAIT_SECONDS}`),
  );
  if (response === null) return { kind: 'error', reason: 'wait request failed' };
  if (response.status === 404) return { kind: 'unknown-owner' };
  if (response.status === 409) return { kind: 'owner-gone' };
  if (response.status !== 200) return { kind: 'error', reason: `wait answered ${response.status}` };
  const body = parseJson(response.text);
  return body === undefined ? { kind: 'error', reason: 'wait answered unreadable JSON' } : parseWaitResult(body);
}

function ownerStatus(status: number): OwnerCallResult {
  if (status === 200) return 'ok';
  if (status === 404) return 'unknown-owner';
  if (status === 409) return 'owner-gone';
  return 'error';
}

export async function reportTurn(
  host: ServiceHost,
  session: ServiceSession,
  state: 'busy' | 'idle',
): Promise<OwnerCallResult> {
  const response = await call(host, session, 'POST', 'http://iter8/agent/turn', { owner: session.owner, state });
  return response === null ? 'error' : ownerStatus(response.status);
}

function parseNote(value: unknown): StateView['rounds'][number]['notes'][number] | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.intent) || !isString(value.body)) return null;
  const status = isRecord(value.resolution) ? value.resolution.status : undefined;
  if (!NOTE_STATUSES.some(known => known === status)) return null;
  return { id: value.id, intent: value.intent, status: status as 'open' | 'done' | 'answered', body: value.body };
}

function parseRound(value: unknown): StateView['rounds'][number] | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.pageId)) return null;
  if (!isRecord(value.state) || !isString(value.state.stage) || !Array.isArray(value.notes)) return null;
  const notes = value.notes.map(parseNote);
  if (notes.some(note => note === null)) return null;
  return {
    id: value.id,
    pageId: value.pageId,
    stage: value.state.stage,
    sendNow: isString(value.state.sendNowAt),
    notes: notes as StateView['rounds'][number]['notes'],
  };
}

function parsePage(value: unknown): StateView['pages'][number] | null {
  if (!isRecord(value) || !isString(value.pageId) || !isRecord(value.chat)) return null;
  const { enabled, reachable } = value.chat;
  if (typeof enabled !== 'boolean' || typeof reachable !== 'boolean') return null;
  return { pageId: value.pageId, chat: { enabled, reachable } };
}

function parseFocus(value: unknown): StateView['focus'] | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isString(value.pageId)) return undefined;
  if (value.roundId !== null && !isString(value.roundId)) return undefined;
  return { pageId: value.pageId, roundId: value.roundId };
}

export async function state(host: ServiceHost, session: ServiceSession): Promise<StateView | null> {
  const response = await call(host, session, 'GET', ownerUrl('/agent/state', session.owner));
  if (response === null || response.status !== 200) return null;
  const body = parseJson(response.text);
  if (!isRecord(body) || !Array.isArray(body.pages) || !Array.isArray(body.rounds)) return null;

  const focus = parseFocus(body.focus);
  const pages = body.pages.map(parsePage);
  const rounds = body.rounds.map(parseRound);
  if (focus === undefined || pages.includes(null) || rounds.includes(null)) return null;
  return {
    focus,
    pages: pages as StateView['pages'],
    rounds: (rounds as StateView['rounds']).reverse(),
  };
}

export async function sendTranscript(
  host: ServiceHost,
  session: ServiceSession,
  rows: readonly TranscriptRow[],
): Promise<TranscriptOutcome> {
  const response = await call(host, session, 'POST', 'http://iter8/agent/transcript', {
    owner: session.owner,
    rows,
  });
  if (response === null) return { kind: 'error' };
  if (response.status === 404) return { kind: 'unknown-owner' };
  if (response.status === 409) return { kind: 'owner-gone' };
  if (response.status === 400) return { kind: 'rejected' };
  if (response.status !== 200) return { kind: 'error' };
  const body = parseJson(response.text);
  if (!isRecord(body) || !Array.isArray(body.stored)) return { kind: 'error' };
  if (body.pageId !== null && !isString(body.pageId)) return { kind: 'error' };
  return { kind: 'stored', pageId: body.pageId, stored: body.stored.length };
}
