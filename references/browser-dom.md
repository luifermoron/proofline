# The browser and dom lanes

## browser lane (default, always worth arming)

| Event | Source | Answers |
|---|---|---|
| `click` | capture-phase listener on `window` | what the human actually clicked, and when |
| `net-request` / `net-response` / `net-failed` | `fetch` wrap | which calls fired, status, duration |
| `net-error-body` | cloned response on non-2xx | *why* the call failed, in the server's own words |
| `xhr-response` | `XMLHttpRequest.prototype.open` wrap | uploads and older code paths |
| `console-error` / `console-warn` | console wrap | warnings the app prints but nobody reads |
| `js-error` / `promise-rejection` | `error` / `unhandledrejection` | the exception that killed the render |
| `route-pushState` / `replaceState` / `popstate` / `hashchange` | history wrap | SPA navigations, which reload nothing and are otherwise invisible |

Both `fetch` **and** `XMLHttpRequest` are wrapped, because a missing request is indistinguishable
from a request on the transport you forgot to hook.

The error body is read from `response.clone()` so the application still gets to consume the original
stream — reading the real one breaks the app you are debugging.

### Why not just use `browser_network_requests` and `browser_console_messages`?

Use them too — they catch what happened *before* the probe was armed. But they are request/response
snapshots on Playwright's clock, with no relationship to state changes or DOM mutations. The lane's
value is that its network events sit on the **same axis** as the store and DOM events, so
`net-response → state-change → dom-removed` reads as one sentence.

## dom lane (opt in — noisy)

Two mechanisms, because one is not enough:

**MutationObserver** over `document.body`, subtree, watching `childList` plus the attributes
`class`, `hidden`, `aria-hidden`, `style`, `disabled`, `value`. Catches mount/unmount (`dom-added`,
`dom-removed`) and visibility flips (`dom-attr`). This is how you separate *"the element never
rendered"* from *"it rendered and something hid it"* — a distinction that costs hours if guessed.

**A 100ms value poll** over `--selector=`, emitting `value-changed { el, from, to }`.

> A value assigned through the DOM property setter (`el.value = ""`, which is what React and most
> frameworks do) fires **no event** and mutates **no attribute**. A MutationObserver is structurally
> blind to it. Polling is the only way to catch a field going blank, which is why the selector
> exists.

```bash
node bin/proofline.js arm all --selector='#status, [name$=".state"], [data-testid="amount"]'
```

Keep the selector narrow. `input, select, textarea` on a large form will fill the 4000-event budget
before the human finishes clicking.

## Iframes

The probe runs in the top document. Legacy and platform UIs often render forms inside an iframe;
`addInitScript` **does** apply to same-origin child frames in Playwright, so the probe installs
there too — but each frame has its own `window.__proofline` and its own `localStorage` view if the
origins differ.

To read a frame's log, evaluate against that frame, or walk from the top:

```js
() => Array.from(window.frames).map((f, i) => {
	try { return { i, url: f.location.href, armed: !!f.__proofline, events: f.__proofline ? f.__proofline.get().length : 0 }; }
	catch (e) { return { i, crossOrigin: true }; }
})
```

Cross-origin frames are unreachable by design. Nothing here changes that.

## Hooking a framework's own methods

When the application exposes a global object, wrapping its setters gives you the **cause** of a
change rather than only its effect — "the value went blank" becomes "`setValue('')` was called, from
this stack".

```js
() => {
	const target = window.g_form;           // whatever global the app exposes
	["setValue", "clearValue", "setDisplay", "setReadOnly"].forEach((name) => {
		const orig = target[name];
		if (!orig || orig.__prooflineWrapped) return;
		const wrapped = function () {
			window.__proofline.log("fw-" + name, {
				args: Array.prototype.slice.call(arguments).map(String).join(", ").slice(0, 200),
				stack: (new Error().stack || "").split("\n").slice(2, 6).join(" | ").slice(0, 400)
			});
			return orig.apply(this, arguments);
		};
		wrapped.__prooflineWrapped = true;
		target[name] = wrapped;
	});
	return { hooked: true };
}
```

It logs through `window.__proofline.log`, so the events land in the same persistent buffer on the same
clock as everything else. Note this hook is **not** persistent — the global usually does not exist at
document-start, so re-apply it after a reload, or move the wrap inside a poll.

## Server-seeded state

Many apps stash the data the client rendered from on a global (`window.__INITIAL_STATE__`,
`g_scratchpad`, `__NEXT_DATA__`). Dump it once — for "the value is right in the database but the
widget shows blank" bugs it is often the whole answer, because it shows what the client was actually
handed.
