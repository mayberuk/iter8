import { type ComponentProps, render } from "preact"
import { registerFonts } from "../../../apps/overlay/src/ui/fonts"
import {
  Avatar,
  ClaudeMarkSymbol,
  Icon,
  IntentGlyph,
  Meter,
  StatusGlyph,
} from "../../../apps/overlay/src/ui/glyphs"

export type Item =
  | { kind: "icon"; props: ComponentProps<typeof Icon> }
  | { kind: "intent"; props: ComponentProps<typeof IntentGlyph> }
  | { kind: "status"; props: ComponentProps<typeof StatusGlyph> }
  | { kind: "meter"; props: ComponentProps<typeof Meter> }
  | { kind: "avatar"; props: ComponentProps<typeof Avatar> }

function view(item: Item) {
  switch (item.kind) {
    case "icon":
      return <Icon {...item.props} />
    case "intent":
      return <IntentGlyph {...item.props} />
    case "status":
      return <StatusGlyph {...item.props} />
    case "meter":
      return <Meter {...item.props} />
    case "avatar":
      return <Avatar {...item.props} />
  }
}

const ui = {
  show(items: Item[]) {
    const host = document.getElementById("stage")
    if (host === null) throw new Error("the page has no #stage")
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" })
    render(
      <>
        <ClaudeMarkSymbol />
        {items.map((item, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the list is rebuilt whole on every call
          <span key={index} data-item={index}>
            {view(item)}
          </span>
        ))}
      </>,
      root,
    )
  },
  registerFonts,
}

export type UiHarness = typeof ui

Reflect.set(window, "__iter8Ui", ui)
