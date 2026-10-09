import { mkdtemp } from "node:fs/promises"
import { WORKER } from "./ports"

export async function throwawayHome(): Promise<string> {
  return mkdtemp(`/tmp/iter8-w${WORKER}-`)
}
