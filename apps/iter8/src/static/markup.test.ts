import { expect, test } from "bun:test"
import {
  MARKUP_TEXT_LENGTH,
  MAX_MARKUP_STEPS,
  MarkupPath,
  ResolvedSourceLead,
  SourceLead,
} from "@iter8/protocol"
import fc from "fast-check"
import { locateInMarkup } from "./markup"

function markup(tags: string[], identity: Partial<MarkupPath> = {}): MarkupPath {
  return {
    url: "http://mock.localhost/",
    steps: tags.map((tag) => ({ tag, index: 0 })),
    id: null,
    className: null,
    text: "",
    onPickedElement: true,
    ...identity,
  }
}

function position(html: string, opening: string) {
  const offset = html.indexOf(opening)
  expect(offset).toBeGreaterThanOrEqual(0)
  const lines = html.slice(0, offset).split(/\r\n|\r|\n/)
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

test("a none lead's markup survives JSON and refuses identities outside the protocol limits", () => {
  const path = markup(["div"], { text: "hello" })
  const lead: SourceLead = { confidence: "none", markup: path }
  expect(SourceLead.parse(JSON.parse(JSON.stringify(lead)))).toEqual(lead)
  for (const invalid of [
    { ...path, steps: Array(MAX_MARKUP_STEPS + 1).fill({ tag: "div", index: 0 }) },
    { ...path, text: "x".repeat(MARKUP_TEXT_LENGTH + 1) },
    { ...path, steps: [{ tag: "div", index: -1 }] },
  ]) {
    expect(SourceLead.safeParse({ confidence: "none", markup: invalid }).success).toBe(false)
  }
  expect(
    SourceLead.safeParse({
      confidence: "exact",
      framework: "html",
      build: "unknown",
      component: null,
      frames: [{ kind: "source", file: "index.html" }],
    }).success,
  ).toBe(false)
  for (const confidence of ["exact", "approximate", "file-only"] as const) {
    expect(
      ResolvedSourceLead.safeParse({
        confidence,
        framework: "html",
        component: null,
        file: "index.html",
        ...(confidence === "file-only" ? {} : { line: 1, column: 1 }),
      }).success,
    ).toBe(true)
  }
  expect(
    MarkupPath.safeParse({
      ...path,
      steps: Array(MAX_MARKUP_STEPS).fill({ tag: "div", index: 0 }),
      text: "x".repeat(MARKUP_TEXT_LENGTH),
    }).success,
  ).toBe(true)
})

test("an implied tbody can be followed but cannot supply a start tag", () => {
  const html = "<body>\n  <table>\n    <tr><td>cell</td></tr>\n  </table>\n</body>"
  expect(locateInMarkup(html, markup(["table", "tbody", "tr"], { text: "cell" }))).toEqual({
    ...position(html, "<tr>"),
    exact: true,
  })
  expect(locateInMarkup(html, markup(["table", "tbody"], { text: "cell" }))).toEqual({
    ...position(html, "<table>"),
    exact: false,
  })
})

test("an auto-closed p leaves the div as a body child", () => {
  const html = "<body>\n<p>before\n<div>after</div>\n</body>"
  expect(locateInMarkup(html, markup(["div"], { text: "after" }))).toEqual({
    ...position(html, "<div>"),
    exact: true,
  })
  expect(locateInMarkup(html, markup(["p", "div"]))).toEqual({
    ...position(html, "<p>"),
    exact: false,
  })
})

test("tag text in comments and scripts does not count as elements", () => {
  const html =
    '<body>\n<!-- <div>comment</div> -->\n<script>const tag = "<div>script</div>"</script>\n<div id="real">real</div></body>'
  expect(locateInMarkup(html, markup(["div"], { id: "real", text: "real" }))).toEqual({
    ...position(html, '<div id="real">'),
    exact: true,
  })
})

test.each(["\n", "\r\n"])(
  "a multiline start tag uses the opening angle bracket with %j endings",
  (newline) => {
    const html = [
      "<body>",
      "  <div",
      '    id="target"',
      '    class="hero">Hello</div>',
      "</body>",
    ].join(newline)
    expect(
      locateInMarkup(html, markup(["div"], { id: "target", className: "hero", text: "Hello" })),
    ).toEqual({
      ...position(html, "<div"),
      exact: true,
    })
  },
)

test("an implied body with no locatable step resolves to null", () => {
  expect(locateInMarkup("<!doctype html><title>page</title>", markup([]))).toBeNull()
  expect(locateInMarkup("<!doctype html><title>page</title>", markup(["div"]))).toBeNull()
})

test.each([
  { id: "different" },
  { className: "different" },
  { text: "different" },
  { onPickedElement: false },
])("an identity mismatch or shadow pick is approximate: %j", (identity) => {
  const html = '<body>\n<div id="target" class="hero">Hello</div></body>'
  expect(
    locateInMarkup(
      html,
      markup(["div"], { id: "target", className: "hero", text: "Hello", ...identity }),
    ),
  ).toEqual({
    ...position(html, "<div"),
    exact: false,
  })
})

test("a path longer than the tree locates its deepest source ancestor", () => {
  const html = "<body>\n<section>\n  <div>Hello</div></section></body>"
  expect(locateInMarkup(html, markup(["section", "div", "span"], { text: "Hello" }))).toEqual({
    ...position(html, "<div>"),
    exact: false,
  })
})

test("text identity collapses descendant text, includes script text, and excludes comments and template content", () => {
  const html =
    "<body><div>\n  Hello<span>\tworld</span><!-- ignored --><template>hidden</template><script>!</script>  </div></body>"
  expect(locateInMarkup(html, markup(["div"], { text: "Hello world! " }))).toEqual({
    ...position(html, "<div>"),
    exact: true,
  })
})

test("text identity takes exactly the collapsed prefix", () => {
  const text = "a".repeat(MARKUP_TEXT_LENGTH + 10)
  const html = `<body><div>   ${text}</div></body>`
  expect(
    locateInMarkup(html, markup(["div"], { text: text.slice(0, MARKUP_TEXT_LENGTH) })),
  ).toEqual({
    ...position(html, "<div>"),
    exact: true,
  })
})

test("SVG adjusted names match the document's local names", () => {
  const html = "<body><svg><foreignObject><div>Hello</div></foreignObject></svg></body>"
  expect(locateInMarkup(html, markup(["svg", "foreignObject", "div"], { text: "Hello" }))).toEqual({
    ...position(html, "<div>"),
    exact: true,
  })
})

test("a markup path built from a generated document resolves to the start tag the generator wrote", () => {
  const string = fc
    .array(fc.constantFrom("a", "b", "é", "&", "<", '"', " ", "\t", "\n", "\u00a0"), {
      maxLength: 16,
    })
    .map((chars) => chars.join(""))
  const whitespace = fc.constantFrom("", " ", "\n", "\n  ", "\t")
  const entry = fc.record({
    tag: fc.constantFrom(
      "div",
      "span",
      "section",
      "article",
      "em",
      "strong",
      "main",
      "aside",
      "figure",
    ),
    parent: fc.nat(),
    id: fc.option(string, { nil: null }),
    className: fc.option(string, { nil: null }),
    text: string,
    before: whitespace,
    after: whitespace,
  })
  fc.assert(
    fc.property(fc.array(entry, { minLength: 1, maxLength: 40 }), fc.nat(), (entries, pick) => {
      type Node = (typeof entries)[number] & {
        children: Node[]
        steps: MarkupPath["steps"]
        line: number
        column: number
      }
      const roots: Node[] = []
      const nodes: Node[] = []
      for (const [index, item] of entries.entries()) {
        const parent = nodes[(item.parent % (index + 1)) - 1]
        const siblings = parent ? parent.children : roots
        const node: Node = {
          ...item,
          children: [],
          steps: [
            ...(parent?.steps ?? []),
            { tag: item.tag, index: siblings.filter((sibling) => sibling.tag === item.tag).length },
          ],
          line: 0,
          column: 0,
        }
        siblings.push(node)
        nodes.push(node)
      }
      const escapeHtml = (text: string) =>
        text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")
      let html = "<!doctype html>\n<html><head></head><body>"
      function serialize(node: Node) {
        html += node.before
        const lines = html.split("\n")
        node.line = lines.length
        node.column = (lines.at(-1)?.length ?? 0) + 1
        html += `<${node.tag}${node.id === null ? "" : ` id="${escapeHtml(node.id)}"`}${node.className === null ? "" : ` class="${escapeHtml(node.className)}"`}>${escapeHtml(node.text)}`
        for (const child of node.children) serialize(child)
        html += `</${node.tag}>${node.after}`
      }
      for (const node of roots) serialize(node)
      html += "</body></html>"
      function textContent(node: Node): string {
        return (
          node.text +
          node.children.map((child) => child.before + textContent(child) + child.after).join("")
        )
      }
      const target = nodes[pick % nodes.length]
      if (!target) throw new Error("Generated document has no target")
      expect(
        locateInMarkup(
          html,
          markup([], {
            steps: target.steps,
            id: target.id,
            className: target.className,
            text: textContent(target).replace(/\s+/g, " ").trimStart().slice(0, MARKUP_TEXT_LENGTH),
          }),
        ),
      ).toEqual({ line: target.line, column: target.column, exact: true })
    }),
    { numRuns: 200 },
  )
})
