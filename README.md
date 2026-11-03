# iter8

Point at a running web page, mark it up, and hand the round of notes to the coding agent session that owns the page. Claude Code is the supported agent today; others are planned.

You click elements on the page, write a note on each, and press Send. The session that started the page gets a pointer to the round and reads the notes with each element's selector and, where iter8 can find it, source location, so it can act on each one without asking which thing you meant.

## Requirements

- Linux x86_64 or macOS arm64
- Claude Code 2.1.296 or later, for the mod that starts a turn when a round arrives; the hooks alone work on older releases
- `jq`, which the plugin's hooks use

## Install

In Claude Code:

```text
/plugin marketplace add mayberuk/iter8
/plugin install iter8@iter8
```

Then, on the machine that runs your projects, put the `iter8` command on your PATH:

```sh
iter8 setup
```

Standalone, on a machine without Claude Code (for example the laptop side of a remote dev server):

```sh
curl -fsSL https://raw.githubusercontent.com/mayberuk/iter8/main/install.sh | sh
iter8 setup <host>
```

`<host>` is the SSH host name of the machine where Claude Code runs.

## Your first round

In your project directory:

```sh
iter8 run
```

It starts the project's `dev` or `start` script (or serves its HTML files) and opens the page through iter8's proxy. Click an element, write what you want changed, and press Send. Then tell the Claude Code session you left comments, or let the Send button deliver them; the session resolves each note with `iter8 done`.

`iter8 help` lists every command.

## Docs

The site is at <https://mayberuk.github.io/iter8-site/>. To work on iter8 itself, read [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, read [SECURITY.md](SECURITY.md).

## A note on the name

The name `iter8` is shared with an unrelated Kubernetes experimentation tool. This project has nothing to do with it.

## Licence

[MIT](LICENSE). Bundled dependencies are listed in [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).
