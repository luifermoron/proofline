# Reading a trace

## The shape of an event

```json
{ "t": 3120, "load": "k29fx1", "at": "/studio/form/abc", "type": "value-changed", "el": "status", "from": "Open", "to": "" }
```

| Field | Meaning |
|---|---|
| `t` | milliseconds since **arm** — the shared axis across every lane |
| `load` | which page load produced it; a new id means a reload or full navigation happened |
| `at` | path + query at the moment of the event |
| `type` | lane-specific event type |

`t` is wall-clock based (`Date.now() - epoch`), deliberately: `performance.now()` restarts at zero
on every load and cannot order events across a navigation.

## Start with the summary, always

```bash
node bin/proofline.js summary
```

```json
{ "total": 812, "loads": 3, "spanMs": 47210, "counts": { "net-request": 120, "state-change": 402, … } }
```

A full log is easily thousands of events. The counts tell you which filter to read, and `loads: 3`
tells you the human reloaded twice — which is often itself the finding.

## Then filter

```bash
node bin/proofline.js read 'net-|state-change'
node bin/proofline.js read 'value-changed|dom-removed'
node bin/proofline.js read 'error|rejection|console-'
```

The filter is a regex over `type`.

## Reading the chain

The whole design exists so that one sorted list shows cause and effect across layers. What a healthy
interaction looks like:

```
t=0      click            button "Save"
t=4      state-change     changed: form
t=9      net-request      POST /api/record
t=310    net-response     POST /api/record 200
t=316    state-change     changed: form,notifications
t=330    dom-added        DIV .success-banner
```

Each of these breaks tells you something different:

| What is missing | What it means |
|---|---|
| `click` present, no `state-change` | the handler never ran — wrong element, disabled, or the listener was not attached |
| `state-change` but no `net-request` | the client short-circuited; look for a guard or a dirty-check |
| a field changed with no `framework-call` | nothing asked the framework to do it — suspect the render path, not a script |
| `net-request` with no `net-response` | in flight, aborted, or the page navigated away mid-call |
| `net-response 200` then a wrong value | the payload is the problem, or a reducer overwrote it — read `net-error-body` / the store slice |
| `state-change` but no `dom-added` | state is right, the render is not — a memo, a key, or a selector |
| `dom-added` then `dom-removed` milliseconds later | it rendered and something unmounted it; look at what fired between |

## Check the name before you trust a null

In a real investigation the trace kept reporting that a status field was empty and had no options,
and three rounds of diagnosis went into why it failed to load. It had not failed. The field the form
actually used was named differently from the label shown on screen; it held the correct value the
whole time, and every probe had been asking for the name from the label, which did not exist as a
field. The `null` was accurate and the conclusion drawn from it was not.

Before reading absence as failure, confirm the selector, field name or slice name actually exists —
`framework-adapter` logs the table, `state-adapter` logs the slice names, and one `browser_evaluate`
confirms a selector matches. A null from a wrong name looks exactly like a null from a real bug.

## The two things worth being careful about

**Correlation is not causation across a 300ms gap.** Two events 4ms apart in the same load are
plausibly causal. Two events 3 seconds apart, across a reload, are not — say so rather than asserting
a chain you cannot see.

**Absence is evidence, but only for what the lane can see.** No `state-change` proves no Redux state
changed. It does not prove nothing changed — a component's local `useState` is invisible to every
lane here. Be explicit about which of the two you are claiming.

## Merging with the tools outside the probe

- `browser_network_requests { static: false }` — everything, including before the arm. Playwright's
  clock, so align by URL and status rather than by number.
- `browser_console_messages { level: "error" }` — same, and it catches errors thrown before the
  console wrap was installed.
- `browser_take_screenshot` / `browser_snapshot` — what the screen looked like at the end.
- The database lane — see `database.md` for putting `clock_timestamp()` onto the same axis.

## Reporting

State the chain you can see, with timestamps, then what you cannot see and what would settle it.

> `value-changed status: "Open" → ""` at t=3120, 40ms after the `net-response 200` for
> `GET /api/record/abc` at t=3080, and there is no `state-change` between them — the DOM value is
> being set from the response handler directly, not through the store. The store still holds "Open"
> (verified via `getState().form`). This is a render-path bug, not a data bug.
