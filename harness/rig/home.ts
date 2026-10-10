import { WORKER } from "./ports"
import { type Scratch, scratchDir } from "./scratch"

export async function throwawayHome(): Promise<Scratch> {
  return scratchDir(`/tmp/iter8-w${WORKER}-`)
}
