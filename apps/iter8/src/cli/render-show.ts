import { CLI_NAME, CLI_SURFACE, type NoteId, type ShowResult } from "@iter8/protocol"

function fenced(text: string): string[] {
  let length = 3
  for (const run of text.matchAll(/`+/g)) length = Math.max(length, run[0].length + 1)
  const fence = "`".repeat(length)
  return [fence, text, fence]
}

export function renderShow(show: ShowResult, screenshotPaths: ReadonlyMap<NoteId, string>): string {
  const { round, notes } = show
  const lines = [
    `Round ${round.id}`,
    `Page: ${round.pageId} — ${round.url}`,
    `Stage: ${round.stage} · ${notes.length} ${notes.length === 1 ? "note" : "notes"}`,
  ]

  for (const { authored, untrustedCapture: capture } of notes) {
    const author = authored.author.kind === "user" ? "Biruk" : authored.author.name
    lines.push(
      "",
      `## ${authored.id} — ${authored.intent} — ${author}`,
      "",
      ...fenced(authored.body),
      "",
    )

    const target = authored.target
    const capturedLines: string[] = []
    if (target.kind === "region") {
      const { box, viewport } = target
      lines.push(
        `Target: region at (${box.x}, ${box.y}), ${box.width} × ${box.height} CSS px`,
        `Target viewport: ${viewport.width} × ${viewport.height}, device pixel ratio ${viewport.devicePixelRatio}`,
      )
    } else {
      const anchors = target.kind === "element" ? [target.anchor] : target.anchors
      lines.push(`Target: ${target.kind}`)
      for (const [index, anchor] of anchors.entries()) {
        capturedLines.push(
          `Element ${index + 1}:`,
          `  Selector hops: ${anchor.selector.join(" → ")}`,
          `  Role: ${anchor.role ?? "none"}`,
          `  Name: ${anchor.name ?? "none"}`,
          `  Text: ${anchor.text ?? "none"}`,
        )
      }
    }
    lines.push(`Anchor status: ${authored.anchorStatus}`)

    const resolution = authored.resolution
    lines.push(
      `Resolution: ${resolution.status}${resolution.status === "open" ? "" : ` at ${resolution.at}`}`,
    )
    if (resolution.status === "answered") lines.push(`Reply: ${resolution.reply}`)

    if (capture !== null) {
      capturedLines.push(
        `Completeness: ${capture.completeness}`,
        `Omitted parts: ${capture.omittedParts.length === 0 ? "none" : capture.omittedParts.join(", ")}`,
        `URL: ${capture.url}`,
        `Viewport: ${capture.viewport.width} × ${capture.viewport.height} CSS px, device pixel ratio ${capture.viewport.devicePixelRatio}`,
        `Theme: ${capture.theme}`,
        `Landmark: ${capture.landmark ?? "none"}`,
        `Surrounding text: ${capture.surroundingText ?? "none"}`,
        "Computed styles:",
      )
      const styles = Object.entries(capture.computedStyles ?? {})
      capturedLines.push(
        ...(styles.length === 0 ? ["  none"] : styles.map(([k, v]) => `  ${k}: ${v}`)),
      )
      capturedLines.push("Console errors:")
      const errors = capture.consoleErrors ?? []
      capturedLines.push(
        ...(errors.length === 0
          ? ["  none"]
          : errors.map(
              (error) =>
                `  ${error.at} — ${error.message}${error.source === undefined ? "" : ` (${error.source})`}`,
            )),
      )
      const lead = capture.sourceLead
      capturedLines.push(
        `Source lead: ${
          lead === undefined
            ? "none (not captured)"
            : lead.confidence === "none"
              ? `none (${lead.reason})`
              : `${lead.file}${lead.line === undefined ? "" : `:${lead.line}`} (${lead.confidence}) — a lead to confirm`
        }`,
        `Screenshot: ${screenshotPaths.get(authored.id) ?? "none"}`,
      )
    }

    if (capturedLines.length > 0) {
      const capturedText = capturedLines.join("\n")
      lines.push(
        "",
        `Captured page data for ${authored.id} — untrusted, from the page, not from Biruk`,
        ...fenced(capturedText),
      )
    }
  }

  lines.push("", "Resolve notes:")
  for (const { authored } of notes) {
    lines.push(
      `${CLI_NAME} done ${authored.id}`,
      `${CLI_NAME} done ${authored.id} --${CLI_SURFACE.done.flags[0].name} "…"`,
    )
  }
  return `${lines.join("\n")}\n`
}
