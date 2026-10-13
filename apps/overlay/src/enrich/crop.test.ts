import { afterAll, beforeAll, expect, test } from "bun:test"
import fc from "fast-check"
import { chooseCrop, pruneFor, type Reads } from "./crop"

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

function choose(target: FakeElement): FakeElement {
  return chooseCrop(
    target as unknown as Element,
    (el) => (el as unknown as FakeElement).size,
    (el, limit) => Math.min((el as unknown as FakeElement).nodes, limit + 1),
  ) as unknown as FakeElement
}

const last = (elements: FakeElement[]) => elements.at(-1) as FakeElement

test("an element that is itself 320x160 is its own crop", () => {
  const [only] = nest(new FakeElement(size(320, 160)))

  expect(choose(only as FakeElement)).toBe(only as FakeElement)
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

    expect(choose(last(elements))).toBe(elements[crop] as FakeElement)
  },
)

test("with no ancestor big enough the outermost element is the crop", () => {
  const elements = nest(new FakeElement(size(300, 100)), new FakeElement(size(50, 20)))

  expect(choose(last(elements))).toBe(elements[0] as FakeElement)
})

test("a 55-node element 1444 px tall in a 720 px viewport is accepted as the crop", () => {
  const elements = nest(new FakeElement(size(1280, 1444), 55), new FakeElement(size(300, 100)))

  expect(choose(last(elements))).toBe(elements[0] as FakeElement)
})

test.each([
  { name: "a page of 14,452 px", box: size(1000, 14452) },
  { name: "an element 40,000 px wide", box: size(40_000, 600) },
])("$name is climbed into while it stays within the node budget", ({ box }) => {
  const elements = nest(new FakeElement(box, 40), new FakeElement(size(50, 20)))

  expect(choose(last(elements))).toBe(elements[0] as FakeElement)
})

test("past an ancestor over the node budget the climb stops at the largest one below it", () => {
  const elements = nest(
    new FakeElement(size(1024, 768)),
    new FakeElement(size(1000, 14452), 17_554),
    new FakeElement(size(1000, 60)),
    new FakeElement(size(50, 20)),
  )

  expect(choose(last(elements))).toBe(elements[2] as FakeElement)
})

test("an ancestor of exactly the node budget is still the crop", () => {
  const elements = nest(new FakeElement(size(900, 600), NODE_BUDGET), new FakeElement(size(50, 20)))

  expect(choose(last(elements))).toBe(elements[0] as FakeElement)
})

test("an ancestor one node over the budget is not climbed into", () => {
  const elements = nest(
    new FakeElement(size(900, 600), NODE_BUDGET + 1),
    new FakeElement(size(50, 20)),
  )

  expect(choose(last(elements))).toBe(elements[1] as FakeElement)
})

test("a target itself over the node budget is still the crop, for the clone to prune", () => {
  const [over] = nest(new FakeElement(size(320, 160), NODE_BUDGET + 1))

  expect(choose(over as FakeElement)).toBe(over as FakeElement)
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

  expect(choose(line)).toBe(host)
})

test("a host whose shadow content is over the node budget is not climbed into", () => {
  const { pre, line } = shadowed(NODE_BUDGET + 1)

  expect(choose(line)).toBe(pre)
})

type Box = { left: number; top: number; width: number; height: number }

class FakeBox {
  constructor(
    readonly box: Box,
    readonly display = "block",
    readonly position = "static",
    readonly children: FakeBox[] = [],
  ) {}
}

const READS: Reads = {
  children: (el) => (el as unknown as FakeBox).children as unknown as Iterable<Element>,
  box: (el) => (el as unknown as FakeBox).box,
  style: (el) => ({
    display: (el as unknown as FakeBox).display,
    position: (el as unknown as FakeBox).position,
  }),
}

const CLIP: Box = { left: 100, top: 100, width: 200, height: 100 }

const box = (left: number, top: number, width: number, height: number): Box => ({
  left,
  top,
  width,
  height,
})

async function prune(root: FakeBox, limit = NODE_BUDGET, clip = CLIP) {
  const result = await pruneFor(root as unknown as Element, clip, READS, limit, async () => {})
  return result === null
    ? null
    : {
        nodes: result.nodes,
        stubs: result.stubs as unknown as Set<FakeBox>,
        dropped: result.dropped as unknown as Set<FakeBox>,
      }
}

test("an element touching the clip is cloned whole and one clear of it keeps only its own box", async () => {
  const inside = new FakeBox(box(120, 120, 50, 20), "block", "static", [
    new FakeBox(box(120, 120, 5, 5)),
  ])
  const leftOf = new FakeBox(box(0, 120, 50, 20), "flex", "static", [
    new FakeBox(box(0, 120, 5, 5)),
  ])
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [inside, leftOf])

  const result = await prune(root)

  expect(result?.stubs).toEqual(new Set([leftOf]))
  expect(result?.dropped).toEqual(new Set())
  expect(result?.nodes).toBe(1 + 2 + 1)
})

test("the planner gives the caller a turn once for every element it plans whole, so a long plan can yield", async () => {
  const inside = new FakeBox(box(120, 120, 50, 20), "block", "static", [
    new FakeBox(box(120, 120, 5, 5)),
  ])
  const leftOf = new FakeBox(box(0, 120, 50, 20), "flex", "static", [
    new FakeBox(box(0, 120, 5, 5)),
  ])
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [inside, leftOf])
  let turns = 0

  await pruneFor(root as unknown as Element, CLIP, READS, NODE_BUDGET, async () => {
    turns += 1
  })

  expect(turns).toBe(3)
})

test("in a block flow, what lies below the clip is dropped and what lies above it is kept as a box", async () => {
  const above = new FakeBox(box(0, 0, 400, 50))
  const touching = new FakeBox(box(0, 90, 400, 50))
  const below = new FakeBox(box(0, 300, 400, 50))
  const root = new FakeBox(box(0, 0, 400, 400), "block", "static", [above, touching, below])

  const result = await prune(root)

  expect(result?.stubs).toEqual(new Set([above]))
  expect(result?.dropped).toEqual(new Set([below]))
})

test("in a flex row, what lies right of the clip is kept as a box, so the spacing around the clip holds", async () => {
  const right = new FakeBox(box(350, 100, 40, 100))
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [right])

  const result = await prune(root)

  expect(result?.stubs).toEqual(new Set([right]))
  expect(result?.dropped).toEqual(new Set())
})

test("an out-of-flow element clear of the clip and one that is display none are dropped", async () => {
  const popup = new FakeBox(box(0, 0, 50, 50), "block", "absolute")
  const hidden = new FakeBox(box(0, 0, 0, 0), "none")
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [popup, hidden])

  expect((await prune(root))?.dropped).toEqual(new Set([popup, hidden]))
})

test("an out-of-flow element over the clip is cloned", async () => {
  const popup = new FakeBox(box(150, 120, 50, 50), "block", "absolute")
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [popup])

  const result = await prune(root)

  expect(result?.dropped).toEqual(new Set())
  expect(result?.stubs).toEqual(new Set())
})

test("an inline element clear of the clip stays whole, so a line of text keeps its words", async () => {
  const word = new FakeBox(box(0, 0, 30, 20), "inline", "static", [
    new FakeBox(box(0, 0, 5, 5), "inline"),
  ])
  const root = new FakeBox(box(0, 0, 400, 400), "block", "static", [word])

  const result = await prune(root)

  expect(result?.stubs).toEqual(new Set())
  expect(result?.nodes).toBe(3)
})

test("an element the clip only grazes by its own border still counts as touching", async () => {
  const grazing = new FakeBox(box(0, 50, 400, 50.5), "flex")
  const root = new FakeBox(box(0, 0, 400, 400), "flex", "static", [grazing])

  expect((await prune(root))?.stubs).toEqual(new Set())
})

test("the clone may hold exactly the node budget of elements and is refused one past it", async () => {
  const rows = (count: number) =>
    new FakeBox(
      box(0, 0, 400, 400),
      "flex",
      "static",
      Array.from({ length: count }, () => new FakeBox(box(0, 120, 10, 10))),
    )

  expect((await prune(rows(NODE_BUDGET - 1)))?.nodes).toBe(NODE_BUDGET)
  expect(await prune(rows(NODE_BUDGET))).toBeNull()
})

test("a clip over few rows of a table of many costs the rows before it, not the whole table", async () => {
  const rowAt = (index: number) =>
    new FakeBox(box(0, index * 45, 900, 45), "table-row", "static", [
      new FakeBox(box(0, index * 45, 300, 45), "table-cell"),
      new FakeBox(box(300, index * 45, 600, 45), "table-cell"),
    ])
  const rows = Array.from({ length: 1000 }, (_, index) => rowAt(index))
  const body = new FakeBox(box(0, 0, 900, 45_000), "table-row-group", "static", rows)
  const table = new FakeBox(box(0, 0, 900, 45_000), "table", "static", [body])

  const result = await prune(table, NODE_BUDGET, {
    left: 0,
    top: 45 * 3 + 5,
    width: 900,
    height: 45 * 4 - 10,
  })

  expect(result?.nodes).toBe(2 + 3 + 4 * 3 + 0)
  expect(result?.dropped.size).toBe(1000 - 7)
})

const PAGE = box(0, 0, 1000, 1000)

type Tree = { box: Box; display: string; position: string; children: Tree[] }

const boxArb = fc.record({
  left: fc.integer({ min: -200, max: 1100 }),
  top: fc.integer({ min: -200, max: 1100 }),
  width: fc.integer({ min: 0, max: 600 }),
  height: fc.integer({ min: 0, max: 600 }),
})

const { tree: treeArb } = fc.letrec<{ tree: Tree }>((tie) => ({
  tree: fc.record({
    box: boxArb,
    display: fc.constantFrom(
      "block",
      "flex",
      "inline",
      "none",
      "contents",
      "table-row-group",
      "grid",
    ),
    position: fc.constantFrom("static", "static", "absolute", "fixed"),
    children: fc.oneof(
      { depthSize: "small" },
      fc.constant<Tree[]>([]),
      fc.array(tie("tree"), { maxLength: 4 }),
    ),
  }),
}))

const build = (tree: Tree): FakeBox =>
  new FakeBox(tree.box, tree.display, tree.position, tree.children.map(build))

const touches = (b: Box, clip: Box) =>
  b.left + b.width > clip.left - 1 &&
  b.left < clip.left + clip.width + 1 &&
  b.top + b.height > clip.top - 1 &&
  b.top < clip.top + clip.height + 1

test("the pruned clone keeps every in-flow element touching the clip under a parent that touches it, and counts what it keeps", async () => {
  await fc.assert(
    fc.asyncProperty(
      treeArb,
      fc.record({
        left: fc.integer({ min: 0, max: 900 }),
        top: fc.integer({ min: 0, max: 900 }),
        width: fc.integer({ min: 1, max: 400 }),
        height: fc.integer({ min: 1, max: 400 }),
      }),
      async (tree, clip) => {
        const root = build({ ...tree, box: PAGE, display: "block", position: "static" })
        const result = await prune(root, Number.MAX_SAFE_INTEGER, clip)
        if (result === null) return false

        const cloned = new Set<FakeBox>()
        const gather = (node: FakeBox) => {
          cloned.add(node)
          if (result.stubs.has(node)) return
          for (const child of node.children) if (!result.dropped.has(child)) gather(child)
        }
        gather(root)

        const lost: FakeBox[] = []
        for (const node of cloned) {
          if (result.stubs.has(node) || !touches(node.box, clip)) continue
          for (const child of node.children) {
            const inFlow = child.display !== "none" && child.position === "static"
            if (inFlow && touches(child.box, clip) && !cloned.has(child)) lost.push(child)
          }
        }
        return lost.length === 0 && cloned.size === result.nodes
      },
    ),
  )
})

test("a clone within the node budget never has more elements than the budget", async () => {
  await fc.assert(
    fc.asyncProperty(treeArb, fc.integer({ min: 1, max: 12 }), async (tree, limit) => {
      const result = await prune(build(tree), limit)

      return result === null || result.nodes <= limit
    }),
  )
})
