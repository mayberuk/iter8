# iter8

Point at a running web page and mark it up. Hand the round of notes to the Claude Code session that owns the page.

## Use it

After the Claude Code plugin installs iter8, install the terminal command on the machine that runs your projects:

```sh
iter8 setup
```

If setup says `~/.local/bin` is missing from PATH, add it in your shell profile.

For a browser on your laptop, run this on the laptop:

```sh
iter8 setup <devbox>
```

Replace `<devbox>` with your SSH host name; the connection starts at login, reconnects after sleep or network changes, and follows newer verified releases on the devbox.

In your project directory, start the page:

```sh
iter8 run
```

It runs the project's `dev` or `start` script, or serves its HTML files, and opens the page through the proxy in your local browser or on connected laptops; Ctrl-C stops the dev server and keeps the page's pins and pairing for the next run.

To choose the command yourself, replace `<cmd>` with your dev server command:

```sh
iter8 run -- <cmd>
```

The chosen port arrives as `PORT`; if the command ignores it, iter8 uses the URL the server prints.

If both machines run iter8 with the same pool, give one a different `pool` in its `config.json`.

`iter8 help` lists every command; `iter8 help <command>` or `iter8 <command> --help` shows its arguments and flags.

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

Run `bun run check` for the full gate.

`bun run build` writes the host binary to `dist/iter8` and the overlay bundles to `dist/overlay/`.

The settled design lives in [docs/design/README.md](docs/design/README.md). Testing conventions live in [.claude/docs/TESTING.md](.claude/docs/TESTING.md).

`bun run release` builds the linux-x64 and darwin-arm64 releases.
