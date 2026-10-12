import { type MarkdownToJSX, parser, RuleType } from "markdown-to-jsx/html"
import type { ComponentChildren } from "preact"
import { useEffect, useMemo, useState } from "preact/hooks"
import { parse } from "sugar-high/core"
import * as css from "sugar-high/lang/css"
import * as diff from "sugar-high/lang/diff"
import * as go from "sugar-high/lang/go"
import * as html from "sugar-high/lang/html"
import * as javascript from "sugar-high/lang/javascript"
import * as json from "sugar-high/lang/json"
import * as markdown from "sugar-high/lang/markdown"
import * as python from "sugar-high/lang/python"
import * as rust from "sugar-high/lang/rust"
import * as shell from "sugar-high/lang/shell"
import * as sql from "sugar-high/lang/sql"
import * as typescript from "sugar-high/lang/typescript"
import * as yaml from "sugar-high/lang/yaml"
import { useOverlay, useSheet } from "./context"
import { Icon, type IconName } from "./glyphs"
import markdownCss from "./markdown.css" with { type: "text" }

type Node = MarkdownToJSX.ASTNode
type Render = { base: string; notes: string[] }

const PARSE = { disableParsingRawHTML: true } as const
const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"])
const INLINE_TAGS = new Set(["strong", "em", "del", "mark", "ins", "sub", "sup"])
const NUMBER = /^[\d.]/
const COPIED_MS = 1400
const NUMBERED_FROM = 6

const ALERTS: Record<string, { icon: IconName; title: string }> = {
  NOTE: { icon: "info", title: "Note" },
  TIP: { icon: "bulb", title: "Tip" },
  IMPORTANT: { icon: "flag", title: "Important" },
  WARNING: { icon: "alert", title: "Warning" },
  CAUTION: { icon: "octagon", title: "Caution" },
}

const LANGUAGES: Record<string, object> = {
  javascript,
  js: javascript,
  jsx: javascript,
  mjs: javascript,
  typescript,
  ts: typescript,
  tsx: typescript,
  json,
  jsonc: json,
  shell,
  sh: shell,
  bash: shell,
  zsh: shell,
  console: shell,
  python,
  py: python,
  css,
  scss: css,
  diff,
  patch: diff,
  go,
  rust,
  rs: rust,
  yaml,
  yml: yaml,
  sql,
  html,
  xml: html,
  svg: html,
  markdown,
  md: markdown,
}

const TOKEN_CLASS: Record<string, string> = {
  keyword: "tk-kw",
  string: "tk-str",
  class: "tk-ty",
  jsxliterals: "tk-ty",
  entity: "tk-fn",
  property: "tk-attr",
  comment: "tk-cm",
  sign: "tk-pn",
}

/** The URL's own normal form, so what is checked is exactly what the browser would follow. */
export function linkHref(target: string | null | undefined): string | null {
  if (!target) return null
  try {
    const url = new URL(target.trim())
    return LINK_PROTOCOLS.has(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

type ImageSource = { kind: "inline" | "remote"; src: string; host: string }

/** Only the page's own origin and `data:`/`blob:` load on sight; any other origin waits for a click. */
export function imageSource(target: string | null | undefined, base: string): ImageSource | null {
  if (!target) return null
  try {
    const url = new URL(target.trim(), base)
    const host = url.host
    switch (url.protocol) {
      case "data:":
        return /^data:image\//i.test(url.href) ? { kind: "inline", src: url.href, host } : null
      case "blob:":
        return { kind: "inline", src: url.href, host }
      case "http:":
      case "https:":
        return {
          kind: url.origin === new URL(base).origin ? "inline" : "remote",
          src: url.href,
          host,
        }
      default:
        return null
    }
  } catch {
    return null
  }
}

function plainLines(code: string): ComponentChildren[] {
  return code.split("\n").map((text, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: lines never reorder
    <span key={index} class="line">
      {text}
    </span>
  ))
}

/** Null when the highlighter's line count disagrees with the plain one, so a swap never moves a line. */
export function highlightLines(code: string, language: object): ComponentChildren[] | null {
  const plain = code.split("\n").length
  const parsed = parse(code, language)
  if (parsed.lines.length !== plain) return null
  return parsed.lines.map((line) => {
    const mark = line.annotations.includes("diff-add")
      ? " add"
      : line.annotations.includes("diff-remove")
        ? " del"
        : ""
    let offset = 0
    return (
      <span key={line.index} class={`line${mark}`}>
        {line.tokens.map((token) => {
          const at = offset
          offset += token.value.length
          if (token.value === "") return null
          const name =
            token.type === "class" && NUMBER.test(token.value) ? "tk-num" : TOKEN_CLASS[token.type]
          return name ? (
            <span key={at} class={name}>
              {token.value}
            </span>
          ) : (
            token.value
          )
        })}
      </span>
    )
  })
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const { model } = useOverlay()
  const language = LANGUAGES[lang.toLowerCase()]
  const [lines, setLines] = useState<ComponentChildren[] | null>(null)
  const [copied, setCopied] = useState(false)
  const plain = useMemo(() => plainLines(code), [code])

  // A timer per block, so a history full of code is many short tasks instead of one long one.
  useEffect(() => {
    if (!language) return
    const timer = setTimeout(() => setLines(highlightLines(code, language)), 0)
    return () => clearTimeout(timer)
  }, [code, language])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  function copy() {
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(code))
      .then(
        () => setCopied(true),
        () => model.pushToast("Couldn't copy", { tone: "failed" }),
      )
  }

  return (
    <figure class={`md-code${plain.length >= NUMBERED_FROM ? " nums" : ""}`} data-lang={lang}>
      <figcaption class="md-code-bar">
        <span class="md-lang">{lang || "text"}</span>
        <button type="button" class={`md-copy${copied ? " done" : ""}`} onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={13} />
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </figcaption>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling block must be reachable by keyboard */}
      <pre tabIndex={0}>
        <code>{lines ?? plain}</code>
      </pre>
    </figure>
  )
}

function RemoteImage({ src, alt, host }: { src: string; alt: string; host: string }) {
  const [state, setState] = useState<"chip" | "image" | "failed">("chip")
  if (state === "image") {
    return (
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerpolicy="no-referrer"
        onError={() => setState("failed")}
      />
    )
  }
  const label = alt || "Image"
  if (state === "failed") {
    return (
      <span class="md-chip md-chip-failed">
        <span class="md-chip-alt">{label}</span>
        <span class="md-chip-host">couldn't load from {host}</span>
      </span>
    )
  }
  return (
    <button
      type="button"
      class="md-chip"
      aria-label={`Load image from ${host}: ${label}`}
      onClick={() => setState("image")}
    >
      <span class="md-chip-alt">{label}</span>
      <span class="md-chip-host">{host}</span>
    </button>
  )
}

function jump(from: HTMLElement, selector: string, flash: boolean) {
  const target = from.closest(".md")?.querySelector<HTMLElement>(selector)
  if (!target) return
  target.scrollIntoView({ block: "nearest" })
  if (!flash) return
  target.classList.remove("hit")
  void target.offsetWidth
  target.classList.add("hit")
}

function image(node: MarkdownToJSX.ImageNode, ctx: Render, block: boolean): ComponentChildren {
  const alt = node.alt ?? ""
  const source = imageSource(node.target, ctx.base)
  if (!source) return alt
  if (source.kind === "remote") {
    return <RemoteImage src={source.src} alt={alt} host={source.host} />
  }
  const img = <img src={source.src} alt={alt} loading="lazy" decoding="async" />
  return block && alt ? (
    <>
      {img}
      <figcaption>{alt}</figcaption>
    </>
  ) : (
    img
  )
}

function children(nodes: readonly Node[] | undefined, ctx: Render): ComponentChildren {
  return (nodes ?? []).map((node, index) => render(node, index, ctx))
}

function listItem(item: Node[], index: number, ctx: Render): ComponentChildren {
  const [first, second, ...rest] = item
  if (first?.type === RuleType.gfmTask) {
    const body = second?.type === RuleType.text && second.text.trim() === "" ? rest : item.slice(1)
    return (
      <li key={index} class="task-list-item">
        <input type="checkbox" checked={first.completed} disabled />
        {children(body, ctx)}
      </li>
    )
  }
  return <li key={index}>{children(item, ctx)}</li>
}

function render(node: Node, key: number, ctx: Render): ComponentChildren {
  switch (node.type) {
    case RuleType.text:
      return node.text
    case RuleType.textFormatted: {
      if (!INLINE_TAGS.has(node.tag)) return children(node.children, ctx)
      const Tag = node.tag as "strong"
      return <Tag key={key}>{children(node.children, ctx)}</Tag>
    }
    case RuleType.codeInline:
      return <code key={key}>{node.text}</code>
    case RuleType.breakLine:
      return <br key={key} />
    case RuleType.breakThematic:
      return <hr key={key} />
    case RuleType.paragraph: {
      const [only] = node.children
      if (only?.type === RuleType.image && node.children.length === 1) {
        const picture = image(only, ctx, true)
        return typeof picture === "string" ? (
          <p key={key}>{picture}</p>
        ) : (
          <figure key={key} class="md-img">
            {picture}
          </figure>
        )
      }
      return <p key={key}>{children(node.children, ctx)}</p>
    }
    case RuleType.heading: {
      const Tag = `h${node.level}` as "h1"
      return <Tag key={key}>{children(node.children, ctx)}</Tag>
    }
    case RuleType.blockQuote: {
      const alert = node.alert ? ALERTS[node.alert.toUpperCase()] : undefined
      if (!alert) return <blockquote key={key}>{children(node.children, ctx)}</blockquote>
      return (
        <div key={key} class="md-alert" data-kind={node.alert?.toLowerCase()}>
          <p class="md-alert-title">
            <Icon name={alert.icon} size={15} />
            {alert.title}
          </p>
          {children(node.children, ctx)}
        </div>
      )
    }
    case RuleType.codeBlock:
      return <CodeBlock key={key} code={node.text} lang={node.lang ?? ""} />
    case RuleType.link: {
      const href = linkHref(node.target)
      if (!href) return children(node.children, ctx)
      return (
        <a key={key} href={href} title={node.title} target="_blank" rel="noopener noreferrer">
          {children(node.children, ctx)}
        </a>
      )
    }
    case RuleType.image:
      return image(node, ctx, false)
    case RuleType.orderedList:
      return (
        <ol key={key} start={node.start}>
          {node.items.map((item, index) => listItem(item, index, ctx))}
        </ol>
      )
    case RuleType.unorderedList:
      return <ul key={key}>{node.items.map((item, index) => listItem(item, index, ctx))}</ul>
    case RuleType.table: {
      const align = (index: number) => {
        const value = node.align[index]
        return value ? { textAlign: value } : undefined
      }
      return (
        <section
          key={key}
          class="md-scroll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling table must be reachable by keyboard
          tabIndex={0}
          aria-label="Table, scrolls sideways"
        >
          <table>
            <thead>
              <tr>
                {node.header.map((cell, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
                  <th key={index} style={align(index)}>
                    {children(cell, ctx)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.cells.map((row, rowIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows never reorder
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns never reorder
                    <td key={index} style={align(index)}>
                      {children(cell, ctx)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )
    }
    case RuleType.footnoteReference: {
      const number = ctx.notes.indexOf(node.text) + 1
      if (number === 0) return `[${node.text}]`
      return (
        <sup key={key} class="fn">
          <button
            type="button"
            class="fn-ref"
            aria-label={`Footnote ${number}`}
            data-fn-ref={node.text}
            onClick={(event) =>
              jump(event.currentTarget, `li[data-fn="${CSS.escape(node.text)}"]`, true)
            }
          >
            {number}
          </button>
        </sup>
      )
    }
    default:
      return null
  }
}

function footnotes(definitions: [string, string][], ctx: Render): ComponentChildren {
  if (definitions.length === 0) return null
  return (
    <section class="footnotes">
      <ol>
        {definitions.map(([label, body]) => (
          <li key={label} data-fn={label}>
            <p>
              {children(parser(body, { ...PARSE, forceInline: true }), ctx)}
              <button
                type="button"
                class="fn-back"
                aria-label="Back to the text"
                onClick={(event) =>
                  jump(event.currentTarget, `button[data-fn-ref="${CSS.escape(label)}"]`, false)
                }
              >
                ↩
              </button>
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/**
 * Raw HTML in the source stays literal text, links outside http, https and mailto lose their
 * anchor, and an image from another origin waits for a click: no tag, attribute or request in the
 * result comes from the message except through those rules.
 */
export function renderMarkdown(text: string, base: string): ComponentChildren {
  let nodes: Node[]
  try {
    nodes = parser(text, PARSE)
  } catch {
    return <p>{text}</p>
  }
  const definitions: [string, string][] = []
  const body: Node[] = []
  for (const node of nodes) {
    if (node.type !== RuleType.refCollection) {
      body.push(node)
      continue
    }
    for (const [key, ref] of Object.entries(node.refs)) {
      if (key.startsWith("^")) definitions.push([key.slice(1), ref.target])
    }
  }
  const ctx: Render = { base, notes: definitions.map(([label]) => label) }
  return (
    <>
      {children(body, ctx)}
      {footnotes(definitions, ctx)}
    </>
  )
}

export function Markdown({ text }: { text: string }) {
  useSheet(markdownCss)
  const tree = useMemo(() => renderMarkdown(text, location.href), [text])
  return <div class="cv-text md">{tree}</div>
}
