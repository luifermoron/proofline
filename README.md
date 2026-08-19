# Proofline

### One clock. Every layer. Follow the proof: find the bug or understand how it works.

**Tell your coding agent "arm proofline", drive the app yourself, and get back one timestamped
timeline of everything that happened — clicks, network calls, console errors, frontend state changes,
DOM mutations — across reloads and URL changes.**

That timeline is the deliverable, and it serves two jobs equally well:

- 🐛 **Hunting a bug** — you see where the chain actually broke, on which layer, at which
  millisecond. No more bisecting by hypothesis.
- 🔍 **Learning how something works** — click through a feature once and read back what the code
  really does: which endpoints, which state, in which order. Faster and more accurate than reading
  the source, because it is the source _executing_.

**You direct, the agent investigates.** You drive the app — navigate, log in, reproduce. proofline
records. The agent then reads the trace, follows it into the code, and comes back with something
concrete: a proposed fix, or an explanation of how the thing actually works. What happens next is
your call — apply it, ask for the call trace end to end, or keep pulling the thread.

Nothing here automates your clicks, and that is deliberate: it is why proofline works on screens an
agent cannot reach on its own — SSO, multi-step flows, real data. The output is JSON on one axis, so
the agent can filter it, correlate it and cite exact timestamps instead of guessing from the code.

A Claude Code [skill](https://docs.claude.com/en/docs/claude-code/skills) plus the probe it installs.
It turns "the field goes blank sometimes" into `value-changed at t=3120, 40ms after the getRecord
response, with no state-change between them`.

Generic: nothing is tied to a particular application or framework. Each lane is named after the
question it answers, and reports the `adapter` that answered it — `redux` today, others later. A
lane with no available adapter says so and stays quiet, rather than failing.

---

## 🎯 Why

**Precision about what actually ran.** Knowing the codebase does not help here — familiarity tells
you what the code _can_ do, never what it _did_ on this click, in this order, at this millisecond.
The author of a module is as blind to the sequence as a newcomer; they just have better guesses.
Reading the source produces plausible theories, and plausible theories are exactly what costs
afternoons.

That cuts both ways, which is why the tagline has two halves. **Find the bug** — the trace shows
where the chain actually broke, not where you assumed it did. **Understand how it works** — arm it
on a feature nobody on the team can explain any more, click through it once, and read back what the
code really does. Same tool, same trace; the only difference is whether you already knew what you
expected to see.

⏱️ **One clock** is the mechanism behind both. Every lane stamps the same wall-clock epoch, so the
click, the state change, the HTTP response and the DOM mutation merge into one sorted list —
**every layer** on a single axis — and the causal story reads across them instead of within one.

**The log survives reloads, SPA route changes, full URL changes, logins and new tabs.** The probe is
registered on the Playwright browser _context_ through `addInitScript`, so it reinstalls itself
before application code on every load, and events buffer to `localStorage` against one shared epoch.
This matters more than it sounds: the events immediately around a navigation are usually the ones
being investigated, and a `window`-based buffer loses exactly those.

---

## 📋 Prerequisites

|                               |                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Node.js**                   | 18+ — only for the CLI that builds the snippets. No dependencies, nothing to install.                                                |
| **Playwright MCP**            | The [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) server, connected to your agent.                                |
| **`browser_run_code_unsafe`** | Must be enabled on that MCP server — see the trade-off below. Only needed to arm and disarm; without it you get `--no-persist` mode. |
| **A database MCP**            | _Optional_, only for the database lane — [`dbhub`](https://github.com/bytebase/dbhub) or any `execute_sql` tool.                     |

Check the Playwright MCP is connected by asking your agent to list its tools; you need
`browser_navigate`, `browser_evaluate`, `browser_network_requests`, `browser_console_messages`, and
— for persistence — `browser_run_code_unsafe`.

---

## ⚠️ The `browser_run_code_unsafe` trade-off

**Read this before installing.** Persistence across reloads has a real cost, and some teams have
this tool disabled by policy.

JavaScript can run in two separate places, and they are not equivalent:

|                        | `browser_evaluate`        | `browser_run_code_unsafe`                    |
| ---------------------- | ------------------------- | -------------------------------------------- |
| Runs in                | the **page's** JS context | the **MCP server's Node process**            |
| Permissions            | those of any web page     | **yours** — full filesystem, `child_process` |
| Has `page` / `context` | no                        | yes                                          |
| Can survive a reload   | no                        | yes, via `addInitScript`                     |

`page.context().addInitScript()` is a **`BrowserContext`** method, so it only exists in the server
process. There is no in-page API meaning "run this on the next load" — that would be a browser
security hole. This is precisely why no other tool in the Playwright MCP set can do it, and why
arming needs the unsafe one.

The tool is **RCE-equivalent by design**: executing arbitrary code is its stated purpose, not a bug
to be patched. Playwright's own docs say to enable it only for trusted MCP clients. Two filed
issues make it concrete — [#1495, code injection via Node's `vm`
module](https://github.com/microsoft/playwright-mcp/issues/1495), and [#1651, arbitrary file read
via `page.goto('file:///…')` + `page.content()`](https://github.com/microsoft/playwright-mcp/issues/1651).

The threat that matters is not you typing commands — it is **prompt injection**. An agent with this
tool enabled that reads a hostile web page, issue comment or PR description can be instructed by
that text to run code in your Node process with your permissions.

### How this project limits the exposure

- **Two calls, then never again.** `arm` and `disarm` are the only operations that use the unsafe
  tool. Every read (`read`, `summary`) goes through `browser_evaluate`, the safe sandbox.
- **The snippet is short, deterministic and reviewable.** The CLI prints it to stdout; nothing is
  executed on your machine, nothing is fetched from the network. **Read it before pasting** — that
  review is the mitigation, and it is why the CLI prints rather than runs.
- **`--no-persist` needs none of it.** See below.

Full threat model, and what the probe does to your data once armed: [SECURITY.md](SECURITY.md).

### If you cannot enable it

```bash
proofline arm browser frontend-state --no-persist
```

Emits a plain `browser_evaluate` snippet. Everything works **except** persistence: the log dies on
every reload, SPA route change and login, and you must re-arm by hand each time. Since the events
around a navigation are usually the ones being investigated, treat this as a degraded mode, not an
equivalent one.

**Never arm production**, in either mode.

---

## 📦 Install

Clone, then link the skill into Claude Code:

```bash
git clone https://github.com/luifermoron/proofline.git ~/Projects/proofline

# available in every project
ln -s ~/Projects/proofline ~/.claude/skills/proofline

# or, just this project
ln -s ~/Projects/proofline <your-project>/.claude/skills/proofline
```

A symlink is preferable to a copy — pull the repo and every project gets the update.

Optionally put the CLI on your `PATH`:

```bash
chmod +x ~/Projects/proofline/bin/proofline.js
ln -s ~/Projects/proofline/bin/proofline.js /usr/local/bin/proofline
```

Verify Claude Code sees it: run `/skill-doctor`, or just say _"arm proofline"_ and check it loads
`proofline` rather than improvising.

---

## ▶️ Use

Talk to the agent. The skill handles the mechanics.

```
you:    open the app at localhost:3000
agent:  [opens browser] navigate to the screen and log in, tell me when to arm.

you:    arm browser and redux           ← "redux" is an alias for the frontend-state lane
agent:  [runs `proofline arm browser frontend-state`, pastes the snippet]
        Armed — browser + frontend-state (redux). Reload, navigate, log in, the log
        survives all of it. Do the thing that breaks, then tell me.

you:    ok the status field went blank after I saved
agent:  [reads the summary, then the filtered timeline]
        value-changed status "Open" → "" at t=3120, 40ms after the getRecord 200
        at t=3080, with no state-change between them. The store still holds
        "Open", so this is the render path, not the data.

        [now reads the code the trace points at — not the whole codebase]
        Cause: useRecordLoader.ts:88 writes the response straight to the input
        ref, bypassing the reducer. The 200 body has status: null because the
        PATCH at t=2990 did not echo it back.

        Two fixes. (a) dispatch setField from the handler so the store stays
        the source of truth — 3 lines, matches how the other fields work.
        (b) include status in the PATCH response — backend change, fixes it
        for every consumer, not just this form.

        Want me to apply (a), or keep digging on the backend side?

you:    keep digging — give me the full call trace, frontend to backend
agent:  [correlates the browser lane with the server, on the same axis]
        t=2980  click        button "Save"
        t=2990  net-request  PATCH /api/record/abc     { status: "Open" }
        t=3050  net-response PATCH 200                 status absent in body
        t=3080  net-response GET /api/record/abc 200   status: null
        t=3120  value-changed status "Open" → ""

        The PATCH succeeded but its serialiser drops null-able enums, so the
        refetch reads back a column that was never written. The write is the
        bug; the blank field is the symptom.

you:    ok apply (b) then, and disarm
```

Every agent turn there ends the same way: with evidence and an option, not with a commit. The trace
is what turns "I think it's the reducer" into a line number and a millisecond — and it is precisely
because the evidence is that specific that the decision can stay yours. Ask for the call trace at
any point; it is the same log, read at a different altitude.

### What "arm ..." maps to

| You say                            | Lanes armed                                         |
| ---------------------------------- | --------------------------------------------------- |
| `arm everything` / `arm all`       | browser + frontend-state + dom                      |
| `arm browser and react` / `redux`  | browser + frontend-state                            |
| `arm the probes` / `start logging` | browser + frontend-state (the default)              |
| `arm the browser`                  | browser only                                        |
| `arm servicenow`                   | browser + framework                                 |
| `arm the database`                 | SQL audit triggers — a separate, explicit mechanism |

### The lanes

- 🌐 **browser** — clicks, `fetch` + `XMLHttpRequest` with status/duration/error bodies, `console.error`
  and `warn`, uncaught errors and promise rejections, SPA route changes. _Persistent._
- 🧠 **frontend-state** — _what data changed, and when._ Ships the `redux` adapter: walks the fiber
  tree to the store (no code change, no DevTools) and subscribes rather than wrapping `dispatch`.
  Aliases: `react`, `redux`, `state`. _Persistent._
- 🧬 **dom** — MutationObserver for mount/unmount and visibility, plus a 100ms value poll over a CSS
  selector you supply. Noisy; opt in. _Persistent._
- 🔧 **framework** — _what the framework itself was told to do, and by whom._ Ships the `servicenow`
  adapter: wraps 15 `g_form` methods (`setDisplay`, `setValue`, `setSectionDisplay`…) and records each
  call with its stack, plus `g_scratchpad`. Aliases: `servicenow`, `gform`. _Persistent._
- 🗄️ **database** — _what rows changed, and in what order._ Postgres audit triggers capturing every
  row version with `txid` and `backend_pid`. Manual SQL, dev databases only. See
  `references/database.md`.

### What an event looks like

```json
{ "t": 3010, "load": "k29fx1", "at": "/records/abc", "type": "state-change",  "adapter": "redux", "changed": "form", "state": { "form": "{\"status\":\"Open\"…" } }
{ "t": 3080, "load": "k29fx1", "at": "/records/abc", "type": "net-response",  "method": "GET", "url": "/api/record/abc", "status": 200, "ms": 91 }
{ "t": 3120, "load": "k29fx1", "at": "/records/abc", "type": "value-changed", "el": "status", "from": "Open", "to": "" }
```

The first four fields are the same on every event, whichever lane emitted it. `t` is milliseconds
since arming — the shared axis, and the reason these three lines can be read as one story. `load`
changes on each page load and `at` records the route, so a log spanning navigations stays readable.
Everything after `type` is lane-specific; `adapter` names the mechanism that produced the event, and
long values are truncated rather than dropped.

---

## 🛠️ CLI

The CLI never touches the browser and never executes anything. It prints a snippet to stdout that
you (or the agent) paste as the `code` argument of `browser_run_code_unsafe` — or of
`browser_evaluate`, for `read`, `summary` and `--no-persist`. The MCP sandbox has no filesystem
access, so the probe has to arrive inline.

Printing rather than running is deliberate: the emitted snippet is short, deterministic and fetches
nothing, so **you can read it before you paste it**. Every snippet carries a one-line header saying
which tool it targets and what it runs in.

```bash
proofline arm [lanes...] [options]    # browser frontend-state dom framework all
                                      # default: browser frontend-state
                                      # aliases: react, redux, state → frontend-state
                                      #          servicenow, gform  → framework
proofline read [filter]               # filter is a regex over event type
proofline summary                     # counts by type, number of loads, span — read this first
proofline disarm
```

### Configuration

| Option                                   | Effect                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `--selector='#status, [name$=".state"]'` | elements the `dom` lane polls for value changes. Keep it narrow.               |
| `--slices=form,navigation`               | state slices to snapshot in full. Default: every slice, shallow.               |
| `--max=8000`                             | retained events (default 4000, oldest dropped first)                           |
| `--keep`                                 | append to the existing run instead of starting a fresh epoch                   |
| `--no-persist`                           | emit a `browser_evaluate` snippet instead — no unsafe tool, no reload survival |

```bash
proofline arm all --selector='[data-testid="amount"]' --slices=cart,checkout --max=8000
proofline read 'net-|state-change'
```

### Runtime switches

Set in the browser console or via `browser_evaluate`; read fresh on every load, so they survive
reloads like everything else:

| Key                                     | Effect                                            |
| --------------------------------------- | ------------------------------------------------- |
| `localStorage.__proofline_off = '1'`    | kill switch — the probe no-ops from the next load |
| `localStorage.__proofline_lanes`        | csv of active lanes                               |
| `localStorage.__proofline_dom_selector` | the `dom` lane's selector                         |
| `localStorage.__proofline_slices`       | csv of slices to snapshot in full                 |
| `localStorage.__proofline_max`          | retained event cap                                |

### In-page API

```js
window.__proofline.get()               // the full timeline
window.__proofline.get('net-')         // filtered by regex over type
window.__proofline.summary()           // counts, loads, span
window.__proofline.clear()             // drop the log and the epoch
window.__proofline.log('note', { … })  // add your own event on the shared clock
window.__store                         // the Redux store, once frontend-state attaches
```

---

## 🚧 Caveats

- **Disarm when you are done.** An armed probe wraps `fetch` and `console` in every tab of that
  browser context and will quietly follow you into unrelated work.
- **Never arm production.** It wraps global functions and buffers response bodies into
  `localStorage`. Development and test environments only.
- **Response bodies are captured on failures**, truncated to 600 characters. If your error payloads
  carry anything sensitive, treat the log accordingly and clear it afterwards.
- **`--selector` on a large form fills the budget fast.** A 100ms poll over every input on a busy
  screen will evict the events you wanted.
- **The frontend-state lane ships one adapter, `redux`**, and it only finds stores reachable through
  Provider props — not Zustand, Jotai, MobX or plain Context, and not a component's local
  `useState`. Absence of a `state-change` is not proof that nothing changed.
- **No lane proves a re-render happened.** `state-change` says the data changed, `dom-added` says
  something reached the screen; neither says React committed. A `render` lane would, and is not
  implemented.
- **Arming twice in one browser context stacks init scripts**, and Playwright cannot unregister one.
  The first registration keeps its wrappers and its lanes; the second only rewrites the stored
  configuration. The probe logs `probe-config-ignored` when it detects this — **disarm before
  re-arming with different lanes.**
- **Same-origin frames each run their own probe** and write their own log key; reads merge them and
  events carry a `frame` field. **Cross-origin frames are unreachable.** Nothing here changes that.

---

## 📄 License

MIT © Luis Morón — <contact@luifermoron.com>
