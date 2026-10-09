import { copyFileSync, mkdirSync } from "node:fs"

for (const page of ["heavy", "second"]) {
  const directory = new URL(`./dist/${page}/`, import.meta.url)
  mkdirSync(directory, { recursive: true })
  copyFileSync(new URL("./dist/index.html", import.meta.url), new URL("index.html", directory))
}
