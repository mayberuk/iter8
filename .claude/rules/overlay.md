---
paths:
  - apps/overlay/**
  - packages/source/**
---
# Overlay (`apps/overlay`, `packages/source`)

The overlay runs inside someone else's page. It must never cost that page a frame or the user a
keystroke, and the page must never be able to break it.

## Always
- Render everything into one shadow root, light and dark. The approved sketch
  (`docs/design/sketches/overlay-reference.html`) is the structure, layout and interaction
  reference only; colour, type and icons follow the look decisions recorded in
  `docs/design/brainstorm.md`: a neutral grey palette, Reddit Sans for prose, JetBrains Mono only
  for file paths, line numbers and keys, MingCute icons (Fluent for the region, screenshot and
  auto-theme icons) and the hand-drawn pick pointer.
- At pick time, take only the synchronous identity snapshot (selector, role/name/text, box,
  render generation). Everything else — screenshot, styles, surrounding text, source lead — runs
  after the composer paints, in chunks that yield to input, bounded, cancellable, and omitted
  gracefully when over budget.
- Check before attaching enrichment that the target is still the picked instance; mark a stale
  capture as stale.
- Attach listeners on the overlay's own nodes; a page-level listener is capture-phase, passive
  where it can be, and removed on teardown.
- Throttle hover outlines to the frame; resolve source confidence after the pick, never on hover.
- Leave symbolication to the service; the page only hands it raw locations.

## Never
- Synchronous work at pick or keystroke time that grows with the page's size.
- A global style, a global variable, or a patched built-in on the host page. The one exception is
  the bottom bar's inline `padding-bottom` on `<html>`, restored exactly when the bar goes away.
- Showing a source lead as certain when its confidence label says otherwise.
