import type { SourceFrame } from "@iter8/protocol"
import { getRawOwnerStack, getRawSource, type StackFrame } from "bippy/source"
import type { Adapter } from "./lead"

type Fiber = Parameters<typeof getRawSource>[0]

function isFiber(value: unknown): value is Fiber {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "tag") === "number"
  )
}

// Repeats bippy's DOM-property lookup: bippy's typed entry for it installs the devtools hook on import.
function fiberOf(element: Element): Fiber | null {
  const key = Object.keys(element).find((name) => name.startsWith("__reactFiber$"))
  if (key === undefined) return null
  const fiber: unknown = Reflect.get(element, key)
  return isFiber(fiber) ? fiber : null
}

function ownName(value: object): string | null {
  for (const key of ["displayName", "name"]) {
    const name: unknown = Reflect.get(value, key)
    if (typeof name === "string" && name !== "") return name
  }
  return null
}

function displayName(type: unknown): string | null {
  if (typeof type === "function") return ownName(type)
  if (typeof type !== "object" || type === null) return null
  return ownName(type) ?? displayName(Reflect.get(type, "type") ?? Reflect.get(type, "render"))
}

function componentOf(fiber: Fiber): string | null {
  const owner = fiber._debugOwner
  if (owner != null) {
    const name = isFiber(owner) ? displayName(Reflect.get(owner, "type")) : (owner.name ?? null)
    if (name !== null && name !== "") return name
  }
  for (let current = fiber.return; current !== null; current = current.return) {
    const type: unknown = Reflect.get(current, "type")
    if (typeof type === "function" || (typeof type === "object" && type !== null)) {
      return displayName(type)
    }
  }
  return null
}

const oneBased = (value: number | undefined) =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined

function toFrame(kind: SourceFrame["kind"], location: StackFrame): SourceFrame | null {
  if (location.fileName === undefined || location.fileName === "") return null
  const line = oneBased(location.lineNumber)
  const column = oneBased(location.columnNumber)
  return {
    kind,
    file: location.fileName,
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
    ...(location.functionName ? { component: location.functionName } : {}),
  }
}

export const reactEvidence: Adapter = (element) => {
  const fiber = fiberOf(element)
  if (fiber === null) return null
  const own = getRawSource(fiber)
  // React 18 hands back `_debugSource` itself, a compiled-in path; React 19 parses a stack URL.
  const ownKind = own !== null && own === fiber._debugSource ? "source" : "generated"
  const candidates = [
    own === null ? null : toFrame(ownKind, own),
    ...getRawOwnerStack(fiber).map((frame) => toFrame("generated", frame)),
  ]
  const seen = new Set<string>()
  const frames: SourceFrame[] = []
  for (const frame of candidates) {
    if (frame === null) continue
    const site = `${frame.file}:${frame.line}:${frame.column}`
    if (seen.has(site)) continue
    seen.add(site)
    frames.push(frame)
  }
  if (frames.length === 0) return null
  return {
    framework: "react",
    major: null,
    component: componentOf(fiber),
    frames,
    onPickedElement: true,
  }
}
