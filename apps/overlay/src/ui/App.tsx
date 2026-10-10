import { useOverlay } from "./context"
import { Dock } from "./Dock"
import { ClaudeMarkSymbol } from "./glyphs"
import { Markup } from "./Markup"
import { Palette } from "./Palette"
import { PickLayer } from "./PickLayer"
import { Pins } from "./Pins"
import { RoundSheet } from "./RoundSheet"
import { Toasts } from "./Toasts"
import { Tooltip } from "./Tooltip"

export function App() {
  const { model } = useOverlay()
  return (
    <div class={model.peek.value ? "root peek" : "root"} data-theme={model.prefs.value.theme}>
      <ClaudeMarkSymbol />
      <PickLayer />
      <Pins />
      <Dock />
      <RoundSheet />
      <Markup />
      <Palette />
      <Toasts />
      <Tooltip />
    </div>
  )
}
