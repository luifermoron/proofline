# Security

## What this project asks you to enable

Arming the persistent probe requires the Playwright MCP tool **`browser_run_code_unsafe`**, which
executes code in the **MCP server's Node process** — not in the browser sandbox — with the invoking
user's full permissions.

That requirement is unavoidable, not an oversight. Persistence comes from
`page.context().addInitScript()`, a `BrowserContext` method that exists only in the server process.
No in-page API can register a script for the next page load; that would be a browser security hole.
So there is no way to survive a reload from `browser_evaluate` alone.

Playwright's own documentation states the tool should only be enabled for trusted MCP clients. It is
RCE-equivalent **by design** — running arbitrary code is its purpose, not a defect to be patched.
Related upstream reports:

- [microsoft/playwright-mcp#1495](https://github.com/microsoft/playwright-mcp/issues/1495) — code
  injection via Node's `vm` module.
- [microsoft/playwright-mcp#1651](https://github.com/microsoft/playwright-mcp/issues/1651) —
  arbitrary local file read via `page.goto('file:///…')` + `page.content()`.

## Threat model

The risk is **not** the user typing a command they intended. It is **prompt injection**: an agent
holding this tool that reads a hostile web page, issue comment, PR description or file can be
instructed by that text to execute code in the Node process, with the user's filesystem permissions
and access to every cookie and session in the browser context.

Assume that any agent with `browser_run_code_unsafe` enabled is one hostile input away from running
attacker-chosen code locally. Enable it deliberately, for the session where it is needed.

## How this project limits its own surface

- **The CLI prints; it never executes.** `skills/proofline/scripts/proofline.js` reads one local file, does string
  assembly, and writes to stdout. It opens no sockets, spawns no processes, and touches nothing
  outside the repository.
- **The emitted snippet is short, deterministic and reviewable.** Same input always yields the same
  output. It fetches nothing at runtime — the probe source is embedded inline, not downloaded. It
  can be read end to end in well under a minute, and the top of every snippet states which tool it
  targets and what process it runs in. **Reading it before pasting is the mitigation**, and it is
  the reason the CLI prints rather than runs.
- **Two calls total.** Only `arm` and `disarm` target the unsafe tool. `read` and `summary` emit
  `browser_evaluate` snippets, which run in the page sandbox with no elevated access.
- **A mode that needs none of it.** `proofline arm --no-persist` emits a `browser_evaluate` snippet.
  The log then dies on every reload, but the unsafe tool is never used.

## What the probe itself does, and what that means for your data

Once armed, the probe runs inside the page and:

- wraps `window.fetch`, `XMLHttpRequest.prototype.open`, `console.error`, `console.warn`, and
  `history.pushState` / `replaceState`;
- **captures response bodies of failed HTTP requests**, truncated to 600 characters;
- writes every event to `localStorage` under `__proofline_log`, where it persists until disarmed or
  cleared.

Consequences worth being explicit about:

- **Never arm production.** Development and test environments only.
- **Error payloads may contain sensitive data** — tokens, personal data, internal identifiers. They
  land in `localStorage` and in whatever transcript the agent produces. Clear the log afterwards
  (`proofline disarm`, which removes `__proofline_log` and `__proofline_epoch`).
- **Disarming is a required step, not a courtesy.** An armed probe stays armed across every tab of
  that browser context and will follow the user into unrelated work.
- **The database lane is DDL against a live database.** Triggers, on tables you choose. Development
  databases only, with explicit human agreement, and drop every trigger you created.

## Reporting a vulnerability

Email **contact@luifermoron.com** with a description and reproduction steps. Please do not open a
public issue for anything exploitable.

Vulnerabilities in `browser_run_code_unsafe` itself belong upstream, at
[microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp/issues).
