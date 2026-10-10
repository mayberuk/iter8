import {
  parentAcrossShadow,
  resolveAnchor,
  resolveSelector,
} from "../../../apps/overlay/src/pick/anchor"
import {
  createRenderGeneration,
  regionTarget,
  snapshotElement,
} from "../../../apps/overlay/src/pick/snapshot"

const engine = {
  snapshotElement,
  regionTarget,
  parentAcrossShadow,
  resolveSelector,
  resolveAnchor,
  createRenderGeneration,
}

export type PickEngine = typeof engine

Object.assign(window, { __iter8PickEngine: engine })
