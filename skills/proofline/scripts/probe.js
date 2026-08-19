/**
 * proofline — persistent document-start probe.
 *
 * One clock. Every layer. Follow the proof: find the bug or understand how it works.
 *
 * Registered through `context.addInitScript`, so it runs before application code on every page,
 * every reload, every route change and every new tab of the browser context. Events buffer to
 * `localStorage` against a single wall-clock epoch, so one continuous timeline spans navigations —
 * a `window`-based buffer is wiped by each load and would lose exactly the events around a reload,
 * which are usually the ones being investigated.
 *
 * Generic: nothing here is tied to a particular application. Everything tunable is read from
 * `localStorage` at load time, so configuration survives reloads the same way the log does.
 *
 * Read back:     window.__proofline.get()
 * Summarise:     window.__proofline.summary()
 * Kill switch:   localStorage.__proofline_off = '1'   (then reload)
 *
 * Configuration keys (all optional, all read fresh on every load):
 *   __proofline_lanes         csv of enabled lanes: browser,frontend-state,dom,framework
 *                             (default "browser")
 *   __proofline_dom_selector  CSS selector the dom lane watches for value changes (default none)
 *   __proofline_slices        csv of state slice names to snapshot (default: all top-level slices)
 *   __proofline_max           max retained events (default 4000)
 *
 * @author Luis Morón <contact@luifermoron.com>
 */
(() => {
	"use strict";

	/* ------------------------------------------------------------------ storage */

	// An origin-less document (about:blank, a sandboxed frame, or a browser with site data blocked)
	// throws SecurityError on bare `localStorage` access, which would abort the probe before the
	// sentinel is set. Storage is therefore treated as optional, never assumed.
	function lsGet(key) {
		try {
			return localStorage.getItem(key);
		} catch (e) {
			return null;
		}
	}

	function lsSet(key, value) {
		try {
			localStorage.setItem(key, value);
			return true;
		} catch (e) {
			return false;
		}
	}

	function lsRemove(key) {
		try {
			localStorage.removeItem(key);
		} catch (e) {}
	}

	// Index within the parent, not a random id: it has to be stable across reloads or every load would
	// leak another log key. A cross-origin parent throws on access, so that case falls back to a random
	// id and simply accepts the leak — it is rare, and losing events is worse.
	function detectFrameId() {
		try {
			if (window.top === window.self) {
				return "top";
			}
			const siblings = window.parent.frames;
			for (let i = 0; i < siblings.length; i += 1) {
				if (siblings[i] === window.self) {
					return "f" + i;
				}
			}
		} catch (e) {}
		return "x" + Math.random().toString(36).slice(2, 6);
	}

	if (lsGet("__proofline_off") === "1") {
		return;
	}
	if (window.__proofline) {
		// A second `arm` in the same browser context stacks another init script — Playwright offers no
		// way to unregister one. The stacked script's prelude has already rewritten the configuration
		// keys by the time it gets here, but the wrappers belong to the first script and cannot be
		// replaced, so the new configuration is silently ignored. Saying so beats letting localStorage
		// advertise lanes that are not running.
		try {
			const requested = lsGet("__proofline_lanes") || "";
			const active = window.__proofline.lanes.join(",");
			if (requested !== active) {
				window.__proofline.log("probe-config-ignored", { active, requested, fix: "disarm first, then arm again" });
			}
		} catch (e) {}
		return;
	}

	/* ------------------------------------------------------------------- config */

	// Every same-origin frame runs its own copy of this probe (addInitScript is evaluated in each
	// frame), and they all share one localStorage. A single log key therefore means two frames doing
	// read-concat-write at the same time, and the later write silently drops the earlier one — losing
	// exactly the form-iframe events worth having. Each frame writes its own key instead, and reads
	// merge every key back together.
	const LOG_PREFIX = "__proofline_log";
	const FRAME_ID = detectFrameId();
	const LOG_KEY = FRAME_ID === "top" ? LOG_PREFIX : LOG_PREFIX + "__" + FRAME_ID;
	const EPOCH_KEY = "__proofline_epoch";
	const FLUSH_MS = 1000;
	const MAX_EVENTS = Number(lsGet("__proofline_max")) || 4000;
	const LANES = (lsGet("__proofline_lanes") || "browser")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const DOM_SELECTOR = lsGet("__proofline_dom_selector") || "";
	const SLICES = (lsGet("__proofline_slices") || "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	function laneOn(name) {
		return LANES.indexOf(name) !== -1 || LANES.indexOf("all") !== -1;
	}

	// performance.now() restarts at 0 on every load, so it cannot order events across navigations.
	// A shared wall-clock epoch in localStorage can — every event is `ms since arm`, one axis for
	// every lane, which is what makes click -> action -> network -> DOM readable as one story.
	let epoch = Number(lsGet(EPOCH_KEY));
	if (!epoch) {
		epoch = Date.now();
		lsSet(EPOCH_KEY, String(epoch));
	}

	let buffer = [];
	const loadId = Math.random().toString(36).slice(2, 8);

	function trunc(value, max) {
		const s = typeof value === "string" ? value : String(value);
		return s.length > max ? s.slice(0, max) + "…" : s;
	}

	function log(type, data) {
		buffer.push(
			Object.assign(
				{
					t: Date.now() - epoch,
					load: loadId,
					// Once a log spans navigations, "which screen was this?" is no longer answerable
					// from the timestamp alone, so every event carries its own location.
					at: location.pathname + location.search,
					// Omitted on the top frame, which is most events: a field written on every line of a
					// log that rarely has frames is pure weight.
					frame: FRAME_ID === "top" ? undefined : FRAME_ID,
					type
				},
				data
			)
		);
		if (buffer.length > 200) {
			flush();
		}
	}

	function readStored() {
		try {
			return JSON.parse(lsGet(LOG_KEY) || "[]");
		} catch (e) {
			return [];
		}
	}

	// Reads merge every frame's key and sort on the shared epoch, so one `get()` from any frame returns
	// the whole picture — which is the entire point of stamping one clock.
	function readAllFrames() {
		const events = [];
		try {
			Object.keys(localStorage).forEach((key) => {
				if (key.indexOf(LOG_PREFIX) !== 0) {
					return;
				}
				try {
					JSON.parse(localStorage.getItem(key) || "[]").forEach((event) => events.push(event));
				} catch (e) {}
			});
		} catch (e) {
			return readStored();
		}
		// `Object.keys` over a Storage object enumerates its keys in every real browser, but a stub or an
		// exotic environment can return nothing — and silently reporting an empty log is the worst
		// possible failure for a debugging tool. Fall back to this frame's own key.
		if (events.length === 0) {
			return readStored();
		}
		return events.sort((a, b) => a.t - b.t);
	}

	function flush() {
		if (buffer.length === 0) {
			return;
		}
		const merged = readStored().concat(buffer);
		if (lsSet(LOG_KEY, JSON.stringify(merged.slice(-MAX_EVENTS)))) {
			buffer = [];
			return;
		}
		// Quota exceeded: drop the oldest half rather than the newest events, which are the ones
		// being asked for. Dropped either way — an unbounded in-memory buffer on a page that cannot
		// persist is just a leak.
		lsSet(LOG_KEY, JSON.stringify(merged.slice(-Math.floor(MAX_EVENTS / 2))));
		buffer = [];
	}

	window.__proofline = {
		lanes: LANES,
		frame: FRAME_ID,
		get(filter) {
			flush();
			const all = readAllFrames();
			if (!filter) {
				return all;
			}
			const re = new RegExp(filter);
			return all.filter((e) => re.test(e.type));
		},
		summary() {
			flush();
			const all = readAllFrames();
			const counts = {};
			all.forEach((e) => {
				counts[e.type] = (counts[e.type] || 0) + 1;
			});
			const frames = all.reduce((acc, e) => (acc.indexOf(e.frame || "top") === -1 ? acc.concat(e.frame || "top") : acc), []);
			return { total: all.length, loads: all.reduce((acc, e) => (acc.indexOf(e.load) === -1 ? acc.concat(e.load) : acc), []).length, frames, spanMs: all.length ? all[all.length - 1].t - all[0].t : 0, counts, lanes: LANES };
		},
		clear() {
			buffer = [];
			try {
				Object.keys(localStorage)
					.filter((key) => key.indexOf(LOG_PREFIX) === 0)
					.forEach(lsRemove);
			} catch (e) {
				lsRemove(LOG_KEY);
			}
			lsRemove(EPOCH_KEY);
			return true;
		},
		log
	};

	log("probe-installed", { url: location.href, lanes: LANES.join(","), ua: trunc(navigator.userAgent, 60) });

	/* ================================================================ browser lane */

	if (laneOn("browser")) {
		/* -------------------------------------------------------------- errors */

		window.addEventListener("error", (e) => log("js-error", { message: trunc(e.message, 300), source: trunc(e.filename || "", 160), line: e.lineno }));
		window.addEventListener("unhandledrejection", (e) => {
			const reason = e.reason;
			log("promise-rejection", { message: trunc((reason && (reason.message || reason)) || "unknown", 300), stack: trunc((reason && reason.stack) || "", 400) });
		});

		/* ------------------------------------------------------------- console */

		["error", "warn"].forEach((level) => {
			const orig = console[level];
			if (orig.__prooflineWrapped) {
				return;
			}
			const wrapped = function () {
				const args = Array.prototype.slice.call(arguments);
				try {
					log("console-" + level, { message: trunc(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" "), 400) });
				} catch (e) {}
				return orig.apply(console, args);
			};
			wrapped.__prooflineWrapped = true;
			console[level] = wrapped;
		});

		/* ------------------------------------------------------------- network */

		// Both transports are wrapped: most apps use fetch, but uploads and older code paths still
		// use XMLHttpRequest, and a missing request is indistinguishable from a request on the
		// transport you forgot to hook.
		if (!window.fetch.__prooflineWrapped) {
			const origFetch = window.fetch;
			const wrappedFetch = function () {
				const args = Array.prototype.slice.call(arguments);
				const url = typeof args[0] === "string" ? args[0] : args[0] && args[0].url;
				const method = ((args[1] && args[1].method) || (typeof args[0] === "object" && args[0] && args[0].method) || "GET").toUpperCase();
				const started = Date.now() - epoch;
				log("net-request", { method, url: trunc(url, 200) });
				return origFetch.apply(window, args).then(
					(response) => {
						log("net-response", { method, url: trunc(url, 200), status: response.status, ms: Date.now() - epoch - started });
						// A failing call is the most likely cause of a blank or wrong screen, so its
						// body is captured — from a clone, so the app still gets to read the stream.
						if (!response.ok) {
							try {
								response
									.clone()
									.text()
									.then((body) => log("net-error-body", { url: trunc(url, 200), status: response.status, body: trunc(body, 600) }))
									.catch(() => {});
							} catch (e) {}
						}
						return response;
					},
					(error) => {
						log("net-failed", { method, url: trunc(url, 200), error: trunc((error && error.message) || "unknown", 200) });
						throw error;
					}
				);
			};
			wrappedFetch.__prooflineWrapped = true;
			window.fetch = wrappedFetch;
		}

		if (!XMLHttpRequest.prototype.open.__prooflineWrapped) {
			const origOpen = XMLHttpRequest.prototype.open;
			const wrappedOpen = function (method, url) {
				const xhr = this;
				xhr.addEventListener("loadend", () => log("xhr-response", { method, url: trunc(url, 200), status: xhr.status }));
				return origOpen.apply(this, arguments);
			};
			wrappedOpen.__prooflineWrapped = true;
			XMLHttpRequest.prototype.open = wrappedOpen;
		}

		/* ------------------------------------------------------------- routing */

		// SPA route changes do not reload the page, so without these hooks a whole navigation is
		// invisible in the timeline.
		["pushState", "replaceState"].forEach((method) => {
			const orig = history[method];
			if (orig.__prooflineWrapped) {
				return;
			}
			const wrapped = function (state, title, url) {
				log("route-" + method, { url: trunc(String(url), 200) });
				return orig.apply(history, arguments);
			};
			wrapped.__prooflineWrapped = true;
			history[method] = wrapped;
		});
		window.addEventListener("popstate", () => log("route-popstate", { url: location.pathname + location.search }));
		window.addEventListener("hashchange", () => log("route-hashchange", { url: location.hash }));

		/* --------------------------------------------------------------- input */

		// What the human actually clicked, on the same axis as everything else — without it the
		// timeline starts at an effect with no visible cause.
		window.addEventListener(
			"click",
			(e) => {
				const el = e.target;
				if (!el || el.nodeType !== 1) {
					return;
				}
				log("click", { tag: el.tagName, id: el.id || "", cls: trunc(String(el.className || ""), 60), text: trunc((el.textContent || "").trim(), 60), testid: el.getAttribute("data-testid") || "" });
			},
			true
		);
	}

	/* =========================================================== frontend-state lane */

	// One lane per question, not one per technology. This lane answers "what data changed?"; the
	// mechanism it used to find out is reported as `adapter`, so a future Zustand or Context adapter
	// slots in without renaming the lane or breaking anyone's filters.
	if (laneOn("frontend-state")) {
		// The store does not exist at document-start, so it is polled for and attached to when it
		// appears. Subscribed rather than dispatch-wrapped: a subscriber sees dispatches made inside
		// thunks too (a late dispatch wrap does not), and wrapping dispatch is an intervention that
		// can change application behaviour — it has been observed to blank out virtualised lists.
		let polls = 0;
		const timer = setInterval(() => {
			polls += 1;
			if (polls > 240) {
				clearInterval(timer);
				// Not an error: an app with no supported store simply has nothing for this lane.
				log("state-adapter-missing", { polls, tried: "redux" });
				return;
			}

			const roots = Array.prototype.slice.call(document.querySelectorAll("#root, #app, body > div"));
			let found = null;

			for (const root of roots) {
				const key = Object.keys(root).find((k) => k.indexOf("__reactContainer$") === 0);
				if (!key) {
					continue;
				}
				// React attaches the HostRoot fiber directly under __reactContainer$, so the entry
				// point is its own `.child`. The other two shapes are kept as fallbacks because the
				// property carrying the tree has moved between React versions.
				const entry = (root[key] && root[key].child) || (root[key] && root[key].stateNode && root[key].stateNode.current && root[key].stateNode.current.child) || (root[key] && root[key].current && root[key].current.child) || null;
				(function walk(node, depth) {
					if (!node || depth > 60 || found) {
						return;
					}
					if (node.memoizedProps && node.memoizedProps.store && node.memoizedProps.store.getState) {
						found = node.memoizedProps.store;
						return;
					}
					walk(node.child, depth + 1);
					walk(node.sibling, depth + 1);
				})(entry, 0);

				if (found) {
					break;
				}
			}

			if (!found) {
				return;
			}

			clearInterval(timer);
			window.__store = found;
			const keys = Object.keys(found.getState());
			log("state-adapter", { adapter: "redux", polls, slices: keys.join(",") });

			// Per-slice signatures rather than one whole-state blob: an unrelated slice churning
			// every tick would otherwise mask the change being looked for, and the log would be
			// mostly noise. With no __proofline_slices configured every slice is tracked by reference,
			// which is cheap and correct for immutable reducers.
			const tracked = SLICES.length ? SLICES : keys;
			const last = {};
			found.subscribe(() => {
				try {
					const state = found.getState();
					const changed = [];
					tracked.forEach((name) => {
						const slice = state[name];
						if (last[name] === slice) {
							return;
						}
						last[name] = slice;
						changed.push(name);
					});
					if (changed.length === 0) {
						return;
					}
					const detail = {};
					changed.forEach((name) => {
						detail[name] = trunc(JSON.stringify(state[name]), SLICES.length ? 1200 : 300);
					});
					log("state-change", { adapter: "redux", changed: changed.join(","), state: detail });
				} catch (e) {}
			});
		}, 250);
	}

	/* ============================================================== framework lane */

	// Answers "what did the application framework itself do, and who asked for it?" — the question the
	// other lanes structurally cannot reach. `dom` sees a field go blank; this sees the setDisplay call
	// that blanked it, with the stack of whatever script made it. On a real investigation that was the
	// difference between "the fields are hidden" and "one script hid four legacy fields and showed six
	// new ones in the same millisecond".
	//
	// Adapter: servicenow (window.g_form). ServiceNow Classic renders the form in an iframe, so this
	// relies on the probe running in every frame — each frame hooks its own g_form.
	if (laneOn("framework")) {
		const GFORM_METHODS = ["setValue", "clearValue", "setDisplay", "setVisible", "setReadOnly", "setMandatory", "setSectionDisplay", "addOption", "removeOption", "clearOptions", "setLabelOf", "hideRelatedList", "showFieldMsg", "clearMessages", "addErrorMessage"];

		let frameworkPolls = 0;
		const frameworkTimer = setInterval(() => {
			frameworkPolls += 1;
			if (frameworkPolls > 240) {
				clearInterval(frameworkTimer);
				log("framework-adapter-missing", { polls: frameworkPolls, tried: "servicenow" });
				return;
			}

			// The global appears well after document-start, and on the login screen it never appears at
			// all — so this polls rather than assuming, exactly like the state lane.
			const gForm = window.g_form;
			if (!gForm || typeof gForm.setValue !== "function") {
				return;
			}

			clearInterval(frameworkTimer);

			let table = "";
			try {
				table = gForm.getTableName();
			} catch (e) {}
			log("framework-adapter", { adapter: "servicenow", polls: frameworkPolls, table, uniqueValue: (function () {
				try {
					return gForm.getUniqueValue();
				} catch (e) {
					return "";
				}
			})() });

			// Server-seeded state: for "the value is right but the widget is blank" bugs this is often the
			// whole answer, because it is what the client actually rendered from. Captured once — it does
			// not change after form load.
			try {
				if (window.g_scratchpad) {
					log("framework-scratchpad", { adapter: "servicenow", keys: Object.keys(window.g_scratchpad).join(","), value: trunc(JSON.stringify(window.g_scratchpad), 1200) });
				}
			} catch (e) {}

			GFORM_METHODS.forEach((name) => {
				const orig = gForm[name];
				if (typeof orig !== "function" || orig.__prooflineWrapped) {
					return;
				}
				const wrapped = function () {
					try {
						const args = Array.prototype.slice.call(arguments);
						log("framework-call", {
							adapter: "servicenow",
							method: name,
							args: trunc(args.map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(", "), 240),
							// The whole reason this lane exists: not that something changed, but which
							// script changed it. Frames 2-6 skip the wrapper itself and land on the caller.
							stack: trunc((new Error().stack || "").split("\n").slice(2, 7).join(" | "), 500)
						});
					} catch (e) {}
					return orig.apply(this, arguments);
				};
				wrapped.__prooflineWrapped = true;
				gForm[name] = wrapped;
			});

			log("framework-hooked", { adapter: "servicenow", methods: GFORM_METHODS.length });
		}, 250);
	}

	/* ==================================================================== dom lane */

	if (laneOn("dom")) {
		const attach = setInterval(() => {
			if (!document.body) {
				return;
			}
			clearInterval(attach);

			new MutationObserver((muts) => {
				for (const m of muts) {
					if (m.type === "childList") {
						m.addedNodes.forEach((n) => n.nodeType === 1 && log("dom-added", { tag: n.tagName, cls: trunc(String(n.className || ""), 80), text: trunc((n.textContent || "").trim(), 60) }));
						m.removedNodes.forEach((n) => n.nodeType === 1 && log("dom-removed", { tag: n.tagName, cls: trunc(String(n.className || ""), 80) }));
					} else if (m.type === "attributes") {
						log("dom-attr", { tag: m.target.tagName, id: m.target.id || "", attr: m.attributeName, val: trunc(String(m.target.getAttribute(m.attributeName)), 60) });
					}
				}
			}).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "hidden", "aria-hidden", "style", "disabled", "value"] });

			// A field going blank is a *value* change, and a value set through the property setter
			// fires no event and mutates no attribute — a MutationObserver cannot see it. Polling is
			// the only way to catch it, so the selected elements are sampled on a short interval.
			if (!DOM_SELECTOR) {
				return;
			}
			const lastValue = new Map();
			setInterval(() => {
				document.querySelectorAll(DOM_SELECTOR).forEach((el) => {
					const value = el.tagName === "SELECT" ? Array.prototype.map.call(el.options, (o) => o.value + (o.selected ? "*" : "")).join("|") : "value" in el ? el.value : (el.textContent || "").trim();
					const id = el.id || el.getAttribute("name") || el.getAttribute("data-testid") || el.tagName;
					if (lastValue.get(el) === value) {
						return;
					}
					const previous = lastValue.get(el);
					lastValue.set(el, value);
					log("value-changed", { el: id, from: previous === undefined ? "[first-seen]" : trunc(previous, 120), to: trunc(value, 120) });
				});
			}, 100);
		}, 100);
	}

	/* ------------------------------------------------------------------ lifecycle */

	setInterval(flush, FLUSH_MS);
	// The events immediately before a navigation are the ones worth having, so both hooks are used —
	// `beforeunload` does not fire reliably on mobile or on bfcache paths, `pagehide` does.
	window.addEventListener("pagehide", flush);
	window.addEventListener("beforeunload", flush);
})();
