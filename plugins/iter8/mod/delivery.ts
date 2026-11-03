export type RoundPointer = { roundId: string; pageId: string; noteCount: number };

export type AgentDelivery =
  | { kind: 'round'; pointer: RoundPointer; text: string }
  | { kind: 'page-message'; messageId: string; pageId: string; text: string };

const POINTER_LINE =
  /^Review round (?<id>R[1-9][0-9]*) from (?<page>[a-z][a-z0-9-]{1,30}) · (?<count>[1-9][0-9]*) (?:(?<= 1 )note|(?<! 1 )notes) — run `iter8 show \k<id>`$/;

const MESSAGE_ID = /^M[1-9][0-9]*$/;
const PAGE_ID = /^[a-z][a-z0-9-]{1,30}$/;
const PAGE_MESSAGE_CLOSE = '</page-message>';

export function isPointerLine(line: string): boolean {
  return typeof line === 'string' && POINTER_LINE.test(line);
}

function pointerLineId(line: string): string | null {
  return POINTER_LINE.exec(line)?.groups?.id ?? null;
}

export function isWellFormed(delivery: AgentDelivery): boolean {
  if (typeof delivery.text !== 'string') return false;
  if (delivery.kind === 'round') {
    return isPointerLine(delivery.text) && pointerLineId(delivery.text) === delivery.pointer.roundId;
  }
  if (!MESSAGE_ID.test(delivery.messageId) || !PAGE_ID.test(delivery.pageId)) return false;
  const open = `<page-message id="${delivery.messageId}" page="${delivery.pageId}">`;
  const at = delivery.text.indexOf(open);
  return at !== -1 && delivery.text.indexOf(PAGE_MESSAGE_CLOSE, at + open.length) !== -1;
}

export type SubmitQueue = { waiting: readonly AgentDelivery[]; inFlight: AgentDelivery | null };

export const emptyQueue: SubmitQueue = { waiting: [], inFlight: null };

export function enqueue(
  queue: SubmitQueue,
  deliveries: readonly AgentDelivery[],
): { queue: SubmitQueue; dropped: AgentDelivery[] } {
  const accepted = deliveries.filter(isWellFormed);
  const dropped = deliveries.filter(delivery => !isWellFormed(delivery));
  return { queue: { ...queue, waiting: [...queue.waiting, ...accepted] }, dropped };
}

export function startNext(queue: SubmitQueue): { queue: SubmitQueue; submit: AgentDelivery | null } {
  const [head, ...rest] = queue.waiting;
  if (queue.inFlight !== null || head === undefined) return { queue, submit: null };
  return { queue: { waiting: rest, inFlight: head }, submit: head };
}

export function finishCurrent(queue: SubmitQueue): SubmitQueue {
  return { ...queue, inFlight: null };
}
