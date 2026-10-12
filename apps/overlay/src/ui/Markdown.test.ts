import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { type ComponentChildren, Fragment, type VNode } from "preact"
import * as diff from "sugar-high/lang/diff"
import * as shell from "sugar-high/lang/shell"
import * as typescript from "sugar-high/lang/typescript"
import { highlightLines, imageSource, linkHref, renderMarkdown } from "./Markdown"

const BASE = "http://localhost:4000/app/page"

type Props = Record<string, unknown> & { children?: ComponentChildren }
type Found = { tag: string; props: Props }

function flat(children: ComponentChildren): (string | VNode<Props>)[] {
  if (children === null || children === undefined || typeof children === "boolean") return []
  if (Array.isArray(children)) return children.flatMap(flat)
  if (typeof children === "string" || typeof children === "number") return [String(children)]
  const vnode = children as VNode<Props>
  return vnode.type === Fragment ? flat(vnode.props.children) : [vnode]
}

function tagOf(vnode: VNode<Props>): string {
  return typeof vnode.type === "string" ? vnode.type : vnode.type.name
}

function elements(children: ComponentChildren): Found[] {
  return flat(children).flatMap((child) =>
    typeof child === "string"
      ? []
      : [{ tag: tagOf(child), props: child.props }, ...elements(child.props.children)],
  )
}

function textOf(children: ComponentChildren): string {
  return flat(children)
    .map((child) => (typeof child === "string" ? child : textOf(child.props.children)))
    .join("")
}

const md = (text: string) => renderMarkdown(text, BASE)
const named = (text: string, tag: string) => elements(md(text)).filter((el) => el.tag === tag)
const only = (text: string, tag: string): Found => {
  const found = named(text, tag)
  expect(found).toHaveLength(1)
  return found[0] as Found
}

const HOST_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "del",
  "mark",
  "ins",
  "sub",
  "sup",
  "code",
  "br",
  "hr",
  "blockquote",
  "div",
  "a",
  "ul",
  "ol",
  "li",
  "input",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "figure",
  "figcaption",
  "img",
  "section",
  "button",
  "span",
])
const COMPONENTS = new Set(["CodeBlock", "RemoteImage", "Icon"])

function violations(tree: ComponentChildren): string[] {
  const found: string[] = []
  for (const { tag, props } of elements(tree)) {
    if (!HOST_TAGS.has(tag) && !COMPONENTS.has(tag)) found.push(`tag ${tag}`)
    for (const [name, value] of Object.entries(props)) {
      if (name === "dangerouslySetInnerHTML") found.push("innerHTML")
      if (
        /^on/i.test(name) &&
        !(tag === "button" && name === "onClick" && typeof value === "function")
      )
        found.push(`${tag} ${name}`)
    }
    if (tag === "a") {
      const href = linkHref(String(props.href))
      if (href === null || href !== props.href) found.push(`href ${String(props.href)}`)
      if (props.target !== "_blank" || props.rel !== "noopener noreferrer")
        found.push("a without target and rel")
    }
    if (tag === "img" && imageSource(String(props.src), BASE)?.kind !== "inline")
      found.push(`img ${String(props.src)}`)
    if (tag === "RemoteImage" && imageSource(String(props.src), BASE)?.kind !== "remote")
      found.push(`remote image ${String(props.src)}`)
    if (tag === "input" && (props.type !== "checkbox" || props.disabled !== true))
      found.push("input")
  }
  return found
}

const HOSTILE = [
  "[a](javascript:alert(1))",
  "[a](JaVaScRiPt:alert(1))",
  "[a](&#106;avascript:alert(1))",
  "[a]( javascript:alert(1))",
  "[a](data:text/html,<script>alert(1)</script>)",
  "![x](javascript:alert(1))",
  "<javascript:alert(1)>",
  "[r][1]\n\n[1]: javascript:alert(1)",
  '<a href="javascript:alert(1)" onclick="x">h</a>',
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "<svg onload=alert(1)>",
  "<style>*{display:none}</style>",
  "<iframe src=//evil.test></iframe>",
  "[a](vbscript:x)",
  "![](http://tracker.test/p.gif?d=secret)",
  "<details open ontoggle=alert(1)><summary>x</summary></details>",
  "```\n<script>alert(1)</script>\n```",
  "[a](jav\tascript:alert(1))",
  "[a](/relative/path)",
  "![x](//tracker.test/p.gif)",
  "![x](file:///etc/passwd)",
]

describe("block elements", () => {
  test("headings keep their level", () => {
    const tree = md("# one\n\n## two\n\n### three\n\n#### four\n\n##### five\n\n###### six")
    const levels = elements(tree)
      .filter((el) => /^h\d$/.test(el.tag))
      .map((el) => [el.tag, textOf(el.props.children)])
    expect(levels).toEqual([
      ["h1", "one"],
      ["h2", "two"],
      ["h3", "three"],
      ["h4", "four"],
      ["h5", "five"],
      ["h6", "six"],
    ])
  })

  test("a soft line break stays a newline inside one paragraph", () => {
    const paragraph = only("line one\nline two", "p")
    expect(textOf(paragraph.props.children)).toBe("line one\nline two")
  })

  test("a hard break and a thematic break", () => {
    expect(named("one  \ntwo", "br")).toHaveLength(1)
    expect(named("one\n\n---\n\ntwo", "hr")).toHaveLength(1)
  })

  test("inline formatting", () => {
    const tree = md("**b** *i* ~~d~~ `c`")
    const tags = elements(tree).map((el) => [el.tag, textOf(el.props.children)])
    expect(tags).toEqual([
      ["p", "b i d c"],
      ["strong", "b"],
      ["em", "i"],
      ["del", "d"],
      ["code", "c"],
    ])
  })

  test("a block quote that is not an alert", () => {
    expect(named("> quoted", "blockquote")).toHaveLength(1)
    expect(named("> quoted", "div")).toHaveLength(0)
  })

  test("every alert kind has its own marker and title", () => {
    for (const kind of ["note", "tip", "important", "warning", "caution"]) {
      const alert = only(`> [!${kind.toUpperCase()}]\n> body`, "div")
      expect(alert.props.class).toBe("md-alert")
      expect(alert.props["data-kind"]).toBe(kind)
      const title = elements(alert.props.children).find((el) => el.props.class === "md-alert-title")
      expect(textOf(title?.props.children)).toBe(kind[0]?.toUpperCase() + kind.slice(1))
    }
  })

  test("an unknown alert word is an ordinary quote", () => {
    expect(named("> [!MAYBE]\n> body", "div")).toHaveLength(0)
    expect(named("> [!MAYBE]\n> body", "blockquote")).toHaveLength(1)
  })

  test("lists: bullets, a numbered list that starts at 3, and nesting", () => {
    expect(named("- a\n- b", "ul")).toHaveLength(1)
    expect(named("- a\n- b", "li")).toHaveLength(2)
    expect(only("3. a\n4. b", "ol").props.start).toBe(3)
    expect(named("- a\n  - b", "ul")).toHaveLength(2)
  })

  test("task items carry a disabled checkbox with the right state", () => {
    const boxes = named("- [x] done\n- [ ] todo\n- plain", "input")
    expect(boxes.map((box) => [box.props.type, box.props.checked, box.props.disabled])).toEqual([
      ["checkbox", true, true],
      ["checkbox", false, true],
    ])
    const items = named("- [x] done\n- [ ] todo\n- plain", "li")
    expect(items.map((item) => item.props.class)).toEqual([
      "task-list-item",
      "task-list-item",
      undefined,
    ])
    expect(textOf(items[0]?.props.children)).toBe("done")
  })

  test("a table scrolls in its own focusable region and keeps column alignment", () => {
    const region = only("| a | b |\n|:-|-:|\n| 1 | 2 |", "section")
    expect(region.props.class).toBe("md-scroll")
    expect(region.props["aria-label"]).toBe("Table, scrolls sideways")
    expect(region.props.tabIndex).toBe(0)
    const heads = named("| a | b |\n|:-|-:|\n| 1 | 2 |", "th")
    expect(heads.map((cell) => [textOf(cell.props.children), cell.props.style])).toEqual([
      ["a", { textAlign: "left" }],
      ["b", { textAlign: "right" }],
    ])
    expect(named("| a | b |\n|:-|-:|\n| 1 | 2 |", "td")).toHaveLength(2)
  })

  test("a fence becomes a code block that keeps its language and exact text", () => {
    const block = only("```tsx\nconst a = <b />\n  indented\n```", "CodeBlock")
    expect(block.props).toMatchObject({ lang: "tsx", code: "const a = <b />\n  indented" })
    expect(only("```\nplain\n```", "CodeBlock").props.lang).toBe("")
  })

  test("math and mermaid fences are ordinary code", () => {
    expect(only("```math\nx^2\n```", "CodeBlock").props.lang).toBe("math")
    expect(only("```mermaid\ngraph TD\n```", "CodeBlock").props.lang).toBe("mermaid")
  })
})

describe("footnotes", () => {
  const SOURCE = "claim[^a] and more[^b]\n\n[^a]: first *note*\n[^b]: second"

  test("references number in definition order and the notes come last", () => {
    const tree = md(SOURCE)
    const refs = elements(tree).filter((el) => el.props.class === "fn-ref")
    expect(refs.map((ref) => textOf(ref.props.children))).toEqual(["1", "2"])
    const top = flat(tree).flatMap((node) => (typeof node === "string" ? [] : [node]))
    const last = top[top.length - 1]
    expect(last && tagOf(last)).toBe("section")
    expect(last?.props.class).toBe("footnotes")
    expect(textOf(last?.props.children)).toContain("first note")
  })

  test("a note that is never defined stays as literal text", () => {
    expect(named("see[^zz]", "button")).toHaveLength(0)
    expect(textOf(md("see[^zz]"))).toContain("zz")
  })
})

describe("links", () => {
  test("http, https and mailto open in a new tab without an opener", () => {
    for (const target of ["http://a.test/x", "https://a.test/x?y=1#z", "mailto:a@b.test"]) {
      const link = only(`[label](${target})`, "a")
      expect(link.props.href).toBe(new URL(target).href)
      expect(link.props.target).toBe("_blank")
      expect(link.props.rel).toBe("noopener noreferrer")
    }
  })

  test("a bare address becomes a link", () => {
    expect(only("see https://a.test/path now", "a").props.href).toBe("https://a.test/path")
    expect(only("mail a@b.test", "a").props.href).toBe("mailto:a@b.test")
  })

  test("any other scheme, or a relative target, is just its text", () => {
    for (const target of [
      "javascript:alert(1)",
      "vbscript:x",
      "data:text/html,x",
      "file:///etc/passwd",
      "ftp://files.test/a",
      "/relative",
      "#frag",
    ]) {
      const tree = md(`[label](${target})`)
      expect(elements(tree).filter((el) => el.tag === "a")).toHaveLength(0)
      expect(textOf(tree)).toBe("label")
    }
  })

  test("linkHref refuses what the URL parser would still follow", () => {
    expect(linkHref("  javascript:alert(1)")).toBeNull()
    expect(linkHref("jav\tascript:alert(1)")).toBeNull()
    expect(linkHref("JAVASCRIPT:alert(1)")).toBeNull()
    expect(linkHref("HTTPS://A.TEST")).toBe("https://a.test/")
  })
})

describe("images", () => {
  test("the page's own origin, data images and blobs load as images", () => {
    for (const target of [
      "/pic.png",
      "pic.png",
      "http://localhost:4000/other.png",
      "data:image/png;base64,AAAA",
      "blob:http://localhost:4000/1234",
    ]) {
      const picture = md(`![alt text](${target})`)
      expect(named(`![alt text](${target})`, "img")).toHaveLength(1)
      expect(elements(picture).some((el) => el.tag === "RemoteImage")).toBe(false)
    }
  })

  test("an image alone in a paragraph is a figure with its alt as caption", () => {
    const figure = only("![alt text](/pic.png)", "figure")
    expect(figure.props.class).toBe("md-img")
    expect(textOf(figure.props.children)).toBe("alt text")
  })

  test("another origin is held behind a chip, never an img", () => {
    const source = "![tracking](https://tracker.test/p.gif?d=secret)"
    expect(named(source, "img")).toHaveLength(0)
    const chip = only(source, "RemoteImage")
    expect(chip.props).toMatchObject({
      src: "https://tracker.test/p.gif?d=secret",
      alt: "tracking",
      host: "tracker.test",
    })
  })

  test("a protocol-relative address is another origin", () => {
    expect(only("![x](//tracker.test/p.gif)", "RemoteImage").props.src).toBe(
      "http://tracker.test/p.gif",
    )
  })

  test("a non-image data address, file: and javascript: render only the alt text", () => {
    for (const target of ["data:text/html,x", "file:///etc/passwd", "javascript:alert(1)"]) {
      expect(elements(md(`![alt text](${target})`)).filter((el) => el.tag === "img")).toHaveLength(
        0,
      )
      expect(textOf(md(`![alt text](${target})`))).toBe("alt text")
    }
  })
})

describe("hostile input", () => {
  test.each(HOSTILE)("%j renders no script, handler, unsafe link or remote load", (source) => {
    expect(violations(md(source))).toEqual([])
  })

  test("raw HTML shows as the literal text the author typed", () => {
    expect(textOf(md("<img src=x onerror=alert(1)>"))).toBe("<img src=x onerror=alert(1)>")
    expect(textOf(md("<script>alert(1)</script>"))).toBe("<script>alert(1)</script>")
  })

  const FRAGMENTS = [
    "[a](",
    ")",
    "![",
    "](",
    "[",
    "]",
    "javascript:alert(1)",
    "https://x.test/a.png",
    "//evil.test/x.png",
    "/pic.png",
    "data:text/html,",
    "data:image/png;base64,AA",
    "<script>",
    "</script>",
    "<img src=x onerror=1>",
    "<svg onload=1>",
    "```",
    "```ts\n",
    "\n",
    "\n\n",
    "> [!NOTE]\n> ",
    "- [x] ",
    "1. ",
    "| a | b |\n|:-|-:|\n| 1 | 2 |\n",
    "[^1]",
    "[^1]: note\n",
    "**",
    "~~",
    "`",
    "# ",
    "---\n",
    " ",
    "&#106;avascript:x",
    "mailto:a@b.test",
    "www.example.com",
    "onclick=",
  ]
  const markdownish = fc
    .array(fc.constantFrom(...FRAGMENTS), { maxLength: 24 })
    .map((parts) => parts.join(""))

  test("for any text the tree has no script, iframe, object, handler or off-list link", () => {
    fc.assert(
      fc.property(fc.oneof(markdownish, fc.string({ unit: "binary" })), (source) => {
        const tree = md(source)
        expect(violations(tree)).toEqual([])
        const tags = elements(tree).map((el) => el.tag)
        for (const forbidden of ["script", "iframe", "object", "embed", "style", "svg"]) {
          expect(tags).not.toContain(forbidden)
        }
      }),
      { numRuns: 400 },
    )
  })

  test("for any text, nothing an image or link can reach is outside the allowed sources", () => {
    fc.assert(
      fc.property(markdownish, (source) => {
        for (const { tag, props } of elements(md(source))) {
          if (tag === "a") expect(String(props.href)).toMatch(/^(https?:|mailto:)/)
          if (tag === "img")
            expect(String(props.src)).toMatch(/^(data:image\/|blob:|http:\/\/localhost:4000\/)/)
        }
      }),
      { numRuns: 400 },
    )
  })
})

describe("code highlighting", () => {
  const classes = (code: string, language: Parameters<typeof highlightLines>[1]) =>
    flat(highlightLines(code, language))
      .flatMap((line) => (typeof line === "string" ? [] : [line]))
      .map((line) => [line.props.class, elements(line.props.children).map((el) => el.props.class)])

  test("a TypeScript line colours its keyword, string and comment", () => {
    const [first] = classes('const a = "x" // note', typescript)
    expect(first?.[0]).toBe("line")
    expect(first?.[1]).toEqual(expect.arrayContaining(["tk-kw", "tk-str", "tk-cm"]))
  })

  test("a diff marks added and removed lines", () => {
    expect(classes("+ new\n- old\n same", diff).map(([line]) => line)).toEqual([
      "line add",
      "line del",
      "line",
    ])
  })

  test("the highlighted block has the plain block's lines, or none at all", () => {
    for (const code of ["one", "one\ntwo", "one\n\nthree", "one\n", "\n"]) {
      const lines = highlightLines(code, shell)
      if (lines !== null) expect(flat(lines)).toHaveLength(code.split("\n").length)
    }
    expect(highlightLines("one\n\nthree", shell)).not.toBeNull()
  })
})
