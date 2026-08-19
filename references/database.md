# The database lane — audit triggers over a live dev database

Answers **what rows changed, and in what order?** — the backend sibling of `frontend-state`. Adapter:
`postgres-trigger` (the zero-footprint polling fallback at the end would be `postgres-polling`).

The backend counterpart to the browser lanes. Where the browser probe answers *"what did the UI
do?"*, this answers *"what did the rows actually go through, in what order, and from which
connection?"* — questions final-state inspection cannot answer, because the interesting transitions
(claim mutexes, compare-and-swap flips, counter increments) exist for under a millisecond.

**This lane is not armed by the CLI.** It is raw SQL, run through a database MCP (`dbhub`'s
`execute_sql`) or any psql access, and it is **DDL against a live database** — arm it only on a
development database, and only with the human's explicit agreement.

> Triggers are better than the browser's dispatch hook in one respect: they sit *in the write path*,
> so they have no blind spot equivalent to "dispatches made inside a thunk". Nothing writes without
> being seen.

## Arm

Replace `<schema>` and the watched tables. `<pk>` is whatever column identifies a row (`sys_id`,
`id`, …).

```sql
CREATE TABLE IF NOT EXISTS <schema>._dbg_audit (
	id          BIGSERIAL PRIMARY KEY,
	ts          timestamptz NOT NULL DEFAULT clock_timestamp(),
	txid        bigint      NOT NULL DEFAULT txid_current(),
	backend_pid int         NOT NULL DEFAULT pg_backend_pid(),
	table_name  text        NOT NULL,
	op          text        NOT NULL,
	row_id      text,
	old_row     jsonb,
	new_row     jsonb
);

CREATE OR REPLACE FUNCTION <schema>._dbg_audit_fn() RETURNS trigger AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		INSERT INTO <schema>._dbg_audit(table_name, op, row_id, old_row, new_row)
		VALUES (TG_TABLE_NAME, TG_OP, NEW.<pk>, NULL, to_jsonb(NEW));
		RETURN NEW;
	ELSIF TG_OP = 'UPDATE' THEN
		INSERT INTO <schema>._dbg_audit(table_name, op, row_id, old_row, new_row)
		VALUES (TG_TABLE_NAME, TG_OP, NEW.<pk>, to_jsonb(OLD), to_jsonb(NEW));
		RETURN NEW;
	ELSE
		INSERT INTO <schema>._dbg_audit(table_name, op, row_id, old_row, new_row)
		VALUES (TG_TABLE_NAME, TG_OP, OLD.<pk>, to_jsonb(OLD), NULL);
		RETURN OLD;
	END IF;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS _dbg_audit ON <schema>.<table>;
CREATE TRIGGER _dbg_audit AFTER INSERT OR DELETE OR UPDATE ON <schema>.<table>
	FOR EACH ROW EXECUTE FUNCTION <schema>._dbg_audit_fn();
```

Repeat the last two statements per watched table.

## What it catches

- **Every version of every row**, including states that exist between two consecutive statements.
- **`txid` correlation** — writes inside one transaction share a txid; autocommit statements each
  get their own. This is how you verify what is actually atomic together rather than assuming it.
- **`backend_pid` correlation** — which connection (which worker tick, which request) issued each
  write. Two completions racing on different PIDs against the same row *is* the race.

## What it misses

- **Reads.** Code that reads stale state and decides wrongly shows only its wrong write. Pair the
  audit with application logs for read-side reasoning.
- **Statements that matched zero rows** — deliberately. A no-op `UPDATE … WHERE state='waiting'`
  fires nothing, and that absence is itself the signal: the compare-and-swap lost.

## Read back

```sql
SELECT id, ts, txid, backend_pid, table_name, op, row_id,
	new_row->>'state' AS state
FROM <schema>._dbg_audit
ORDER BY id;
```

Diff a specific transition:

```sql
SELECT id, ts, txid, backend_pid,
	(SELECT jsonb_object_agg(key, jsonb_build_array(old_row->key, new_row->key))
	 FROM jsonb_each(new_row) WHERE new_row->key IS DISTINCT FROM old_row->key) AS changed
FROM <schema>._dbg_audit
WHERE op = 'UPDATE' AND row_id = '<id>'
ORDER BY id;
```

## Correlating with the browser lanes

The browser log is `ms since arm`; the audit is `clock_timestamp()`. To merge them, capture the
wall-clock arm epoch once, right after arming the browser probe:

```
browser_evaluate → () => Number(localStorage.__proofline_epoch)
```

Then `browser_t = EXTRACT(EPOCH FROM ts) * 1000 - epoch` puts both on the same axis, and a
`net-request` in the browser lines up with the rows its handler wrote.

## Reset between runs, and teardown

```sql
TRUNCATE <schema>._dbg_audit;                       -- reset, keep armed

DROP TRIGGER IF EXISTS _dbg_audit ON <schema>.<table>;   -- per table
DROP FUNCTION IF EXISTS <schema>._dbg_audit_fn();
DROP TABLE IF EXISTS <schema>._dbg_audit;
```

**Track every table you armed and drop every trigger.** A forgotten audit trigger writes a row for
every write forever and will outlive the session that installed it.

## Zero-footprint fallback

If DDL is not acceptable, poll a signature query on an interval and diff consecutive snapshots — the
backend analogue of `store.subscribe`. Signature per row = identity + state + version counter. It is
strictly worse: any state shorter than the poll interval is invisible, which is most of the
interesting ones. Good for coarse progress watching, not for race diagnosis.
