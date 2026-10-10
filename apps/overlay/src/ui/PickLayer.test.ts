import { describe, expect, test } from "bun:test"
import fc from "fast-check"
import { composerSpot } from "./PickLayer"

const EDGE = 12
const PANEL = { w: 356, h: 400 }
const VIEW = { w: 1440, h: 900 }

function spot(over: Partial<Parameters<typeof composerSpot>[0]> & { targets: Rect[] }) {
  return composerSpot({ panel: PANEL, viewport: VIEW, dock: null, sheetLeft: null, ...over })
}

type Rect = { x: number; y: number; w: number; h: number }

describe("composerSpot with the round sheet closed", () => {
  test("beside the target on its right when there is room", () => {
    expect(spot({ targets: [{ x: 100, y: 200, w: 200, h: 50 }] })).toEqual({
      x: 316,
      y: 200,
      side: "left",
    })
  })

  test("beside the target on its left when the right has no room", () => {
    expect(spot({ targets: [{ x: 1200, y: 200, w: 100, h: 50 }] })).toEqual({
      x: 828,
      y: 200,
      side: "right",
    })
  })

  test("below a target that leaves no room on either side", () => {
    expect(spot({ targets: [{ x: 300, y: 100, w: 800, h: 50 }] })).toEqual({
      x: 300,
      y: 166,
      side: "left",
    })
  })

  test("above a target when below would run past the floor", () => {
    expect(spot({ targets: [{ x: 300, y: 600, w: 800, h: 200 }] })).toEqual({
      x: 300,
      y: 184,
      side: "left",
    })
  })

  test("a bottom dock lowers the floor and a top dock raises the ceiling", () => {
    const bottom = { top: 840, bottom: 880, anchor: "br" }
    expect(spot({ targets: [{ x: 100, y: 700, w: 200, h: 50 }], dock: bottom }).y).toBe(428)
    const top = { top: 20, bottom: 60, anchor: "tl" }
    expect(spot({ targets: [{ x: 100, y: 0, w: 200, h: 50 }], dock: top }).y).toBe(72)
  })

  test("several targets are placed around their union", () => {
    const targets = [
      { x: 100, y: 200, w: 50, h: 50 },
      { x: 400, y: 300, w: 100, h: 100 },
    ]
    expect(spot({ targets })).toEqual({ x: 516, y: 200, side: "left" })
  })
})

describe("composerSpot with the round sheet open", () => {
  const view = { w: 1000, h: 700 }
  const sheetLeft = 570

  test("a target on the sheet's side keeps the composer left of the sheet's edge", () => {
    expect(
      spot({ viewport: view, sheetLeft, targets: [{ x: 700, y: 150, w: 100, h: 60 }] }),
    ).toEqual({ x: 202, y: 150, side: "right" })
  })

  test("a target with room beside it is placed as if the sheet were closed", () => {
    const targets = [{ x: 20, y: 150, w: 100, h: 60 }]
    expect(spot({ viewport: view, sheetLeft, targets })).toEqual(spot({ viewport: view, targets }))
    expect(spot({ viewport: view, sheetLeft, targets })).toEqual({ x: 136, y: 150, side: "left" })
  })

  test("a viewport too narrow for the composer beside the sheet lets it overlap the sheet", () => {
    expect(
      spot({
        viewport: { w: 720, h: 700 },
        sheetLeft: 290,
        targets: [{ x: 20, y: 150, w: 100, h: 60 }],
      }),
    ).toEqual({ x: 136, y: 150, side: "left" })
  })
})

const unit = fc.double({ min: 0, max: 1, noNaN: true })

const scene = fc
  .record({
    view: fc.record({
      w: fc.integer({ min: 400, max: 2400 }),
      h: fc.integer({ min: 400, max: 1400 }),
    }),
    panel: fc.record({
      w: fc.integer({ min: 200, max: 500 }),
      h: fc.integer({ min: 100, max: 600 }),
    }),
    boxes: fc.array(fc.record({ fx: unit, fy: unit, fw: unit, fh: unit }), {
      minLength: 1,
      maxLength: 3,
    }),
    sheetFraction: unit,
  })
  .map(({ view, panel, boxes, sheetFraction }) => {
    const targets = boxes.map(({ fx, fy, fw, fh }) => {
      const x = fx * (view.w - 1)
      const y = fy * (view.h - 1)
      return { x, y, w: fw * (view.w - x), h: fh * (view.h - y) }
    })
    return { view, panel, targets, sheetFraction }
  })

describe("composerSpot properties", () => {
  test("property: beside the open sheet, the composer never crosses the sheet's edge minus the gap", () => {
    fc.assert(
      fc.property(scene, ({ view, panel, targets, sheetFraction }) => {
        const lowest = panel.w + 2 * EDGE
        const sheetLeft = lowest + Math.floor(sheetFraction * (view.w - lowest))
        fc.pre(sheetLeft - 2 * EDGE >= panel.w)
        const { x } = composerSpot({ targets, panel, viewport: view, dock: null, sheetLeft })
        expect(x + panel.w).toBeLessThanOrEqual(sheetLeft - EDGE)
      }),
    )
  })

  test("property: the composer stays inside the viewport's edges whenever it fits", () => {
    fc.assert(
      fc.property(scene, fc.boolean(), ({ view, panel, targets, sheetFraction }, open) => {
        fc.pre(panel.w + 2 * EDGE <= view.w)
        const sheetLeft = open ? Math.floor(sheetFraction * view.w) : null
        const { x } = composerSpot({ targets, panel, viewport: view, dock: null, sheetLeft })
        expect(x).toBeGreaterThanOrEqual(EDGE)
        expect(x + panel.w).toBeLessThanOrEqual(view.w - EDGE)
      }),
    )
  })
})
