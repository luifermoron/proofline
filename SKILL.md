---
name: proofline
description: Arm live runtime probes in a browser (and optionally the database) so a timestamped trace of clicks, network calls, console errors, frontend state changes and DOM mutations can be captured while a human drives the app. The browser and frontend-state lanes survive reloads and URL changes. Use when the user says "arm proofline", "arm the probes", "arm browser and react", "arm everything", "start logging", "capture a trace", or when a UI bug needs root-causing across layers (why is this field blank / why did this not save / what actually fired), or when discovering how an unfamiliar feature works end to end.
---

# proofline

*One clock. Every layer. Follow the proof: find the bug or understand how it works.*

Capture **what the application actually does at runtime** — clicks, network, console, Redux state,
DOM mutations, and optionally database row transitions — as one timeline on a single clock, so the
causal chain (click → action → state → network → DOM) is readable rather than guessed at.

## When the user says "arm ..."

Map their words to lanes and run the CLI. Never paste probe source by hand — the CLI is the only
supported way to build the snippet, because it bakes in the configuration and the traps below.

| The user says | Lanes |
|---|---|
| "arm everything" / "arm all" | `browser frontend-state dom` |
| "arm browser and react" | `browser frontend-state` (`react` is an accepted alias) |
| "arm proofline" / "arm the probes" / "start logging" (unqualified) | `browser frontend-state` (the default) |
| "arm the browser" | `browser` |
| "watch this field" / a blank-value bug | add `dom` with `--selector=` |
| "arm the database" | see `references/database.md` — a separate mechanism |

`browser` and `frontend-state` are the persistent lanes: they are registered on the Playwright **context**
via `addInitScript` and buffer to `localStorage`, so **the log survives reloads, SPA route changes,
full URL changes, logins and newly opened tabs**. This is the point of the design — the events
around a navigation are usually the ones being investigated, and a `window`-based buffer loses
exactly those.

## Procedure

**1. Open the browser and hand it to the human.**

```
browser_navigate → the app URL (or about:blank)
```

Then say: *"Browser is open — navigate to the screen and log in. Tell me when to arm."*
**Let the human drive.** Do not click through authentication yourself.

**2. Build the snippet.**

```bash
node <repo>/bin/proofline.js arm browser frontend-state
node <repo>/bin/proofline.js arm all --selector='#status, [name$=".state"]' --slices=form,navigation
```

**3. Arm it.** Paste the CLI's entire output as the `code` argument of
`mcp__playwright__browser_run_code_unsafe`. Confirm the returned object shows
`installed: true` and, for the frontend-state lane, a non-null `stateAdapter`.

> **Read the snippet before pasting it.** `browser_run_code_unsafe` runs in the MCP server's Node
> process with the user's full permissions — not in the page sandbox. The CLI therefore *prints*
> rather than executes, and what it prints is short, deterministic and fetches nothing over the
> network, so it can be reviewed in a few seconds. That review is the mitigation. If the snippet
> contains anything beyond `addInitScript` + `evaluate` + a status read, do not paste it.
>
> This is the only step that uses the unsafe tool, apart from disarming. Every read goes through
> `browser_evaluate`. If the user's setup does not have the unsafe tool enabled, use
> `--no-persist`, which emits a `browser_evaluate` snippet instead — and tell them plainly that the
> log will not survive reloads.

If `stateAdapter` is `null`, the poll is still running (it polls for 60s) — re-check after the human
interacts, or no supported adapter is present and the lane simply has nothing to attach to. Say
which; it is not an error.

**4. Tell the human to reproduce.** Explicitly: *"Probes armed. Reload, navigate, log in — the log
survives all of it. Do the thing that breaks, then tell me."*

**5. Read it back.** In one message, in parallel:

```bash
node <repo>/bin/proofline.js summary                  # → browser_evaluate: counts by type, run span
node <repo>/bin/proofline.js read 'net-|state-change' # → browser_evaluate: the filtered timeline
```

plus `browser_console_messages { level: "error" }` and `browser_network_requests { static: false }`
for anything that happened **before** the probe was armed, and `browser_take_screenshot` for a
visual frame. Always `summary` first — a full log can be thousands of events, and the counts tell
you which filter to read.

**6. Correlate, don't guess.** Every event carries `t` (ms since arm), `load` (which page load) and
`at` (which route). The payoff is lining these up: *"`value-changed` to empty at t=3120, 40ms after
the `net-response` 200 for `getRecord` — the response is overwriting it, the field is not failing to
load."* State the chain you can see; flag what you cannot.

**7. Disarm when done.** Not optional — an armed probe wraps `fetch` and `console` in every tab of
that context and quietly follows the human into unrelated work.

```bash
node <repo>/bin/proofline.js disarm
```

## Traps this encodes

- **`addInitScript({ content })`, never `{ path }`.** `path` snapshots the file at registration time
  and silently ignores later edits — an old probe that looks armed is the worst failure mode.
- **Arm the open page too.** `addInitScript` only affects *future* loads; without the inline
  `evaluate` the probe appears dead until someone happens to reload. The CLI does both.
- **Clear the previous run's keys.** A stale `__proofline_epoch` stamps today's events as offsets from a
  session days ago. The CLI clears unless `--keep`.
- **Subscribe, never wrap `dispatch`.** A late dispatch wrap misses dispatches made *inside* thunks,
  and wrapping dispatch is an intervention that changes application behaviour — it has been observed
  to blank out virtualised lists mid-test. The frontend-state lane subscribes to the store instead.
- **Value changes need polling.** A value set through the DOM property setter fires no event and
  mutates no attribute, so a `MutationObserver` cannot see it. That is why the `dom` lane polls the
  selector.
- **`browser_run_code_unsafe` has no `require` and no filesystem.** Its `path` argument fails with
  `__fn__ is not a function`. Everything must arrive as inline `code` — which is what the CLI prints.

## References

- `references/frontend-state.md` — adapters, finding the store, slice signatures, blind spots
- `references/browser-dom.md` — the DOM/value/CSS lane, iframes, framework method hooking
- `references/database.md` — the backend lane: audit triggers over a live dev database
- `references/reading-traces.md` — how to merge the lanes and read the causal chain
