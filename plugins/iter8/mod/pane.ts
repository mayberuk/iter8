export const PANE_ID = 'iter8-round';

type PaneNote = {
  id: string;
  intent: string;
  status: 'open' | 'done' | 'answered';
  body: string;
};

export type PaneRound = {
  id: string;
  pageId: string;
  stage: string;
  sendNow: boolean;
  notes: readonly PaneNote[];
};

export type PaneView = {
  connection: 'live' | 'connecting' | 'unavailable' | 'incompatible';
  focus: { pageId: string; roundId: string | null } | null;
  rounds: readonly PaneRound[];
  pages: readonly { pageId: string; chat: { enabled: boolean; reachable: boolean } }[];
  waiting: number;
};

type Ui = { Box: (props: object) => unknown; Text: (props: object) => unknown };

const MARKS: Record<PaneNote['status'], string> = { open: '○', done: '✓', answered: '↩' };

const CONNECTION_MESSAGES = {
  connecting: 'Connecting to iter8…',
  unavailable: 'iter8 service unavailable — rounds still reach Claude through the shell hooks',
  incompatible: 'This iter8 version predates the mod — the shell hooks deliver rounds',
} as const;

// Note bodies are page-typed text; a tab or escape byte in one would corrupt the row it is drawn on.
function clean(text: string): string {
  return String(text).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}

function firstLine(body: string): string {
  return clean(String(body).split('\n')[0] ?? '').trim();
}

function noteCount(count: number): string {
  return `${count} ${count === 1 ? 'note' : 'notes'}`;
}

function chatState(chat: { enabled: boolean; reachable: boolean }): string {
  if (!chat.enabled) return 'off';
  return chat.reachable ? 'on' : 'on, not reachable';
}

export function paneTree(ui: Ui, view: PaneView, columns: number): unknown {
  const { Box, Text } = ui;
  const width = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 1;
  const column = (children: unknown[]) => Box({ flexDirection: 'column', children });
  const plain = (text: string) => Text({ children: text });
  const dim = (text: string) => Text({ dimColor: true, children: text });

  if (view.connection !== 'live') return column([dim(CONNECTION_MESSAGES[view.connection])]);

  const rows: unknown[] = [];
  const active = view.rounds.find(round => round.id === view.focus?.roundId) ?? view.rounds[0];

  if (active === undefined) {
    rows.push(plain('No open rounds for this session.'));
  } else {
    const resolved = active.notes.filter(note => note.status !== 'open').length;
    const stage = clean(active.stage) + (active.sendNow ? ' · Send now' : '');
    rows.push(
      Text({
        bold: true,
        children: `${clean(active.id)} · ${clean(active.pageId)} · ${stage} · ${resolved} of ${active.notes.length} resolved`,
      }),
    );
    for (const note of active.notes) {
      const prefix = `${MARKS[note.status]} ${clean(note.intent)} `;
      const bodyWidth = Math.max(1, width - [...prefix].length);
      rows.push(
        Box({
          flexDirection: 'row',
          children: [
            plain(prefix),
            Box({ width: bodyWidth, children: Text({ wrap: 'truncate-end', children: firstLine(note.body) }) }),
          ],
        }),
      );
    }
  }

  if (view.waiting > 0) rows.push(dim(`${view.waiting} waiting for Claude to finish this turn`));

  for (const round of view.rounds) {
    if (round === active) continue;
    rows.push(dim(`${clean(round.id)} · ${clean(round.pageId)} · ${clean(round.stage)} · ${noteCount(round.notes.length)}`));
  }

  for (const page of view.pages) rows.push(dim(`${clean(page.pageId)} chat: ${chatState(page.chat)}`));

  return column(rows);
}
