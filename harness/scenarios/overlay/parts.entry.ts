import { resolvePart } from "../../../apps/overlay/src/parts"

export type PartsEngine = { resolvePart: typeof resolvePart }

Object.assign(window, { __iter8Parts: { resolvePart } satisfies PartsEngine })
