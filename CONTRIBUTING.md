# Contributing to iter8

Contributions are released under the [MIT licence](LICENSE).

## Work on it

Prerequisites: Bun 1.4.2 and Node 22.12+ for the fixture apps.

```sh
bun install
bun run setup:browsers
bun run dev
```

`bun run dev` watches the service and overlay and opens the permanent playground through the proxy; its state is in `~/.iter8-dev` with ports 3970–3973, so it can run alongside installed iter8.

In another terminal, start Claude Code with the source CLI:

```sh
bun run dev:claude
```

To open the same playground with installed iter8:

```sh
bun run prod
```

## Check and build

Run `bun run check` for the full gate: typecheck, lint, knip, dependency-cruiser and the tests.

`bun run build` writes the host binary to `dist/iter8` and the overlay bundles to `dist/overlay/`.

`bun run release` builds the linux-x64 and darwin-arm64 releases.

## Dependencies and notices

The binary embeds its runtime dependencies. After adding or upgrading one, run `bun scripts/notices.ts` to regenerate [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES); `scripts/notices.test.ts` fails when the file is out of date.

## Where decisions live

The settled design lives in [docs/design/README.md](docs/design/README.md). Testing conventions live in [.claude/docs/TESTING.md](.claude/docs/TESTING.md).
