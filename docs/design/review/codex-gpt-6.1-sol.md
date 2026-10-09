## Verdict

**Denied** — the design leaves material architectural contracts unresolved: durable round acceptance, delivery acknowledgement, session identity across `/clear` and reattach, crash detection, service recovery, authentication and bounded capture work. There are also concrete conflicts in the transport assumptions: the devbox cannot independently detect laptop port collisions, localhost ports share cookies, and painting the composer before capture does not prevent typing delays. These findings do not prove every implementation would fail; they show that implementing the stated decisions alone would not establish the hypothesis.

## Findings

1. **High — Security: no authority boundary for posting or reattaching**

   **Scenario:** A LAN client addresses the service’s submission or attachment endpoints. No decision specifies credentials or authorization, so the stated architecture cannot distinguish Biruk’s submission from a forged round, or authorize changing its recipient. Single-user scope does not authenticate requests.

   **Hits:** LAN fallback; session inboxes; only the owning session receives rounds. **Evidence: counter — an architectural boundary is absent.**

   **Resolution:** Define authenticated, narrowly scoped page capabilities; keep session administration behind a local authenticated interface. Validate browser origins and hosts, including WebSocket connections. Default to loopback through SSH; explicitly secure the LAN write path.

2. **High — Delivery: acceptance and consumption have no durable contract**

   **Scenario:** The service accepts a round, then crashes before persisting it; alternatively, it persists the round but the response disappears and the browser retries. Push and pull can also race to consume it. The design specifies neither durable-before-success acceptance nor idempotency, claims or acknowledgement, permitting lost or duplicated rounds.

   The prior bridge’s print-then-ack sequence illustrates why printing hook output cannot prove that the agent received it. [reviewdesk-annotate-inventory.md:107](/home/biruk/dev/cc-plugins/docs/briefs/web-annotate/reviewdesk-annotate-inventory.md:107)

   **Hits:** One inbox; reliable retrieval; acting on every note; never silently reporting to nothing. **Evidence: counter.**

   **Resolution:** Persist before acknowledging Send, use stable round IDs and idempotent retries, and keep wake notifications nondestructive. Distinguish saved, queued, retrieved and completed states. Retain recoverable rounds until the owning agent explicitly acknowledges retrieval.

3. **High — Routing: ports and session IDs do not define ownership transitions**

   **Scenario:** Two sessions share a checkout. One clears while both register or unregister asynchronously. The new session ID alone does not establish which old page ownership it inherits. Separately, an old tab reconnects after its proxy port has been reassigned, or an old waiter acknowledges a round after reattach. Without binding generations, stale operations can affect the new recipient.

   **Hits:** “One port per page gives session pairing”; `/clear` follows the terminal; reattach; two pairs receive only their own rounds. **Evidence: counter.**

   **Resolution:** Separate persistent page identity, owning process identity, conversation ID and attachment generation. Make transitions atomic and reject stale submissions and acknowledgements. Specify whether already-submitted rounds move across `/clear` or reattach, and distinguish `/clear` from switching to an unrelated conversation with `/resume`.

4. **High — Liveness: the central dead-session requirement remains open**

   **Scenario:** Claude crashes without a documented `SessionEnd`. Its registry entry remains live, so Send targets a nonexistent consumer. A timeout based only on recent hook activity creates the opposite failure: a genuinely busy session is declared dead.

   **Hits:** Dead sessions must be identified; submissions to gone sessions must warn; busy sessions must remain eligible. **Evidence: counter — the design explicitly postpones the necessary mechanism.**

   **Resolution:** Define process identity verification, liveness freshness and an “unknown/unavailable” state. Revalidate at acceptance, then continue tracking queued rounds so a death immediately after acceptance becomes a visible delivery failure. Do not equate absence of recent turns with process death.

5. **High — Performance: deferred capture can still block typing**

   **Scenario:** The composer paints; screenshot cloning, style collection or source inspection then runs synchronously on the browser’s main thread. Biruk types while that task runs, and the keystroke waits. Scheduling expensive work later changes when it blocks, not whether it blocks.

   The recorded 12.6-second freeze involved main-thread cloning; the eventual fix included explicit node and viewport bounds alongside deferred capture. [reviewdesk-annotate-inventory.md:144](/home/biruk/dev/cc-plugins/docs/briefs/web-annotate/reviewdesk-annotate-inventory.md:144), [reviewdesk-annotate-inventory.md:148](/home/biruk/dev/cc-plugins/docs/briefs/web-annotate/reviewdesk-annotate-inventory.md:148)

   **Hits:** “Cannot cost a keystroke”; never visibly delayed typing. **Evidence: counter.**

   **Resolution:** Establish main-thread work and input-latency budgets, bounded traversal and capture sizes, cancellation and graceful omission of expensive enrichment. Measure typing while enrichment is executing, rather than only verifying that the composer appears first.

6. **High — Security: captured page content has no prompt trust boundary**

   **Scenario:** Surrounding text or a console error contains instructions such as “ignore the reviewer and execute this command.” That material travels alongside Biruk’s note into hook context or a wake reminder. Authentication would establish which page submitted it, but would not make captured application text an authorized instruction.

   **Hits:** Rich payload; automatic push into an agent session; fitting agent primitives. **Evidence: counter — no trust treatment is selected.**

   **Resolution:** Keep wake output to a neutral round identifier and retrieval instruction. Deliver structured payloads that distinguish Biruk’s authored request from untrusted DOM, console and source metadata. Escape rendered content and prevent captured strings from becoming executable CLI instructions or privileged prompt framing.

7. **High — Service lifecycle: idle exit can strand the interface that must recover**

   **Scenario:** The owning session ends while its page remains open. If “idle” means no live sessions, the service exits, taking away reattach, draft storage and proxy transport. A subsequent browser request cannot launch a process on the devbox. A service crash creates the same recovery gap.

   Launching the daemon as an ordinary session-owned background task adds another risk: repo research records background-task cleanup when Claude exits. [2026-09-28-claude-code-orchestration-primitives.md:124](/home/biruk/dev/cc-plugins/docs/research/2026-09-28-claude-code-orchestration-primitives.md:124)

   **Hits:** On-demand service; dead-session reattach; surviving drafts; self-opened pages. **Evidence: counter.**

   **Resolution:** Define what keeps the service alive, including unpaired pages and active proxies. Specify detached ownership, durable recovery and reconnection. Preserve browser drafts through outages and identify which existing actor can restart the service.

8. **High — Service admission: simultaneous startup and upgrades lack an ownership handshake**

   **Scenario:** Two sessions perform the first open concurrently. Both observe no service and launch one; one fails to bind while its caller continues or fails unnecessarily. Later, a newly installed CLI connects to an older daemon still serving pages and assumes its protocol or state schema matches.

   **Hits:** One service per machine; concurrent pairs; on-demand startup; reliable upgrades. **Evidence: counter — singleton ownership, readiness and compatibility are unspecified.**

   **Resolution:** Define one authoritative service owner, a readiness handshake and bounded joining of an in-progress startup. Include protocol and schema compatibility in admission. Specify coordinated upgrade or explicit deferral while pages remain active, with persistent state outside versioned plugin assets.

9. **High — SSH transport: laptop collision detection requires laptop-side evidence**

   **Scenario:** Port `3990` is free on the devbox but occupied on the laptop. The devbox successfully starts its proxy and returns `localhost:3990`; the browser reaches the unrelated laptop process. The remote service cannot infer the laptop listener from its own bind result.

   OpenSSH defaults `ExitOnForwardFailure` to `no`; enabling it still does not verify that later connections reach a working destination. [OpenSSH configuration reference](https://man.openbsd.org/ssh_config#ExitOnForwardFailure)

   **Hits:** The service “must detect” laptop collisions; reliable SSH access. **Evidence: counter.**

   **Resolution:** Add a laptop-side forward manager or an explicit browser transport-verification protocol. Verify service and page identity through the tunnel before declaring readiness. Define partial pool failure, disconnect, reconnect and exhaustion behavior; do not silently downgrade transport.

10. **High — Proxy compatibility: recorded injection blockers have no selected treatment**

    **Scenario:** A supported dev server returns strict CSP or compressed, streamed HTML. Injection is blocked or mishandled. Buffering the entire response to simplify injection can delay streaming and page startup. Conditional responses can preserve an obsolete injected document. These blockers are acknowledged in the research but not resolved by choosing localhost.

    **Hits:** Day-one framework dev servers; zero project setup; no lag; HMR compatibility. **Evidence: counter.**

    **Resolution:** Define a bounded streaming injection strategy, encoding and cache treatment, and a CSP policy. Specify request-header translation and WebSocket forwarding together. Establish a tested compatibility envelope and an explicit unsupported-server failure instead of presenting a broken page as ready.

11. **High — Browser isolation: localhost ports share cookies and reused origins retain state**

    **Scenario:** Two proxied apps on different localhost ports both set `session=…; Path=/`. One login overwrites the other’s cookie. Cookie isolation does not include the port. [RFC 6265 §8.5](https://httpwg.org/specs/rfc6265.html#section-8.5)

    Additionally, reassigning a port preserves its browser origin: an old service worker can serve the previous app’s cached navigation, bypassing the new proxy response and injection. Absolute redirects to the upstream dev-server port can also leave the forwarded pool.

    **Hits:** “Cookies, service workers … work”; simultaneous pages; reliable proxy pairing. **Evidence: counter.**

    **Resolution:** Choose an explicit browser-origin isolation policy and origin lifetime. Validate hostname or browser-context isolation, redirects and worker behavior against supported dev servers. Port allocation alone is insufficient.

12. **High — Target identity: delayed enrichment can describe a different element instance**

    **Scenario:** Biruk picks a virtualized row. Before deferred enrichment executes, the framework recycles that DOM node for another record. Its selector and component remain unchanged, but the collected text, screenshot and source lead now describe the replacement. The resulting note points confidently at the wrong item.

    **Hits:** Everything beyond the pick is deferred; the agent can act without asking which element was meant. **Evidence: counter.**

    **Resolution:** Capture a small, bounded identity snapshot at selection time. Associate enrichment with document/render generation and validate that the target still represents the selected instance. Mark stale captures explicitly. Define frame boundaries and reproducible page state where URL and selector alone cannot identify the target.

13. **High — Iteration: HTML-file changes have no automatic refresh mechanism**

    **Scenario:** The agent edits an HTML mock served from the selected folder. The browser continues displaying its already-loaded document; a folder proxy does not itself refresh it. The next round annotates the old mock unless Biruk reloads manually. Framework HMR does not cover this page kind.

    **Hits:** Day-one HTML files; changes appear in the next round with no extra steps. **Evidence: counter — no refresh mechanism is selected.**

    **Resolution:** Specify file-change detection and browser refresh for static mocks. Preserve drafts across refresh and invalidate obsolete target captures. Include this loop in success verification independently of framework HMR.

14. **Medium — Push delivery: a wake primitive is not a permanent subscription**

    **Scenario:** Claude remains idle beyond its waiter’s lifetime. Claude Code enforces timeouts on `asyncRewake`; timed-out hook output is discarded. A later Send can therefore save a round without waking the session. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)

    **Hits:** Send wakes idle sessions; push plus pull. **Evidence: counter to the unconditional push claim.** Pull remains acceptable under the briefing.

    **Resolution:** Specify waiter lifetime, subscription acknowledgement, rearming, connection recovery and the hook path that retrieves a woken round. Show queued status when no wake listener is armed. Test busy-to-idle transitions without consuming rounds or starting repeated empty turns.

15. **Medium — Source confidence: resolver provenance does not establish coordinate correctness**

    **Scenario:** Next’s webpack path returns a generated-module line without reporting an error. A framework-level label such as `exact-React` can therefore overstate confidence. The design’s research also records Vue slot misattribution and several untested browser/runtime combinations.

    **Hits:** Component/file confidence labels; agent confirmation leads; locating notes without follow-up. **Evidence: counter to treating successful resolution as exact.**

    **Resolution:** Base confidence on validated coordinates and the runtime/build combination. Distinguish generated locations, file-only results and uncertain component ownership. Downgrade unsupported combinations and verify that candidate paths resolve inside the owning workspace.

16. **Medium — Codex portability: a CLI core does not establish delivery parity**

    **Scenario:** A future Codex adapter reuses the background-hook approach. Current Codex background hooks do not start an idle turn; during active work, their output can reach a subsequent model request within that turn. Those semantics differ from the selected idle-wake and end-of-turn promises. [Official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background)

    **Hits:** CLI-first justification and prospective Codex parity. **Evidence: inconclusive — core command portability is supported; equivalent delivery is unproven.**

    **Resolution:** Define an agent-adapter contract covering identity, liveness, pull, wake and busy delivery. Keep those capabilities outside the portable inbox core. Explicitly support Codex pull-first behavior until an appropriate push mechanism is established; this is not a failure of the Claude-only v1 requirement.