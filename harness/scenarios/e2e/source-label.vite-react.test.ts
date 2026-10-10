import { test } from "bun:test"
import { proveSourceLabels } from "./source-label"

test(
  "picking each marked element on the vite-react fixture shows and returns the source confidence the fixture promises",
  () => proveSourceLabels("vite-react"),
  180_000,
)
