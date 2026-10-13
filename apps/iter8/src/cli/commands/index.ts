import type { CommandDef } from "citty"
import type { CliDeps } from "../client"
import { attach } from "./attach"
import { connect } from "./connect"
import { done } from "./done"
import { help } from "./help"
import { hook } from "./hook"
import { note } from "./note"
import { open } from "./open"
import { rounds } from "./rounds"
import { run } from "./run"
import { setup } from "./setup"
import { show } from "./show"
import { status } from "./status"
import { version } from "./version"

export function cliCommands(deps: CliDeps): Record<string, CommandDef> {
  return {
    open: open(deps),
    run: run(deps),
    connect: connect(deps),
    setup: setup(deps),
    attach: attach(deps),
    rounds: rounds(deps),
    show: show(deps),
    done: done(deps),
    note: note(deps),
    status: status(deps),
    version: version(deps),
    help: help(deps),
    hook: hook(deps),
  }
}
