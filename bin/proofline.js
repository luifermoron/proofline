#!/usr/bin/env node
/**
 * proofline — emit the Playwright MCP snippets that arm, read and disarm the runtime probe.
 *
 * One clock. Every layer. Follow the proof: find the bug or understand how it works.
 *
 * The Playwright MCP `browser_run_code_unsafe` sandbox has no `require` and no filesystem access,
 * and its `path` argument fails with "__fn__ is not a function". The probe source therefore has to
 * reach the browser as inline code. This CLI does that assembly on the machine side: it reads
 * `scripts/probe.js`, bakes in the lane configuration, and prints a self-contained snippet to paste
 * as the tool's `code` argument.
 *
 * Usage:
 *   proofline arm [lanes...] [options]   lanes: browser frontend-state dom all
 *                                     (aliases: react, redux, state → frontend-state)
 *                                     default: browser frontend-state
 *   proofline read [filter]              filter: regex over event type, e.g. "net-|store-"
 *   proofline disarm
 *   proofline summary
 *
 * Options for `arm`:
 *   --selector=<css>   elements the dom lane samples for value changes
 *   --slices=a,b,c     state slices to snapshot in full (default: every slice, shallow)
 *   --max=<n>          retained events (default 4000)
 *   --keep             keep the existing log and epoch instead of starting a fresh run
 *   --no-persist       install into the page only, via browser_evaluate — no unsafe tool needed,
 *                      but the log does not survive reloads. Degraded mode, not an equivalent one.
 *
 * Nothing here executes anything: every command prints a snippet to stdout. `arm` and `disarm`
 * target browser_run_code_unsafe, which runs in the MCP server's Node process with your full
 * permissions — so the snippet is deliberately short, deterministic and free of network fetches.
 * Read it before pasting; that review is the mitigation.
 *
 * @author Luis Morón <contact@luifermoron.com>
 */

"use strict";

const fs = require("fs");
const path = require("path");

const VALID_LANES = ["browser", "frontend-state", "dom", "all"];
// Lanes are named after the question they answer, not the library that answers it. Humans still say
// "react", so it is accepted as input and resolved to the lane it means.
const LANE_ALIASES = { react: "frontend-state", redux: "frontend-state", state: "frontend-state" };
const PROBE_PATH = path.join(__dirname, "..", "scripts", "probe.js");

function readProbeSource() {
	if (!fs.existsSync(PROBE_PATH)) {
		console.error("proofline: cannot find " + PROBE_PATH);
		process.exit(1);
	}
	return fs.readFileSync(PROBE_PATH, "utf8");
}

function parseOptions(argv, command) {
	const options = { lanes: [], selector: "", slices: "", max: "", keep: false, noPersist: false, filter: "" };
	argv.forEach((arg) => {
		if (arg.indexOf("--selector=") === 0) {
			options.selector = arg.slice(11);
		} else if (arg.indexOf("--slices=") === 0) {
			options.slices = arg.slice(9);
		} else if (arg.indexOf("--max=") === 0) {
			options.max = arg.slice(6);
		} else if (arg === "--keep") {
			options.keep = true;
		} else if (arg === "--no-persist") {
			options.noPersist = true;
		} else if (arg.indexOf("--") === 0) {
			console.error("proofline: unknown option " + arg);
			process.exit(1);
		} else if (command === "arm" && (VALID_LANES.indexOf(arg) !== -1 || LANE_ALIASES[arg])) {
			options.lanes.push(LANE_ALIASES[arg] || arg);
		} else {
			options.filter = arg;
		}
	});
	return options;
}

function indent(text) {
	return text
		.split("\n")
		.map((line) => (line.length ? "\t" + line : line))
		.join("\n");
}

function buildArmSnippet(options) {
	const lanes = options.lanes.length ? options.lanes : ["browser", "frontend-state"];
	const source = readProbeSource();

	// The configuration prelude is prepended to the init script rather than written once from the
	// machine side, so it is re-applied on every load. A page that clears its own storage on logout
	// would otherwise silently drop the probe back to defaults mid-session.
	const prelude = [
		"try {",
		"\tlocalStorage.setItem('__proofline_lanes', " + JSON.stringify(lanes.join(",")) + ");",
		options.selector ? "\tlocalStorage.setItem('__proofline_dom_selector', " + JSON.stringify(options.selector) + ");" : "",
		options.slices ? "\tlocalStorage.setItem('__proofline_slices', " + JSON.stringify(options.slices) + ");" : "",
		options.max ? "\tlocalStorage.setItem('__proofline_max', " + JSON.stringify(options.max) + ");" : "",
		"\tlocalStorage.removeItem('__proofline_off');",
		"} catch (e) {}"
	]
		.filter(Boolean)
		.join("\n");

	const initScript = prelude + "\n" + source;

	// --no-persist: the probe is installed straight into the page's own JS context, so it needs
	// `browser_evaluate` rather than `browser_run_code_unsafe`. Everything works except the thing
	// the project exists for — the log dies on every reload, route change and login, and the human
	// has to re-arm by hand each time. Offered because some teams cannot enable the unsafe tool at
	// all, not because it is an equivalent mode.
	if (options.noPersist) {
		return ["// NO-PERSIST MODE — paste into browser_evaluate, not browser_run_code_unsafe.", "// The log will NOT survive reloads, route changes or login. Re-arm after each navigation.", "() => {", "\ttry {", "\t\tlocalStorage.removeItem('__proofline_log');", "\t\tlocalStorage.removeItem('__proofline_epoch');", "\t} catch (e) {}", "", indent(initScript), "", "\treturn {", "\t\tinstalled: !!window.__proofline,", "\t\tlanes: window.__proofline ? window.__proofline.lanes : null,", "\t\tpersistent: false,", "\t\turl: location.href", "\t};", "}"].join("\n");
	}

	// `addInitScript` is registered on the *context*, not the page: that is what makes the probe
	// survive reloads, SPA route changes, full URL changes and newly opened tabs. It must be given
	// `{ content }` and never `{ path }` — path snapshots the file at registration time and silently
	// ignores later edits, which produces the worst possible failure mode: an old probe that looks armed.
	return [
		"// Runs in the MCP server's Node process with your permissions (browser_run_code_unsafe).",
		"// Short, deterministic, fetches nothing — read it before pasting.",
		"async (page) => {",
		"\tconst SRC = " + JSON.stringify(initScript) + ";",
		"",
		options.keep
			? "\t// --keep: existing log and epoch retained, new events append to the current run."
			: [
					"\t// A previous run's keys survive in localStorage, and reusing its epoch would stamp",
					"\t// new events as offsets from a session that happened days ago. Start clean.",
					"\tawait page.evaluate(() => {",
					"\t\ttry {",
					"\t\t\tlocalStorage.removeItem('__proofline_log');",
					"\t\t\tlocalStorage.removeItem('__proofline_epoch');",
					"\t\t} catch (e) {}",
					"\t});"
			  ].join("\n"),
		"",
		"\tawait page.context().addInitScript({ content: SRC });",
		"",
		"\t// addInitScript only affects *future* loads, so the already-open page is armed by hand.",
		"\t// Without this the probe appears dead until the human happens to reload.",
		"\tlet inlineNote = 'armed-inline';",
		"\ttry {",
		"\t\tawait page.evaluate(SRC);",
		"\t} catch (e) {",
		"\t\tinlineNote = 'inline-failed: ' + String(e.message).slice(0, 120);",
		"\t}",
		"",
		"\tawait page.waitForTimeout(2000);",
		"",
		"\tconst state = await page.evaluate(() => ({",
		"\t\tinstalled: !!window.__proofline,",
		"\t\tlanes: window.__proofline ? window.__proofline.lanes : null,",
		"\t\tstateAdapter: window.__store ? 'redux' : null,",
		"\t\tevents: window.__proofline ? window.__proofline.get().length : 0,",
		"\t\turl: location.href",
		"\t}));",
		"",
		"\tstate.inlineNote = inlineNote;",
		"\treturn state;",
		"}"
	].join("\n");
}

function buildReadSnippet(filter) {
	return "() => window.__proofline ? window.__proofline.get(" + (filter ? JSON.stringify(filter) : "") + ") : 'NOT ARMED'";
}

function buildSummarySnippet() {
	return "() => window.__proofline ? window.__proofline.summary() : 'NOT ARMED'";
}

function buildDisarmSnippet() {
	// The kill switch is a storage flag rather than an unhook: the probe wraps fetch, console and
	// history, and unwrapping them safely is impossible once other code has wrapped them in turn.
	// The flag makes the next load a no-op, which is the only clean stop.
	return ["// Runs in the MCP server's Node process (browser_run_code_unsafe). Read before pasting.", "async (page) => {", "\tawait page.evaluate(() => {", "\t\ttry {", "\t\t\tlocalStorage.setItem('__proofline_off', '1');", "\t\t\tlocalStorage.removeItem('__proofline_log');", "\t\t\tlocalStorage.removeItem('__proofline_epoch');", "\t\t} catch (e) {}", "\t});", "\tawait page.reload();", "\treturn await page.evaluate(() => ({ disarmed: !window.__proofline }));", "}"].join("\n");
}

function printUsage() {
	console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("\n").slice(1).join("\n"));
}

function main() {
	const argv = process.argv.slice(2);
	const command = argv[0];
	const options = parseOptions(argv.slice(1), command);

	if (command === "arm") {
		console.log(buildArmSnippet(options));
	} else if (command === "read") {
		console.log(buildReadSnippet(options.filter));
	} else if (command === "summary") {
		console.log(buildSummarySnippet());
	} else if (command === "disarm") {
		console.log(buildDisarmSnippet());
	} else {
		printUsage();
		process.exit(command ? 1 : 0);
	}
}

main();
