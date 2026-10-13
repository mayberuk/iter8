import { expect, test } from "bun:test"
import fc from "fast-check"
import { backgroundWork } from "./stop-input"

const input = (...types: Array<string | undefined>) =>
  JSON.stringify({
    hook_event_name: "Stop",
    background_tasks: types.map((type, index) => ({ id: `t${index}`, status: "running", type })),
    session_crons: [{ id: "c1", schedule: "0 9 * * *", recurring: true, prompt: "check" }],
  })

test.each([
  ["", { agents: 0, tasks: 0 }],
  ["   \n", { agents: 0, tasks: 0 }],
  ["{", { agents: 0, tasks: 0 }],
  ["null", { agents: 0, tasks: 0 }],
  ["[]", { agents: 0, tasks: 0 }],
  ["{}", { agents: 0, tasks: 0 }],
  ['{"background_tasks":null}', { agents: 0, tasks: 0 }],
  ['{"background_tasks":"shell"}', { agents: 0, tasks: 0 }],
  ['{"background_tasks":["shell"]}', { agents: 0, tasks: 0 }],
  [input(), { agents: 0, tasks: 0 }],
  [input("shell"), { agents: 0, tasks: 1 }],
  [input("subagent"), { agents: 1, tasks: 0 }],
  [input("shell", "shell", "monitor", "MCP task"), { agents: 0, tasks: 4 }],
  [input("subagent", "teammate", "workflow", "cloud session"), { agents: 4, tasks: 0 }],
  [input("subagent", "shell", "subagent", "monitor", "teammate"), { agents: 3, tasks: 2 }],
  [input("a-future-kind"), { agents: 0, tasks: 1 }],
  [input(undefined), { agents: 0, tasks: 1 }],
  [
    JSON.stringify({ background_tasks: [{ type: "subagent", agent_type: "Explore", extra: {} }] }),
    { agents: 1, tasks: 0 },
  ],
])("%p is counted as %p", (stdin, expected) => {
  expect(backgroundWork(stdin)).toEqual(expected)
})

test("agents and tasks always add up to the number of tasks listed", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.constantFrom(
          "shell",
          "subagent",
          "monitor",
          "workflow",
          "teammate",
          "cloud session",
          "x",
        ),
        { maxLength: 20 },
      ),
      (types) => {
        const work = backgroundWork(input(...types))
        expect(work.agents + work.tasks).toBe(types.length)
        expect(work.agents).toBe(
          types.filter((t) => ["subagent", "workflow", "teammate", "cloud session"].includes(t))
            .length,
        )
      },
    ),
  )
})
