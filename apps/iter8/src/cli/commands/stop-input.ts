import type { BackgroundWork } from "@iter8/protocol"
import { z } from "zod"

const AGENT_TYPES = new Set(["subagent", "teammate", "workflow", "cloud session"])

const StopInput = z.object({ background_tasks: z.array(z.object({ type: z.string().optional() })) })

/** Absent, empty and unparseable input all mean nothing is running: the hook must never fail on it. */
export function backgroundWork(stdin: string): BackgroundWork {
  let json: unknown
  try {
    json = JSON.parse(stdin)
  } catch {
    return { agents: 0, tasks: 0 }
  }
  const parsed = StopInput.safeParse(json)
  if (!parsed.success) return { agents: 0, tasks: 0 }
  let agents = 0
  for (const task of parsed.data.background_tasks) {
    if (task.type !== undefined && AGENT_TYPES.has(task.type)) agents++
  }
  return { agents, tasks: parsed.data.background_tasks.length - agents }
}
