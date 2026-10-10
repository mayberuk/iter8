import { afterAll, beforeAll, expect, test } from "bun:test"
import { chooseCrop } from "./crop"

type Size = { width: number; height: number }

class FakeShadowRoot {
  constructor(readonly host: FakeElement) {}
}

class FakeElement {
  parentElement: FakeElement | null = null
  parentNode: FakeElement | FakeShadowRoot | null = null
  constructor(
    readonly size: Size,
    readonly nodes = 1,
  ) {}
}

// The climb tells a shadow root apart with `instanceof ShadowRoot`, a global Bun does not define.
const hadShadowRoot = Reflect.has(globalThis, "ShadowRoot")
beforeAll(() => {
  if (!hadShadowRoot) Reflect.set(globalThis, "ShadowRoot", FakeShadowRoot)
})
afterAll(() => {
  if (!hadShadowRoot) Reflect.deleteProperty(globalThis, "ShadowRoot")
})

const VIEWPORT: Size = { width: 1024, height: 768 }
const TWO_VIEWPORTS_WIDE = VIEWPORT.width * 2
const TWO_VIEWPORTS_HIGH = VIEWPORT.height * 2
const NODE_BUDGET = 300

const size = (width: number, height: number): Size => ({ width, height })

/** Outermost first, each the light-DOM child of the one before. */
function nest(...elements: FakeElement[]): FakeElement[] {
  elements.forEach((el, at) => {
    const parent = elements[at - 1] ?? null
    el.parentElement = parent
    el.parentNode = parent
  })
  return elements
}

function choose(target: FakeElement) {
  const result = chooseCrop(
    target as unknown as Element,
    (el) => (el as unknown as FakeElement).size,
    VIEWPORT,
    (el, limit) => Math.min((el as unknown as FakeElement).nodes, limit + 1),
  )
  return "el" in result ? { el: result.el as unknown as FakeElement } : result
}

const last = (elements: FakeElement[]) => elements.at(-1) as FakeElement

test("an element that is itself 320x160 is its own crop", () => {
  const [only] = nest(new FakeElement(size(320, 160)))

  expect(choose(only as FakeElement)).toEqual({ el: only as FakeElement })
})

test.each([
  { width: 320, height: 160, crop: 1 },
  { width: 319, height: 160, crop: 0 },
  { width: 320, height: 159, crop: 0 },
  { width: 319, height: 159, crop: 0 },
  { width: 321, height: 161, crop: 1 },
])(
  "an ancestor $width x $height is crop number $crop of the two candidates",
  ({ width, height, crop }) => {
    const elements = nest(
      new FakeElement(size(900, 600)),
      new FakeElement(size(width, height)),
      new FakeElement(size(50, 20)),
    )

    expect(choose(last(elements))).toEqual({ el: elements[crop] as FakeElement })
  },
)

test("with no ancestor big enough the outermost element is the crop", () => {
  const elements = nest(new FakeElement(size(300, 100)), new FakeElement(size(50, 20)))

  expect(choose(last(elements))).toEqual({ el: elements[0] as FakeElement })
})

test.each([
  { name: "exactly two viewports high", box: size(900, TWO_VIEWPORTS_HIGH), crop: 0 },
  { name: "one pixel over two viewports high", box: size(900, TWO_VIEWPORTS_HIGH + 1), crop: 1 },
  { name: "exactly two viewports wide", box: size(TWO_VIEWPORTS_WIDE, 600), crop: 0 },
  { name: "one pixel over two viewports wide", box: size(TWO_VIEWPORTS_WIDE + 1, 600), crop: 1 },
])("an ancestor $name is crop number $crop", ({ box, crop }) => {
  const elements = nest(
    new FakeElement(box),
    new FakeElement(size(300, 100)),
    new FakeElement(size(50, 20)),
  )

  expect(choose(last(elements))).toEqual({ el: elements[crop] as FakeElement })
})

test("past a too-tall ancestor the climb stops at the largest one below it, small or not", () => {
  const elements = nest(
    new FakeElement(size(1024, 768)),
    new FakeElement(size(1000, 14452)),
    new FakeElement(size(1000, 60)),
    new FakeElement(size(50, 20)),
  )

  expect(choose(last(elements))).toEqual({ el: elements[2] as FakeElement })
})

test("an element itself over two viewports is omitted as too large", () => {
  const [only] = nest(new FakeElement(size(1000, TWO_VIEWPORTS_HIGH + 1)))

  expect(choose(only as FakeElement)).toEqual({ omitted: "too-large" })
})

test("an ancestor of exactly the node budget is still the crop", () => {
  const elements = nest(new FakeElement(size(900, 600), NODE_BUDGET), new FakeElement(size(50, 20)))

  expect(choose(last(elements))).toEqual({ el: elements[0] as FakeElement })
})

test("an ancestor one node over the budget is not climbed into", () => {
  const elements = nest(
    new FakeElement(size(900, 600), NODE_BUDGET + 1),
    new FakeElement(size(50, 20)),
  )

  expect(choose(last(elements))).toEqual({ el: elements[1] as FakeElement })
})

test("an element itself of exactly the node budget is kept, and one over is omitted", () => {
  const [exact] = nest(new FakeElement(size(320, 160), NODE_BUDGET))
  const [over] = nest(new FakeElement(size(320, 160), NODE_BUDGET + 1))

  expect(choose(exact as FakeElement)).toEqual({ el: exact as FakeElement })
  expect(choose(over as FakeElement)).toEqual({ omitted: "too-many-nodes" })
})

/** A host whose content lives in an open shadow root, under an article. */
function shadowed(hostNodes: number): { host: FakeElement; pre: FakeElement; line: FakeElement } {
  const [, host] = nest(
    new FakeElement(size(1000, 700)),
    new FakeElement(size(1000, 600), hostNodes),
  )
  const root = new FakeShadowRoot(host as FakeElement)
  const pre = new FakeElement(size(1000, 60))
  pre.parentNode = root
  const line = new FakeElement(size(1000, 20))
  line.parentElement = pre
  line.parentNode = pre
  return { host: host as FakeElement, pre, line }
}

test("an element inside a shadow root climbs out through its host", () => {
  const { host, line } = shadowed(5)

  expect(choose(line)).toEqual({ el: host })
})

test("a host whose shadow content is over the node budget is not climbed into", () => {
  const { pre, line } = shadowed(NODE_BUDGET + 1)

  expect(choose(line)).toEqual({ el: pre })
})
