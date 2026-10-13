import { expect, test } from "bun:test"
import { afterServiceExit, startWhenReady } from "./dev"

test("a service that drains itself after running a while is restarted", () => {
  expect(afterServiceExit(0, 600_000)).toBe("restart")
})

test("a service that exits cleanly at once, or fails, ends dev", () => {
  expect(afterServiceExit(0, 500)).toBe("fail")
  expect(afterServiceExit(1, 600_000)).toBe("fail")
  expect(afterServiceExit(null, 600_000)).toBe("fail")
})

function harness(reports: (string | null)[]) {
  const events: string[] = []
  let clock = 0
  let polls = 0
  return {
    events,
    options: {
      status: async () => {
        polls += 1
        events.push("status")
        return reports[Math.min(polls - 1, reports.length - 1)] ?? null
      },
      start: () => {
        events.push("start")
      },
      now: () => clock,
      pause: async (ms: number) => {
        clock += ms
      },
      stopping: () => false,
    },
    polls: () => polls,
  }
}

test("it starts run only after status reports ready", async () => {
  const rig = harness([null, '{"state":"starting"}', '{"state":"draining"}', '{"state":"ready"}'])
  await startWhenReady(rig.options)
  expect(rig.events).toEqual(["status", "status", "status", "status", "start"])
})

test("it fails startup without starting run when the service never becomes ready", async () => {
  const rig = harness(['{"state":"starting"}'])
  await expect(startWhenReady(rig.options)).rejects.toThrow("did not become ready within 30 s")
  expect(rig.events).not.toContain("start")
  expect(rig.polls()).toBe(150)
})

test("it keeps polling through unparseable status output", async () => {
  const rig = harness(["not json", '{"state":"ready"}'])
  await startWhenReady(rig.options)
  expect(rig.events).toEqual(["status", "status", "start"])
})
