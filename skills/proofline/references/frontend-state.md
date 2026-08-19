# The frontend-state lane

Answers one question: **what data changed, and when?** The mechanism that answered it is reported on
every event as `adapter`, so the lane keeps its name and its event types as adapters are added.

| Adapter | Status | Mechanism |
|---|---|---|
| `redux` | shipped | fiber walk to the Provider's store, then `subscribe` |
| `zustand` / `jotai` / `context` | not implemented | would attach the same way, emit the same events |

Sibling lanes answer different questions: `dom` answers "did it reach the screen?", and a future
`render` lane would answer "did the framework re-render?" — see the note at the end.

## Redux adapter — store attachment and state history

## How the store is found

No code change and no DevTools. The lane walks the React fiber tree looking for a component whose
props carry a `store` with `getState` — which is the `<Provider store={…}>`, wherever it sits.

```js
const root = document.querySelector("#root");
const key = Object.keys(root).find((k) => k.indexOf("__reactContainer$") === 0);
const entry = root[key].child;   // HostRoot fiber's child
```

Three shapes are tried in order, because the property carrying the tree has moved between React
versions:

1. `root[key].child` — React 18/19: the HostRoot fiber is attached directly, so its own `.child` is
   the entry. **This is the one that works on current React**; `.current` does not exist on a fiber.
2. `root[key].stateNode.current.child`
3. `root[key].current.child`

The store does not exist at document-start, so the lane **polls every 250ms for 60 seconds** and
attaches when it appears. That is why arming reports `stateAdapter: null` immediately after a hard
reload and `true` a moment later — re-check before concluding the app is not Redux.

Root selectors tried: `#root`, `#app`, then every direct `body > div`.

## Subscribe, never wrap dispatch

The lane calls `store.subscribe(...)`. This is deliberate and worth not "improving":

- A **late-applied dispatch wrap sees only top-level dispatches.** Dispatches made *inside* a thunk
  go through the dispatch captured at `configureStore` time and are invisible to it — which is
  usually exactly where the interesting mutation happens.
- **Wrapping dispatch is an intervention.** It has been observed to blank out a virtualised data
  grid mid-session. A probe that changes the bug it is measuring is worse than no probe.
- `subscribe` fires after **every** reduced action, inner ones included. It is the source of truth
  for *what changed*.

The trade-off: `subscribe` gives you the **effect**, not the **name** of the action. If you need
action names, add real Redux middleware at `configureStore` time — that is a codebase change, and it
must be gated behind a non-production check.

## Slice signatures

With no configuration, every top-level slice is tracked **by reference**. Immutable reducers replace
the slice object on change, so reference inequality is a correct and very cheap change detector, and
each `state-change` event names the changed slices with a 300-char preview of each.

When you already know which slices matter:

```bash
node <skill>/scripts/proofline.js arm frontend-state --slices=form,navigation,currentRecord
```

Named slices get a 1200-char preview instead. Naming slices also stops an unrelated slice that
churns on every tick from burying the change you are hunting.

Read `state-adapter` in the log for the actual slice names — it records `Object.keys(getState())`, so
you never have to guess them from the source.

## Reading it

```bash
node <skill>/scripts/proofline.js read 'state-'
```

Each event: `{ t, load, at, type: "state-change", adapter: "redux", changed: "form,ui", state: { form: "…", ui: "…" } }`

The useful move is filtering to `state-change|net-` and looking at what precedes a wrong value: a
`state-change` with no preceding `net-response` means the client decided it locally; one immediately
after means the server's payload is what you should be reading next.

## Limitations, stated honestly

- The Redux adapter only finds stores reachable through Provider props. Zustand, Jotai, MobX and
  React Context have no adapter yet, so the lane reports `state-adapter-missing` and stays silent —
  use the `dom` lane and the network log instead.
- One store. The first match wins; a multi-store app needs the walk narrowing by root element.
- No action names (see above).
- **No render information.** This lane proves the data changed, never that React re-rendered. That
  is a sibling lane's job (`render`, not implemented): React reports commits to
  `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` if the hook exists before React loads — which
  `addInitScript` makes possible. Kept separate because commits are far noisier than state changes,
  and you should not have to pay for one to get the other.
- `state` previews are truncated. For a full slice dump, read it directly:
  `browser_evaluate → () => window.__store.getState().form`
