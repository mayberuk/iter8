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

const vite = [`${origin}/@vite/client`]

test.each([
  [
    "turbopack, webpack and vite markers",
    { TURBOPACK: [], webpackChunk_N_E: [] },
    "next-turbopack",
  ],
  ["turbopack and webpack markers", { TURBOPACK: {}, webpackChunk_N_E: [] }, "next-turbopack"],
  ["a turbopack marker and a vite client", { TURBOPACK: [] }, "next-turbopack"],
  ["a webpack marker and a vite client", { webpackChunk_N_E: [] }, "next-webpack"],
] as const)("%s resolve in the order turbopack, webpack, vite", (_, globals, expected) => {
  expect(detectBuild({ globals, scriptSources: vite })).toBe(expected)
})

test.each([
  ["null", null],
  ["zero", 0],
  ["false", false],
  ["an empty string", ""],
])("a turbopack marker that is %s is still present", (_, value) => {
  expect(detectBuild({ globals: { TURBOPACK: value }, scriptSources: vite })).toBe("next-turbopack")
})

test.each([
  ["null", null],
  ["zero", 0],
  ["false", false],
  ["an empty string", ""],
])("a webpack marker that is %s is still present", (_, value) => {
  expect(detectBuild({ globals: { webpackChunk_N_E: value }, scriptSources: vite })).toBe(
    "next-webpack",
  )
})

test("a marker whose global is undefined is absent", () => {
  expect(
    detectBuild({
      globals: { TURBOPACK: undefined, webpackChunk_N_E: undefined },
      scriptSources: vite,
    }),
  ).toBe("vite")
})

test("no globals and no scripts is unknown", () => {
  expect(detectBuild({ globals: {}, scriptSources: [] })).toBe("unknown")
})
