import type { Adapter, Evidence } from "./lead"

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null
}

function highestMajor(versions: unknown): number | null {
  if (!(versions instanceof Set)) return null
  let highest: number | null = null
  for (const version of versions) {
    const major = Number(version)
    if (Number.isInteger(major) && (highest === null || major > highest)) highest = major
  }
  return highest
}

function componentName(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1)
  return base.endsWith(".svelte") ? base.slice(0, -".svelte".length) : base
}

/**
 * Maps an element's `__svelte_meta` to evidence. The compiler counts columns from 0, the protocol
 * from 1; lines already agree.
 */
export function svelteMetaEvidence(meta: unknown, major: number | null): Evidence | null {
  if (typeof meta !== "object" || meta === null) return null
  const loc: unknown = Reflect.get(meta, "loc")
  if (typeof loc !== "object" || loc === null) return null
  const file: unknown = Reflect.get(loc, "file")
  if (typeof file !== "string" || file === "") return null
  const line = numberOf(Reflect.get(loc, "line"))
  const column = numberOf(Reflect.get(loc, "column"))
  return {
    framework: "svelte",
    major,
    component: componentName(file),
    frames: [
      {
        kind: "source",
        file,
        ...(line !== null && line >= 1 ? { line } : {}),
        ...(column !== null && column >= 0 ? { column: column + 1 } : {}),
      },
    ],
    onPickedElement: true,
  }
}

export const svelteEvidence: Adapter = (element) => {
  const runtime: unknown = Reflect.get(window, "__svelte")
  const versions =
    typeof runtime === "object" && runtime !== null ? Reflect.get(runtime, "v") : null
  return svelteMetaEvidence(Reflect.get(element, "__svelte_meta"), highestMajor(versions))
}
