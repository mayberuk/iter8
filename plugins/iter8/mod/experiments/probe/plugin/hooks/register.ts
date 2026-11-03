import type { EngineInterface } from 'claude-code';

type Next = (e: never) => unknown;

type Config = { socketPath: string; evidencePath: string; clearCheckPath: string; owner: string };

type Port = {
  read: (path: string) => Promise<string>;
  write: (path: string, text: string) => Promise<void>;
  fetch: (url: string, init: { socketPath: string }) => Promise<{ status: number; ok: boolean; text: string }>;
  run: (argv: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  submit: (text: string) => Promise<{ drop?: string }>;
  every: (ms: number, fn: () => void) => unknown;
  root: string;
};

const ANCESTRY =
  'p=$$; while [ "$p" -gt 1 ]; do ps -o pid=,ppid=,comm= -p "$p"; p=$(ps -o ppid= -p "$p" | tr -d " "); done';

// The mod analyzer refuses `$` stored or passed, so everything the hooks share is a closure object built here.
const held: {
  instance: string;
  port: Port | null;
  config: Config | null;
  started: boolean;
  alive: boolean;
  pending: object[];
  flushing: Promise<void>;
} = {
  instance: '',
  port: null,
  config: null,
  started: false,
  alive: false,
  pending: [],
  flushing: Promise.resolve(),
};

function record(obs: object): void {
  held.pending.push({ at: Date.now(), instance: held.instance, ...obs });
  flush();
}

// One chain, so two hooks recording at once cannot read the same file and lose a line.
function flush(): void {
  const { port, config } = held;
  if (port === null || config === null) return;
  held.flushing = held.flushing.then(async () => {
    if (held.pending.length === 0) return;
    const batch = held.pending.splice(0);
    let previous = '';
    try {
      previous = await port.read(config.evidencePath);
    } catch {
      previous = '';
    }
    await port.write(config.evidencePath, previous + batch.map(o => JSON.stringify(o) + '\n').join(''));
  }).catch(() => undefined);
}

function textLength(content: unknown): number {
  if (!Array.isArray(content)) return typeof content === 'string' ? content.length : 0;
  return content.reduce((n: number, block: any) => n + (block?.type === 'text' && typeof block.text === 'string' ? block.text.length : 0), 0);
}

async function begin($: EngineInterface, e: object, next: Next): Promise<any> {
  held.port = {
    read: async path => {
      const result: any = await $.fs.read(path);
      return typeof result === 'string' ? result : '';
    },
    write: (path, text) => $.fs.write(path, text),
    fetch: async (url, init) => {
      const r = await $.http.fetch(url, init);
      return { status: r.status, ok: r.ok, text: r.text };
    },
    run: async argv => {
      const r = await $.process.run(argv);
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr };
    },
    submit: async text => {
      const r: any = await $.prompt.submit({ text });
      return r.drop === undefined ? {} : { drop: String(r.drop) };
    },
    every: (ms, fn) => $.clock.every(ms, fn),
    root: $.plugin.root,
  };
  if (held.config === null) {
    try {
      held.config = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/probe-config.json`) as string);
    } catch (error) {
      held.config = null;
    }
  }
  const result = await next(e as never);
  if ('turnId' in e) {
    record({ obs: 'turn.start', hasAgentId: (e as any).agentId !== undefined, turnId: (e as any).turnId });
    flush();
    return result;
  }
  record({ obs: 'session.start', keys: Object.keys(e) });
  if (held.started || held.port === null || held.config === null) {
    flush();
    return result;
  }
  held.started = true;
  void startup(held.port, held.config);
  return result;
}

async function startup(port: Port, config: Config): Promise<void> {
  try {
    const url = `http://iter8/agent/state?owner=${config.owner}`;
    const r = await port.fetch(url, { socketPath: config.socketPath });
    record({ obs: 'socket-fetch', url, status: r.status, ok: r.ok, body: r.text });
  } catch (error) {
    record({ obs: 'socket-fetch', error: String(error) });
  }
  try {
    const r = await port.run(['sh', '-c', ANCESTRY]);
    record({ obs: 'child-ancestry', exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr });
  } catch (error) {
    record({ obs: 'child-ancestry', error: String(error) });
  }
  let polling = false;
  port.every(500, () => {
    if (polling) return;
    polling = true;
    void poll(port, config).finally(() => {
      polling = false;
    });
  });
}

async function poll(port: Port, config: Config): Promise<void> {
  if (!held.alive) {
    try {
      held.alive = (await port.read(config.clearCheckPath)) !== '';
      if (held.alive) record({ obs: 'alive' });
    } catch {
      held.alive = false;
    }
  }
  try {
    const r = await port.fetch(`http://iter8/agent/wait?owner=${config.owner}&timeoutSeconds=1`, { socketPath: config.socketPath });
    if (r.status !== 200) {
      record({ obs: 'wait-error', status: r.status });
      return;
    }
    const answer = JSON.parse(r.text);
    if (answer.outcome !== 'deliver') return;
    for (const delivery of answer.deliveries) {
      if (delivery.kind !== 'page-message') continue;
      record({ obs: 'submit-start', messageId: delivery.messageId });
      const result = await port.submit(delivery.text);
      record({ obs: 'submit-result', messageId: delivery.messageId, drop: result.drop ?? null });
    }
  } catch (error) {
    record({ obs: 'wait-error', error: String(error) });
  }
}

export function register(on: any): void {
  held.instance = Math.random().toString(36).slice(2, 10);
  on('session.start', begin);
  on('turn.start', begin);

  on('session.end', async ($: EngineInterface, e: any, next: Next) => {
    record({ obs: 'session.end', keys: Object.keys(e ?? {}) });
    return next(e);
  });

  on('turn.complete', async ($: EngineInterface, e: any, next: Next) => {
    record({ obs: 'turn.complete', hasAgentId: e.agentId !== undefined, isAborted: e.isAborted === true, reason: e.reason, turnId: e.turnId });
    return next(e);
  });

  on('session.append', async ($: EngineInterface, e: any, next: Next) => {
    record({
      obs: 'append',
      door: e.door,
      originKind: e.origin?.kind,
      messageType: e.message?.type,
      hasAgentId: e.agentId !== undefined,
      textLength: textLength(e.message?.content),
    });
    return next(e);
  });

  on('tool.call', async ($: EngineInterface, e: any, next: Next) => {
    record({ obs: 'tool-call', tool: e.tool, hasAgentId: e.agentId !== undefined });
    return next(e);
  });

  on('classic.PreToolUse', async ($: EngineInterface, e: any, next: Next) => {
    record({ obs: 'pre-tool', tool: e.tool, hasAgentId: e.agentId !== undefined });
    return next(e);
  });

  on('classic.PostToolUse', async ($: EngineInterface, e: any, next: Next) => {
    record({ obs: 'post-tool', tool: e.tool_name, hasAgentId: e.agent_id !== undefined });
    return next(e);
  });
}
