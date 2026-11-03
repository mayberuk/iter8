import type { Caught, EngineInterface } from 'claude-code';
import { emptyQueue, enqueue, finishCurrent, startNext, type AgentDelivery, type SubmitQueue } from './delivery';
import { PANE_ID, paneTree, type PaneView } from './pane';
import {
  attach, reportTurn, sendTranscript, state as fetchState, wait,
  type ServiceHost, type ServiceSession, type StateView,
} from './service';
import { batches, transcriptRow, type AppendedRow, type TranscriptRow } from './transcript';

type Next = (e: never) => any;

type Timer = { cancel: () => void };

type Port = {
  host: ServiceHost;
  bin: string;
  after: (ms: number, fn: () => void) => Timer;
  every: (ms: number, fn: () => void) => Timer;
  now: () => Promise<number>;
  submit: (text: string) => Promise<void>;
  log: (text: string) => void;
  debug: (text: string) => void;
  toast: (text: string) => void;
  open: (focus: boolean) => Promise<boolean>;
  invalidate: () => void;
};

type ModState = {
  port: Port | null;
  connection: PaneView['connection'];
  session: ServiceSession | null;
  generation: number;
  queue: SubmitQueue;
  view: StateView | null;
  buffer: TranscriptRow[];
  busy: boolean;
  turnPosts: Promise<void>;
  personClosedPane: boolean;
  commandRegistered: boolean;
  flushTimer: Timer | null;
  flushing: boolean;
  paneTimer: Timer | null;
  failingSince: number | null;
  errorCount: number;
};

const MIN_VERSION = [2, 1, 296];
const ATTACH_RETRY_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
const WAIT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REATTACH_MS = 2_000;
const UNAVAILABLE_AFTER_MS = 30_000;
const FLUSH_DELAY_MS = 250;
const BUFFER_MAX = 200;
const PANE_REFRESH_MS = 5_000;

function meetsMinimum(version: { version: string; base?: string } | null): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version?.base ?? version?.version ?? '');
  if (match === null) return false;
  const parts = match.slice(1, 4).map(Number);
  for (let i = 0; i < MIN_VERSION.length; i++) {
    if (parts[i] !== MIN_VERSION[i]) return parts[i] > MIN_VERSION[i];
  }
  return true;
}

function deliveryName(delivery: AgentDelivery): string {
  return delivery.kind === 'round' ? `round ${delivery.pointer.roundId}` : `page message ${delivery.messageId}`;
}

function submitFailure(delivery: AgentDelivery): string {
  return delivery.kind === 'round'
    ? `iter8 couldn't start a turn for ${delivery.pointer.roundId} — run iter8 show ${delivery.pointer.roundId}`
    : `iter8 couldn't deliver page message ${delivery.messageId}`;
}

function passThrough($: EngineInterface, e: any, next: Next & Caught) {
  if (next.error.kind !== 're-entry') $.ui.log(`iter8 mod: a hook failed: ${next.error.message ?? next.error.kind}`, { to: 'debug' });
  return next(e);
}

export function register(on: any): void {
  const s: ModState = {
    port: null,
    connection: 'connecting',
    session: null,
    generation: 0,
    queue: emptyQueue,
    view: null,
    buffer: [],
    busy: false,
    turnPosts: Promise.resolve(),
    personClosedPane: false,
    commandRegistered: false,
    flushTimer: null,
    flushing: false,
    paneTimer: null,
    failingSince: null,
    errorCount: 0,
  };

  function paneView(): PaneView {
    return {
      connection: s.connection,
      focus: s.view?.focus ?? null,
      rounds: s.view?.rounds ?? [],
      pages: s.view?.pages ?? [],
      waiting: s.queue.waiting.length + (s.queue.inFlight === null ? 0 : 1),
    };
  }

  function setConnection(connection: PaneView['connection']): void {
    if (s.connection === connection) return;
    s.connection = connection;
    s.port?.invalidate();
  }

  // Bumping the generation is what stops every older attach retry and wait chain.
  function reattach(delayMs: number): void {
    const port = s.port;
    if (port === null) return;
    const generation = ++s.generation;
    s.session = null;
    setConnection('connecting');
    port.after(delayMs, () => void attemptAttach(port, generation, 0));
  }

  async function attemptAttach(port: Port, generation: number, tries: number): Promise<void> {
    if (generation !== s.generation) return;
    const result = await attach(port.host, port.bin);
    if (generation !== s.generation) return;
    if (result.kind === 'incompatible') {
      port.debug(`iter8 mod off: the service speaks protocol ${result.protocolVersion ?? 'unknown'}, this mod needs 2`);
      setConnection('incompatible');
      return;
    }
    if (result.kind === 'not-ready') {
      // The first attempt often races the plugin's own `hook.sh start`, which pairs the process.
      const delay = ATTACH_RETRY_MS[Math.min(tries, ATTACH_RETRY_MS.length - 1)];
      port.after(delay, () => void attemptAttach(port, generation, tries + 1));
      return;
    }
    s.session = result.session;
    s.failingSince = null;
    s.errorCount = 0;
    setConnection('live');
    if (s.busy) postTurn('busy');
    port.after(0, () => void step(port, generation));
    void refreshState();
    void flush();
  }

  async function step(port: Port, generation: number): Promise<void> {
    const session = s.session;
    if (generation !== s.generation || session === null) return;
    const result = await wait(port.host, session);
    // The service marks each item delivered as it hands it out, so even a stale chain must submit it.
    if (result.kind === 'deliver') receive(port, result.deliveries);
    if (generation !== s.generation) return;
    switch (result.kind) {
      case 'deliver':
      case 'timeout':
      case 'replaced':
        s.failingSince = null;
        s.errorCount = 0;
        setConnection('live');
        port.after(0, () => void step(port, generation));
        return;
      case 'cancelled':
      case 'unknown-owner':
      case 'owner-gone':
        reattach(REATTACH_MS);
        return;
      case 'error': {
        const now = await port.now();
        if (generation !== s.generation) return;
        s.failingSince ??= now;
        if (now - s.failingSince >= UNAVAILABLE_AFTER_MS) setConnection('unavailable');
        const delay = WAIT_BACKOFF_MS[Math.min(s.errorCount, WAIT_BACKOFF_MS.length - 1)];
        s.errorCount += 1;
        port.after(delay, () => void step(port, generation));
      }
    }
  }

  function receive(port: Port, deliveries: AgentDelivery[]): void {
    const { queue, dropped } = enqueue(s.queue, deliveries);
    s.queue = queue;
    for (const delivery of dropped) {
      port.debug(`iter8 dropped a malformed ${delivery.kind} delivery`);
      port.toast('iter8 dropped a malformed delivery');
    }
    drain(port);
    void refreshState();
  }

  function drain(port: Port): void {
    const { queue, submit } = startNext(s.queue);
    s.queue = queue;
    port.invalidate();
    if (submit === null) return;
    void (async () => {
      try {
        await port.submit(submit.text);
        port.log(`${deliveryName(submit)} sent to Claude`);
        if (submit.kind === 'round' && !s.personClosedPane) {
          const placed = await port.open(false).catch(() => false);
          if (!placed) port.toast(`iter8: round ${submit.pointer.roundId} sent — /iter8 shows it`);
        }
      } catch (error) {
        port.debug(`iter8 could not submit ${deliveryName(submit)}: ${String(error)}`);
        port.toast(submitFailure(submit));
      }
      s.queue = finishCurrent(s.queue);
      drain(port);
    })();
  }

  function postTurn(turn: 'busy' | 'idle'): void {
    const port = s.port;
    if (port === null) return;
    s.turnPosts = s.turnPosts
      .then(async () => {
        const session = s.session;
        if (session === null) return;
        const result = await reportTurn(port.host, session, turn);
        if ((result === 'unknown-owner' || result === 'owner-gone') && s.session === session) reattach(REATTACH_MS);
      })
      .catch(() => undefined);
  }

  async function refreshState(): Promise<void> {
    const port = s.port;
    const session = s.session;
    if (port === null || session === null) return;
    const view = await fetchState(port.host, session);
    if (view === null || s.session !== session) return;
    s.view = view;
    port.invalidate();
  }

  function scheduleFlush(port: Port): void {
    if (s.flushTimer !== null) return;
    s.flushTimer = port.after(FLUSH_DELAY_MS, () => {
      s.flushTimer = null;
      void flush();
    });
  }

  async function flush(): Promise<void> {
    const port = s.port;
    if (port === null || s.flushing) return;
    s.flushing = true;
    try {
      for (const group of batches(s.buffer)) {
        const session = s.session;
        if (session === null) return;
        const outcome = await sendTranscript(port.host, session, group);
        if (outcome.kind === 'stored' || outcome.kind === 'rejected') {
          const sent = new Set(group);
          s.buffer = s.buffer.filter(row => !sent.has(row));
        } else if (outcome.kind === 'unknown-owner') {
          if (s.session === session) reattach(REATTACH_MS);
          return;
        } else if (outcome.kind === 'owner-gone') {
          s.buffer = [];
          return;
        } else {
          return;
        }
      }
    } finally {
      s.flushing = false;
    }
  }

  on('session.start', async ($: EngineInterface, e: any, next: Next) => {
    if (!e.isInteractive || e.surface === null) {
      $.ui.log('iter8 mod off: not an interactive session with a drawing surface; the shell hooks deliver rounds', { to: 'debug' });
      return next(e);
    }
    const version = await $.session.version().catch(() => null);
    if (!meetsMinimum(version)) {
      $.ui.log(`iter8 mod off: Claude Code ${version?.version ?? 'unknown'} is older than 2.1.296`, { to: 'debug' });
      return next(e);
    }
    const port: Port = {
      host: {
        http: {
          fetch: async (url, init) => {
            const response = await $.http.fetch(url, init);
            return { status: response.status, ok: response.ok, text: response.text };
          },
        },
        process: {
          run: async (argv, init) => {
            const result = await $.process.run([...argv], init);
            return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
          },
        },
      },
      bin: `${$.plugin.root}/bin/iter8`,
      after: (ms, fn) => $.clock.after(ms, fn),
      every: (ms, fn) => $.clock.every(ms, fn),
      now: () => $.clock.now(),
      submit: async text => {
        const result = await $.prompt.submit({ text });
        if (result.drop !== undefined) throw new Error(String(result.drop));
      },
      log: text => $.ui.log(text),
      debug: text => $.ui.log(text, { to: 'debug' }),
      toast: text => $.ui.toast(text),
      open: async focus => {
        const opened = await $.ui.open(focus ? { id: PANE_ID, title: 'iter8', focus: true } : { id: PANE_ID, title: 'iter8' });
        return opened.isPlaced;
      },
      invalidate: () => $.ui.invalidate('ui.render'),
    };
    s.port = port;
    if (!s.commandRegistered) {
      try {
        await $.command.register({ name: 'iter8', description: 'Show the iter8 round pane', immediate: true });
        s.commandRegistered = true;
      } catch (error) {
        port.debug(`iter8 could not register /iter8: ${String(error)}`);
      }
    }
    reattach(0);
    return next(e);
  });

  on('turn.start', async ($: EngineInterface, e: any, next: Next) => {
    if (e.agentId === undefined && s.port !== null) {
      s.busy = true;
      postTurn('busy');
    }
    return next(e);
  });

  on('turn.complete', async ($: EngineInterface, e: any, next: Next) => {
    if (e.agentId === undefined && s.port !== null) {
      s.busy = false;
      postTurn('idle');
      void refreshState();
      void flush();
    }
    return next(e);
  });

  on('session.append', async ($: EngineInterface, e: any, next: Next) => {
    const stored = await next(e);
    const port = s.port;
    if (port === null) return stored;
    const row = transcriptRow(e as AppendedRow, new Date(await port.now()).toISOString());
    if (row !== null) {
      s.buffer.push(row);
      if (s.buffer.length > BUFFER_MAX) s.buffer.splice(0, s.buffer.length - BUFFER_MAX);
      scheduleFlush(port);
    }
    return stored;
  }).catch(passThrough);

  on('command.run', { command: 'iter8' }, async ($: EngineInterface, e: any, next: Next) => {
    const port = s.port;
    if (port === null) return next(e);
    await refreshState();
    s.personClosedPane = false;
    const placed = await port.open(true).catch(() => false);
    if (!placed) port.toast('iter8: widen the terminal to see the round pane');
    return {};
  }).catch(passThrough);

  on('ui.close', async ($: EngineInterface, e: any, next: Next) => {
    if (e.id === PANE_ID) {
      if (e.origin?.kind === 'person') s.personClosedPane = true;
      s.paneTimer?.cancel();
      s.paneTimer = null;
    }
    return next(e);
  }).catch(passThrough);

  on('ui.render', { component: 'Pane' }, async ($: EngineInterface, e: any, next: Next) => {
    if (e.requestId !== PANE_ID) return next(e);
    if (s.paneTimer === null && s.port !== null) s.paneTimer = s.port.every(PANE_REFRESH_MS, () => void refreshState());
    const ui = $.ui.resolve(e) as unknown as Parameters<typeof paneTree>[0];
    return paneTree(ui, paneView(), e.props.bodyColumns);
  });
}
