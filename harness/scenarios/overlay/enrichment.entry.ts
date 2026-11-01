import { type Capture, type ResolvedSourceLead, Screenshot, type SourceLead } from "@iter8/protocol"
import { describeContext } from "../../../apps/overlay/src/enrich/context"
import { startErrorBuffer } from "../../../apps/overlay/src/enrich/errors"
import { enrich } from "../../../apps/overlay/src/enrich/run"
import { loadSourceLookup } from "../../../apps/overlay/src/enrich/source"

export type RunOptions = {
  /** Resolves the target both for the run and as its stored one-hop anchor selector. */
  selector: string
  sourceUrl: string | null
  resolved?: ResolvedSourceLead
  shot: boolean
  abortAfterMs?: number
  abortWhenIdleIsRead?: boolean
  /** Reports the last keystroke as landing when the run starts, instead of long ago. */
  typedAtStart?: boolean
  removeTargetOnSymbolicate?: boolean
  /** Removes the target when the screenshot render first asks whether a node is the overlay. */
  removeTargetOnRender?: boolean
  removeTargetOnUpload?: boolean
}

export type RunReport = {
  result: { outcome: "resolved"; capture: Capture } | { outcome: "rejected"; reason: unknown }
  symbolicated: SourceLead[]
  uploads: { type: string; size: number; width: number; height: number; atMs: number }[]
  /** Every value `idleSinceInput` answered, in order. */
  idleReads: number[]
  /** The steps in which the run removed the target, in order. */
  removals: ("symbolicate" | "render" | "upload")[]
  elapsedMs: number
}

export type EnrichmentHarness = {
  /** One selector per shadow-root hop, outermost first. */
  describeContext: (path: string[]) => ReturnType<typeof describeContext>
  startErrors: () => void
  recentErrors: () => NonNullable<Capture["consoleErrors"]>
  disposeErrors: () => void
  run: (options: RunOptions) => Promise<RunReport>
}

const required = (path: readonly string[]): Element => {
  let root: Document | ShadowRoot = document
  let el: Element | null = null
  for (const selector of path) {
    el = root.querySelector(selector)
    if (el === null) throw new Error(`No element matches ${path.join(" >> ")}`)
    if (el.shadowRoot !== null) root = el.shadowRoot
  }
  if (el === null) throw new Error("An empty selector path names no element")
  return el
}

const exclude = document.createElement("iter8-overlay")
document.documentElement.append(exclude)
exclude.attachShadow({ mode: "open" }).innerHTML = "<p>overlay</p>"

function createHarness(): EnrichmentHarness {
  let errors: ReturnType<typeof startErrorBuffer> | null = null
  return {
    describeContext: (selector) => describeContext(required(selector)),
    startErrors: () => {
      errors = startErrorBuffer()
    },
    recentErrors: () => errors?.recent() ?? [],
    disposeErrors: () => errors?.dispose(),
    run: async (options) => {
      const el = required([options.selector])
      const controller = new AbortController()
      const symbolicated: SourceLead[] = []
      const uploads: RunReport["uploads"] = []
      const idleReads: number[] = []
      const removals: RunReport["removals"] = []
      const removeTarget = (step: RunReport["removals"][number]) => {
        removals.push(step)
        el.remove()
      }
      if (options.removeTargetOnRender) {
        const contains = Node.prototype.contains
        exclude.contains = (node) => {
          if (!removals.includes("render")) removeTarget("render")
          return contains.call(exclude, node)
        }
      }
      const lookupSource =
        options.sourceUrl === null ? null : await loadSourceLookup(options.sourceUrl)
      const started = performance.now()
      if (options.abortAfterMs !== undefined) {
        setTimeout(() => controller.abort("cancelled by the test"), options.abortAfterMs)
      }
      try {
        const { capture } = await enrich(
          {
            el,
            anchor: {
              selector: [options.selector],
              box: { x: 0, y: 0, width: 1, height: 1 },
              renderGeneration: 0,
            },
          },
          {
            signal: controller.signal,
            lookupSource,
            symbolicate: async (lead) => {
              symbolicated.push(lead)
              if (options.removeTargetOnSymbolicate) removeTarget("symbolicate")
              return options.resolved ?? { confidence: "none", reason: "no-framework" }
            },
            uploadScreenshot: async (png) => {
              if (options.removeTargetOnUpload) removeTarget("upload")
              const bitmap = await createImageBitmap(png)
              uploads.push({
                type: png.type,
                size: png.size,
                width: bitmap.width,
                height: bitmap.height,
                atMs: performance.now() - started,
              })
              return Screenshot.parse({ ref: "shot-1", width: bitmap.width, height: bitmap.height })
            },
            errors: () => errors?.recent() ?? [],
            shot: options.shot,
            idleSinceInput: () => {
              if (options.abortWhenIdleIsRead) controller.abort("cancelled while waiting for idle")
              const idle = options.typedAtStart ? performance.now() - started : 1000
              idleReads.push(idle)
              return idle
            },
            exclude,
          },
        )
        return {
          result: { outcome: "resolved", capture },
          symbolicated,
          uploads,
          idleReads,
          removals,
          elapsedMs: performance.now() - started,
        }
      } catch (reason) {
        return {
          result: { outcome: "rejected", reason },
          symbolicated,
          uploads,
          idleReads,
          removals,
          elapsedMs: performance.now() - started,
        }
      } finally {
        Reflect.deleteProperty(exclude, "contains")
      }
    },
  }
}

Reflect.set(window, "__iter8Enrich", createHarness())
