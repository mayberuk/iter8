import { expect, test } from "bun:test"
import { detectBuild } from "./page-build"

const origin = "http://larkspur.localhost:3990"

test("a Next page bundled by Turbopack is next-turbopack", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: { push() {} }, webpackChunk_N_E: undefined },
      scriptSources: [
        `${origin}/_next/static/chunks/1tmj_next_dist_client_16afr3t45q5yv._.js`,
        `${origin}/_next/static/chunks/%5Bturbopack%5D_browser_dev_hmr-client_hmr-client_ts_1mojsayzyj2p6._.js`,
      ],
    }),
  ).toBe("next-turbopack")
})

test("a Next page bundled by webpack is next-webpack", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: undefined, webpackChunk_N_E: [] },
      scriptSources: [
        `${origin}/_next/static/chunks/main-app.js?v=1791614946058`,
        `${origin}/_next/static/chunks/webpack.js?v=1791614946058`,
      ],
    }),
  ).toBe("next-webpack")
})

test("a page served by the Vite dev server is vite", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: undefined, webpackChunk_N_E: undefined },
      scriptSources: [`${origin}/@vite/client`, `${origin}/src/main.jsx`],
    }),
  ).toBe("vite")
})

test("a SvelteKit page whose Vite client arrived by import is vite", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: undefined, webpackChunk_N_E: undefined },
      scriptSources: [
        "",
        `${origin}/@fs/app/node_modules/@sveltejs/kit/src/runtime/client/entry.js`,
        `${origin}/@vite/client`,
      ],
    }),
  ).toBe("vite")
})

test("a page with no bundler markers is unknown", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: undefined, webpackChunk_N_E: undefined },
      scriptSources: [`${origin}/shadow-label.js`, ""],
    }),
  ).toBe("unknown")
})
