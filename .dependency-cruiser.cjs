module.exports = {
  forbidden: [
    {
      name: "protocol-depends-on-zod-only",
      comment:
        "Every process shares this vocabulary, so app or runtime dependencies would couple the wire contract to one consumer.",
      severity: "error",
      from: { path: "^packages/protocol/src/", pathNot: "\\.test\\.ts$" },
      to: { pathNot: "(^packages/protocol/|(^|/)node_modules/zod/|^zod(?:/|$))" },
    },
    {
      name: "overlay-never-imports-service",
      comment:
        "The overlay runs in the browser and reaches the service through the protocol's HTTP routes.",
      severity: "error",
      from: { path: "^apps/overlay/" },
      to: { path: "^apps/iter8/" },
    },
    {
      name: "service-never-imports-overlay",
      comment:
        "The service serves the built overlay bundle, so it must not pull browser code into its executable.",
      severity: "error",
      from: { path: "^apps/iter8/" },
      to: { path: "^apps/overlay/" },
    },
    {
      name: "overlay-never-imports-source",
      comment:
        "Source adapters load lazily over HTTP to keep their work out of the overlay's initial bundle.",
      severity: "error",
      from: { path: "^apps/overlay/" },
      to: { path: "^packages/source/" },
    },
    {
      name: "page-code-has-no-runtime-builtins",
      comment: "Page code runs in the browser, where Node and Bun runtime modules are unavailable.",
      severity: "error",
      from: { path: "^(apps/overlay|packages/source)/", pathNot: "\\.test\\.tsx?$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "nothing-imports-harness",
      comment: "Test infrastructure must stay outside the code shipped to users.",
      severity: "error",
      from: { pathNot: "^harness/" },
      to: { path: "^harness/" },
    },
    {
      name: "nothing-imports-fixtures",
      comment:
        "Fixture apps are independent test data and must not become application dependencies.",
      severity: "error",
      from: {},
      to: { path: "^fixtures/" },
    },
    {
      name: "nothing-imports-playground",
      comment:
        "The playground is a test site served by a dev server and must not become an application dependency.",
      severity: "error",
      from: {},
      to: { path: "^playground/" },
    },
    {
      name: "no-circular",
      comment: "Circular imports make module initialization depend on evaluation order.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "Every imported module must resolve so a missing dependency cannot survive the gate.",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
  ],
  options: {
    // TypeScript 7 cannot drive dependency-cruiser, so SWC must parse the source instead.
    parser: "swc",
    exclude: "(^|/)(dist|docs|plugins|\\.claude)(/|$)",
    // Excluding these paths would erase the imports that the boundary rules must reject.
    doNotFollow: { path: "(^|/)(node_modules|fixtures|playground)(/|$)" },
    enhancedResolveOptions: {
      extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
}
