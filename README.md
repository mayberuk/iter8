# iter8

Point at a running web page and mark it up. Hand the round of notes to the Claude Code session that owns the page.

Prerequisites: Bun 1.4.2 and Node 22.12+ for the fixture apps.

```sh
bun install
bun run setup:browsers
bun run build
bun run check
```

`bun run build` writes the host binary to `dist/iter8` and the overlay bundles to `dist/overlay/`.

The settled design lives in [docs/design/README.md](docs/design/README.md). Testing conventions live in [.claude/docs/TESTING.md](.claude/docs/TESTING.md).

`bun run release` builds the linux-x64 and darwin-arm64 releases.
