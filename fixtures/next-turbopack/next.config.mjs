export default {
  distDir: process.env.ITER8_NEXT_DIST_DIR ?? ".next",
  // Next stops its dev server with an upgrade notice when it detects a coding agent; the gate must not depend on the advisory feed.
  experimental: { agentUpgrade: false },
}
