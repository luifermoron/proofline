# The framework lane

Answers **what was the framework told to do, and by whom?** — the one question the other lanes
structurally cannot reach. `dom` sees a field go blank; this sees the `setDisplay` call that blanked
it, and the stack of the script that made the call.

| Adapter | Status | Mechanism |
|---|---|---|
| `servicenow` | **experimental** | wraps `window.g_form` methods; dumps `g_scratchpad` |
| others | not implemented | any app exposing a global form/API object fits the same shape |

```bash
proofline arm browser framework          # aliases: servicenow, gform
```

> **Experimental.** The adapter is verified against a simulated `g_form` — it hooks, records the call
> with its stack, and calls through without changing behaviour — but not yet against a live
> ServiceNow instance. Expect the method list and the iframe handling to need adjusting on first
> real contact.

## What it records

| Event | Contents |
|---|---|
| `framework-adapter` | adapter name, table, record id, how many polls it took to appear |
| `framework-scratchpad` | `g_scratchpad` keys and value, captured once |
| `framework-call` | method, arguments, and the **caller's stack** |
| `framework-hooked` | confirmation, with the method count |
| `framework-adapter-missing` | no `g_form` after 60s — information, not an error |

Methods wrapped: `setValue`, `clearValue`, `setDisplay`, `setVisible`, `setReadOnly`, `setMandatory`,
`setSectionDisplay`, `addOption`, `removeOption`, `clearOptions`, `setLabelOf`, `hideRelatedList`,
`showFieldMsg`, `clearMessages`, `addErrorMessage`.

`setSectionDisplay` and `setDisplay` are the decisive ones for "this section/field disappeared".

## Why the stack matters more than the call

The shape of a real investigation: after a platform upgrade, a whole form section stopped rendering
on records created before it, while records created after looked fine. Exporting a broken record
against a working one showed **identical structure** — same columns, same schema, no difference
except one stored value, a field selecting which calculation method the record used (`1` for the old
one, `2` for the new). That gave a plausible theory and nothing more.

The lane turned the theory into a fact:

```
t=354323  framework-call  setDisplay("legacy_field_a", false)
t=354323  framework-call  setDisplay("legacy_field_b", false)
t=354323  framework-call  setDisplay("legacy_field_c", false)
t=354323  framework-call  setDisplay("legacy_field_d", false)
t=354323  framework-call  setDisplay("v2_field_a", true)
t=354323  framework-call  … five more v2_* fields set to true
t=402839  dom-attr        section-… class → state-closed
```

Four legacy fields hidden and six replacements shown **in the same millisecond**, which proved it was
one script execution rather than several independent UI Policies firing in sequence. The section
collapsing 48 seconds later was a consequence, not the cause: it closed because it had run out of
visible fields.

`g_scratchpad` came back empty, which ruled out server-calculated data and confirmed the decision was
made purely from the stored value.

None of that is visible to `dom` alone. `dom` reports the disappearance; only the wrapped call
reports the decision.

## Iframes

ServiceNow Classic renders forms inside an iframe, and `g_form` lives in **that** frame, not the top
one. The probe is registered on the browser context, so it runs in every same-origin frame and each
one hooks its own `g_form`. Events carry a `frame` field, and `get()` merges every frame's log, so a
single read from the top frame returns the whole picture.

If `framework-adapter-missing` appears on the top frame while the form clearly works, that is
expected — the useful events are coming from the child frame, under `frame: "f0"` or similar.

Cross-origin frames stay unreachable.

## Limits worth stating

- **Late hook.** The global does not exist at document-start, so the lane polls for it (250ms, up to
  60s). Calls made before it attaches are missed. In practice `g_form` appears well before the
  scripts that manipulate fields, but a very early call is a genuine blind spot.
- **Stacks are truncated** to five frames and 500 characters. Enough to name the calling script,
  rarely enough for a full trace — read the script itself once the name is known.
- **Wrapping is an intervention.** The wrapper calls through to the original with the original
  arguments and returns its result, but any code comparing `g_form.setValue` by identity will see a
  different function.
- **It records what was requested, not what happened.** `setDisplay(field, false)` in the log means
  the call was made; pair it with the `dom` lane to confirm the field actually went away.

## Adding another adapter

The shape generalises to any framework exposing a global: poll for the object, wrap the methods that
mutate state, log method + arguments + stack through `window.__proofline.log`, and report the adapter
name on every event. Keep the wrapper idempotent via the `__prooflineWrapped` marker, and let a
missing global be information rather than an error.
