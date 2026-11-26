// Tool catalogue and handlers. Behaviour follows oh-my-pi's `computer` Eval
// prelude (packages/coding-agent/src/tools/computer/worker.ts, MIT): window
// input runs in the background first; a call whose background route is
// unavailable is rerun once in takeover (setting "fallback") or refused
// (setting "refuse").

import { loadNative } from "./native.mjs";

const env = process.env;
const TAKEOVER = env.COMPUTER_TAKEOVER === "refuse" ? "refuse" : "fallback";
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const MAX_W = num(env.COMPUTER_MAX_WIDTH, 1366);
const MAX_H = num(env.COMPUTER_MAX_HEIGHT, 768);
const CALL_MS = num(env.COMPUTER_CALL_TIMEOUT_MS, 120000);
const BG = "BackgroundUnavailable: ";

// ---------- schema helpers ----------
const str = description => ({ type: "string", description });
const int = description => ({ type: "integer", description });
const numb = description => ({ type: "number", description });
const bool = description => ({ type: "boolean", description });
const strs = description => ({ type: "array", items: { type: "string" }, description });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });

const TARGET = str(
	'Window id from list_windows, "desktop", or "display:<id>" / "display:active" / "display:all". ' +
		"Prefer a window id: window input runs in the background; desktop/display input drives the user's real pointer and keyboard.",
);
const REF = str('Element ref from ax_tree/ax_find, e.g. "e12".');
const X = numb("x in pixels of the most recent FULL screenshot of the same target (not zoom pixels, not AX coordinates).");
const Y = numb("y in the same frame as x.");
const TAKEOVER_OPT = bool(
	"Omit (default): background first; the server decides any takeover. true: activate the window and post real input now. false: background only, never take over.",
);
const KEYS = { anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }], description: 'Key chord, e.g. "ctrl+s", "enter", "ctrl+shift+p", or ["ctrl","s"].' };
const POINTER = {
	button: str('"left" (default), "right" or "middle".'),
	count: int("Click count, e.g. 2 for a double click."),
	modifiers: strs('Modifier keys held during the click, e.g. ["shift"].'),
	menu: strs('Menu item path to choose in the menu this click opens, e.g. ["Add to", "Fonts"].'),
	takeover: TAKEOVER_OPT,
};

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ACT = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

function tool(name, title, description, inputSchema, annotations, run) {
	return { def: { name, title, description, inputSchema, annotations: { title, ...annotations } }, run };
}

// ---------- session ----------
let native;
let session;
let escapeSeen = 0;
let activeRequest;
let queue = Promise.resolve();
let log = () => {};

async function getSession() {
	native ??= (await loadNative(log)).native;
	if (!session) {
		session = new native.DesktopSession({});
		escapeSeen = session.escapeStops;
	}
	session.setRunDeadline(CALL_MS);
	return session;
}

const text = t => ({ type: "text", text: t });
const json = v => text(JSON.stringify(v, null, 1));
const isScreen = target => target === "desktop" || String(target).startsWith("display:");
const chord = keys => {
	const list = typeof keys === "string" ? keys.split("+").map(k => k.trim()).filter(Boolean) : keys;
	if (!Array.isArray(list) || list.length === 0) throw new Error('keys must be a chord such as "ctrl+s" or ["ctrl","s"]');
	return list;
};
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

function refuse(call, effect) {
	throw new Error(
		`${BG}${call} would ${effect}; the plugin's takeover setting is "refuse", which keeps input in the background, so nothing was sent. Use a window target, an element action, or ask the user.`,
	);
}

/** The user's physical Escape stops takeover input; refuse the next input call once so the agent stops and reports. */
function checkEscape(s) {
	const stops = s.escapeStops;
	if (stops > escapeSeen) {
		escapeSeen = stops;
		throw new Error(
			"UserStopped: the user pressed Escape to stop computer input. Nothing was sent. Stop using the computer, tell the user what you did and what remains, and continue only if they ask.",
		);
	}
}

/**
 * Send one input call: background first; on BackgroundUnavailable (raised only
 * before anything was sent) rerun once in takeover under "fallback".
 */
async function input(s, method, target, opts, send) {
	checkEscape(s);
	const screen = target !== "element" && isScreen(target);
	if (TAKEOVER === "refuse") {
		if (opts.takeover === true) refuse(`${method} with takeover: true`, "take the user's keyboard and pointer");
		if (screen) refuse(`${method} on ${target}`, "drive the user's real pointer and keyboard");
	}
	const notes = [];
	let result;
	try {
		result = await send(opts);
	} catch (error) {
		const msg = error?.message ?? String(error);
		if (!msg.startsWith(BG) || opts.takeover !== undefined) throw error;
		if (TAKEOVER === "refuse")
			throw new Error(`${msg}; the plugin's takeover setting is "refuse", so no takeover happened`);
		if (!s.capabilities.takeover) throw new Error(`${msg}; this backend has no takeover, so no takeover happened`);
		const why = msg.slice(BG.length).replace(/(?:;|,? so) (?:nothing|no input) was sent$/, "");
		try {
			result = await send({ ...opts, takeover: true, returnFocus: true });
		} catch (rerun) {
			const m = rerun?.message ?? String(rerun);
			const hint = /cannot save the current foreground window/.test(m)
				? " No window is in the foreground to hand focus back to. Use an AX route (element_set_value / element_press), or ask the user before raise_window on the target."
				: "";
			throw new Error(`${m} (${method} fell back to takeover because ${why}, and the takeover failed.${hint})`);
		}
		const focus = result?.focusReturn ?? result;
		const where =
			focus?.handedBack === true ? "focus was handed back to the app that was in front before"
			: focus?.previousPid !== undefined && focus.previousPid === focus.frontPid ? "the app in front before is still in front"
			: focus?.frontPid !== undefined ? `pid ${focus.frontPid} is now in front (before: pid ${focus.previousPid ?? "unknown"})`
			: "where focus ended was not confirmed";
		notes.push(`${method} ran in takeover because ${why}; ${where}`);
	}
	if (result?.unconfirmed) notes.push(`text was sent but not confirmed read: ${result.unconfirmed}`);
	const selection = result && "text" in result && "start" in result ? result : result?.selection;
	if (selection) notes.push(`selection: ${JSON.stringify(selection)}`);
	return [text([`${method}: sent`, ...notes].join("\n") + "\nVerify the effect with a fresh screenshot or ax_tree.")];
}

function imageContent(frame, label) {
	const scaled = frame.width !== frame.sourceWidth || frame.height !== frame.sourceHeight;
	const lines = [
		`${label} ${frame.target} ${frame.width}x${frame.height}${scaled ? ` (scaled from ${frame.sourceWidth}x${frame.sourceHeight})` : ""}; input coordinate frame ${frame.coordinateWidth}x${frame.coordinateHeight}`,
	];
	if (frame.region)
		lines.push(`zoom of region ${JSON.stringify(frame.region)}; keep using the full screenshot's coordinates for input, not zoom pixels`);
	if (frame.screenLocked) lines.push("screenLocked: the user session is locked/unavailable; this frame may be the lock screen or stale");
	if (frame.covered) lines.push("covered: the window was fully covered; the frame may be stale, do not verify changes from it");
	return [
		text(lines.join("\n")),
		{ type: "image", data: Buffer.from(frame.data).toString("base64"), mimeType: "image/png" },
	];
}

function treeContent(snap) {
	const lines = [snap.text || "(empty tree)"];
	lines.push(`nodes=${snap.nodeCount ?? "?"}${snap.truncated ? " (truncated: raise maxNodes/maxDepth or use ax_find)" : ""}`);
	if (snap.covered) lines.push("covered: the window was fully covered; the tree may be stale");
	return text(lines.join("\n"));
}

const caps = a => ({ maxWidth: a.maxWidth ?? MAX_W, maxHeight: a.maxHeight ?? MAX_H });
const axOpts = a => pick(a, ["maxDepth", "maxNodes", "all"]);
const CAPS_PROPS = { maxWidth: int(`Max delivered width (default ${MAX_W}).`), maxHeight: int(`Max delivered height (default ${MAX_H}).`) };
const AX_PROPS = {
	maxDepth: int("Maximum tree depth."),
	maxNodes: int("Maximum node count."),
	all: bool("Include nodes normally pruned as uninteresting."),
};

// ---------- catalogue ----------
const TOOLS = [
	// ----- inspection (read-only) -----
	tool("capabilities", "Computer capabilities", "Backend, permissions, display count, lock state, takeover setting and loaded addon.", obj({}), RO, async () => {
		const s = await getSession();
		return [json({ ...s.capabilities, screenState: s.screenState, takeoverSetting: TAKEOVER, escapeStops: s.escapeStops, platform: `${process.platform}-${process.arch}` })];
	}),
	tool("list_displays", "List displays", "Monitors with global logical geometry and pixel size.", obj({}), RO, async () => [json(await (await getSession()).listDisplays())]),
	tool(
		"list_windows",
		"List windows",
		"Capturable top-level windows: {id, app, title, pid, x, y, width, height, focused}. Filters are case-insensitive substrings. A failed title filter does not prove a window is absent.",
		obj({ app: str("App name substring."), title: str("Title substring."), limit: int("Max results (default 100).") }),
		RO,
		async a => {
			const has = (v, q) => q === undefined || String(v ?? "").toLowerCase().includes(q.toLowerCase());
			const all = await (await getSession()).listWindows();
			return [json(all.filter(w => has(w.app, a.app) && has(w.title, a.title)).slice(0, a.limit ?? 100))];
		},
	),
	tool(
		"list_applications",
		"List applications",
		"Installed/running applications with ids usable by open_application.",
		obj({ query: str("Name filter."), runningOnly: bool("Only running apps.") }),
		RO,
		async a => [json(await (await getSession()).listApplications(pick(a, ["query", "runningOnly"])))],
	),
	tool(
		"screenshot",
		"Screenshot",
		"Capture a window or display as PNG. Pointer x,y for input tools are pixels of the latest FULL screenshot of the same target. With region, returns a zoomed detail view that does not change that input frame.",
		obj({ target: TARGET, region: obj({ x: numb("x in the full screenshot frame"), y: numb("y"), width: numb("width"), height: numb("height") }, ["x", "y", "width", "height"]), ...CAPS_PROPS }, ["target"]),
		RO,
		async a => {
			const s = await getSession();
			const frame = a.region ? await s.captureRegion(a.target, a.region, caps(a)) : await s.capture(a.target, caps(a));
			return imageContent(frame, a.region ? "zoom" : "screenshot");
		},
	),
	tool(
		"ax_tree",
		"Accessibility tree",
		'OS accessibility tree of a window as text, one node per line: `- role "label" [ref=eN]: "value"` plus states. Refs stay valid across reads until the element\'s role/label changes; a ref missing from the last two reads throws StaleRef (re-read, never guess).',
		obj({ target: TARGET, ...AX_PROPS }, ["target"]),
		RO,
		async a => [treeContent(await (await getSession()).axSnapshot(a.target, axOpts(a)))],
	),
	tool(
		"observe",
		"Screenshot + accessibility tree",
		"Screenshot and AX tree of one target in one call.",
		obj({ target: TARGET, ...CAPS_PROPS, ...AX_PROPS }, ["target"]),
		RO,
		async a => {
			const o = await (await getSession()).observe(a.target, caps(a), axOpts(a));
			return [...imageContent(o.capture, "screenshot"), treeContent(o.accessibility)];
		},
	),
	tool(
		"ax_find",
		"Find elements",
		"Query a window's AX tree by role/title/value; returns element records with refs and global desktop bounds.",
		obj({ target: TARGET, role: str("Role, e.g. button, textfield."), title: str("Label."), value: str("Value."), limit: int("Max results.") }, ["target"]),
		RO,
		async a => [json(await (await getSession()).axQuery(a.target, pick(a, ["role", "title", "value", "limit"])))],
	),
	tool(
		"ax_element",
		"Inspect element",
		"Read one element by ref: role, title, value (full), bounds, actions; optionally its attributes, children and parent.",
		obj({ ref: REF, attributes: bool("Include raw attributes."), children: bool("Include children."), parent: bool("Include parent.") }, ["ref"]),
		RO,
		async a => {
			const s = await getSession();
			const out = { node: await s.axNode(a.ref) };
			if (a.attributes) out.attributes = await s.axAttributes(a.ref);
			if (a.children) out.children = await s.axChildren(a.ref);
			if (a.parent) out.parent = await s.axParent(a.ref);
			return [json(out)];
		},
	),
	tool(
		"ax_element_at",
		"Element at point",
		"Accessibility hit-test at GLOBAL logical desktop coordinates (as in ax_find bounds / list_windows, not screenshot pixels).",
		obj({ x: numb("Global x."), y: numb("Global y."), target: str('Optional window id scope (default "desktop").') }, ["x", "y"]),
		RO,
		async a => [json(await (await getSession()).axElementAt(a.target ?? "desktop", a.x, a.y))],
	),
	tool("ax_focused", "Focused element", "The element holding keyboard focus, or null.", obj({}), RO, async () => [json(await (await getSession()).axFocused())]),
	tool(
		"menu_items",
		"List menu items",
		"Native menu-bar items of a window; with path, that menu's items (depth-first, full paths).",
		obj({ target: TARGET, path: strs('Menu path, e.g. ["File"].') }, ["target"]),
		RO,
		async a => [json(await (await getSession()).menuItems(a.target, a.path))],
	),
	tool(
		"clipboard_read",
		"Read clipboard",
		"Read clipboard text; with image: true, the clipboard image as PNG instead.",
		obj({ image: bool("Read an image instead of text.") }),
		RO,
		async a => {
			native ??= (await loadNative(log)).native;
			if (a.image) {
				const img = await native.readImageFromClipboard();
				return img ? [{ type: "image", data: Buffer.from(img.data).toString("base64"), mimeType: img.mimeType }] : [text("(no image on clipboard)")];
			}
			const t = await native.readTextFromClipboard();
			return [text(t ?? "(no text on clipboard)")];
		},
	),

	// ----- input and mutation -----
	tool(
		"click",
		"Click",
		"Click at screenshot pixels in a target window (background by default, without moving the user's pointer).",
		obj({ target: TARGET, x: X, y: Y, ...POINTER }, ["target", "x", "y"]),
		ACT,
		async a => {
			const s = await getSession();
			const o = pick(a, ["button", "count", "modifiers", "menu", "takeover"]);
			return input(s, "click", a.target, o, opts => s.click(a.target, a.x, a.y, opts));
		},
	),
	tool(
		"move_mouse",
		"Move pointer",
		"Move the pointer to screenshot pixels in a target (background moves give no hover).",
		obj({ target: TARGET, x: X, y: Y, takeover: TAKEOVER_OPT }, ["target", "x", "y"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "move_mouse", a.target, pick(a, ["takeover"]), opts => s.moveMouse(a.target, a.x, a.y, opts));
		},
	),
	tool(
		"drag",
		"Drag",
		"Drag along a path of screenshot pixels, optionally holding keys/modifiers.",
		obj(
			{
				target: TARGET,
				path: { type: "array", minItems: 2, items: obj({ x: numb("x"), y: numb("y") }, ["x", "y"]), description: "Points from start to end." },
				button: POINTER.button,
				modifiers: POINTER.modifiers,
				keys: strs("Keys held for the whole drag, e.g. [\"space\"]."),
				takeover: TAKEOVER_OPT,
			},
			["target", "path"],
		),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "drag", a.target, pick(a, ["button", "modifiers", "keys", "takeover"]), opts => s.drag(a.target, a.path, opts));
		},
	),
	tool(
		"scroll",
		"Scroll",
		"Scroll at screenshot pixels. Positive dy scrolls down, positive dx right (wheel detents).",
		obj({ target: TARGET, x: X, y: Y, dx: numb("Horizontal amount (default 0)."), dy: numb("Vertical amount (default 0)."), takeover: TAKEOVER_OPT }, ["target", "x", "y"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "scroll", a.target, pick(a, ["takeover"]), opts => s.scroll(a.target, a.x, a.y, a.dx ?? 0, a.dy ?? 0, opts));
		},
	),
	tool(
		"type_text",
		"Type text",
		"Type text into the target window's focused control. To type into a known field prefer element_type or element_set_value.",
		obj({ target: TARGET, text: str("Text to type."), takeover: TAKEOVER_OPT }, ["target", "text"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "type_text", a.target, pick(a, ["takeover"]), opts => s.typeText(a.target, a.text, opts));
		},
	),
	tool(
		"press_keys",
		"Press keys",
		"Press a key chord in the target window.",
		obj({ target: TARGET, keys: KEYS, takeover: TAKEOVER_OPT }, ["target", "keys"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "press_keys", a.target, pick(a, ["takeover"]), opts => s.keyChord(a.target, chord(a.keys), opts));
		},
	),
	tool(
		"element_press",
		"Press element",
		'Perform an accessibility action on an element: default "press"; others from ax_element actions (e.g. "showMenu", "increment"). With menu, choose that item path in the menu the action opens. If it returns BackgroundUnavailable, use element_click (coordinate input) instead.',
		obj({ ref: REF, action: str('Action name (default "press").'), menu: strs("Menu item path to choose.") }, ["ref"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			await s.axPerform(a.ref, a.action ?? "press", a.menu);
			return [text(`${a.action ?? "press"} performed on ${a.ref}; verify with a fresh read`)];
		},
	),
	tool(
		"element_set_value",
		"Set element value",
		"Set an element's value through accessibility (text fields, sliders, pickers) without keystrokes.",
		obj({ ref: REF, value: { type: ["string", "number"], description: "New value." } }, ["ref", "value"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			await s.axSetValue(a.ref, String(a.value));
			return [text(`value set on ${a.ref}; verify with ax_element`)];
		},
	),
	tool(
		"element_focus",
		"Focus element",
		"Give an element keyboard focus. Off macOS this can bring its window forward.",
		obj({ ref: REF }, ["ref"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			if (TAKEOVER === "refuse" && process.platform !== "darwin") refuse("element_focus", "bring the element's window forward");
			await s.axFocus(a.ref);
			return [text(`focused ${a.ref}`)];
		},
	),
	tool(
		"element_click",
		"Click element",
		"Click the centre of an element by ref (no screenshot needed).",
		obj({ ref: REF, ...POINTER }, ["ref"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "element_click", "element", pick(a, ["button", "count", "modifiers", "menu", "takeover"]), opts => s.axClick(a.ref, opts));
		},
	),
	tool(
		"element_type",
		"Type into element",
		"Type text into an element: native text fields take it by AX insertion, others as keystrokes once focused.",
		obj({ ref: REF, text: str("Text to type."), takeover: TAKEOVER_OPT }, ["ref", "text"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "element_type", "element", pick(a, ["takeover"]), opts => s.axType(a.ref, a.text, opts));
		},
	),
	tool(
		"element_press_keys",
		"Press keys in element",
		"Press a key chord in an element once it holds keyboard focus.",
		obj({ ref: REF, keys: KEYS, takeover: TAKEOVER_OPT }, ["ref", "keys"]),
		ACT,
		async a => {
			const s = await getSession();
			return input(s, "element_press_keys", "element", pick(a, ["takeover"]), opts => s.axKeyChord(a.ref, chord(a.keys), opts));
		},
	),
	tool(
		"element_select_text",
		"Select text in element",
		"Select text inside an element's value (or place a caret) without focus change or keystrokes; returns the selection read back. macOS backend.",
		obj({ ref: REF, text: str("Text to select."), prefix: str("Text directly before."), suffix: str("Text directly after."), select: str('"text" (default), "start" or "end".') }, ["ref", "text"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			return [json(await s.axSelectText(a.ref, a.text, pick(a, ["prefix", "suffix", "select"])))];
		},
	),
	tool(
		"menu_select",
		"Select menu command",
		'Select an enabled, unambiguous native menu command, e.g. ["File", "Export…"]. Missing/disabled/ambiguous paths fail.',
		obj({ target: TARGET, path: strs("Menu path.") }, ["target", "path"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			await s.menuSelect(a.target, a.path);
			return [text(`selected ${a.path.join(" > ")}`)];
		},
	),
	tool(
		"raise_window",
		"Raise window",
		"Bring a window to the front. It takes the user's keyboard; never use it just to make input work (background input reaches covered windows).",
		obj({ id: str("Window id.") }, ["id"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			if (TAKEOVER === "refuse") refuse("raise_window", "bring the window forward and take the user's keyboard");
			await s.raiseWindow(a.id);
			return [text(`raised ${a.id}`)];
		},
	),
	tool(
		"open_application",
		"Open application",
		"Launch an application by id/path/unique name from list_applications (behind the user's app unless activate). macOS returns its window.",
		obj({ id: str("Application id, path or exact name."), activate: bool("Bring it to the front (default false).") }, ["id"]),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			if (a.activate && TAKEOVER === "refuse") refuse("open_application with activate", "bring the app forward");
			return [json(await s.openApplication(a.id, pick(a, ["activate"])))];
		},
	),
	tool(
		"clipboard_write",
		"Write clipboard",
		"Replace the clipboard with text.",
		obj({ text: str("Text to copy.") }, ["text"]),
		ACT,
		async a => {
			native ??= (await loadNative(log)).native;
			native.copyToClipboard(a.text);
			return [text(`copied ${a.text.length} characters`)];
		},
	),
	tool(
		"reset_session",
		"Reset session",
		"Close the native desktop session: drops screenshot frames and element refs. The next call opens a new one.",
		obj({}),
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		async () => {
			const s = session;
			session = undefined;
			if (s) await s.close();
			return [text("session closed")];
		},
	),
];

// ---------- validation ----------
function typeOk(schema, v) {
	if (schema.anyOf) return schema.anyOf.some(s => typeOk(s, v));
	const types = [].concat(schema.type ?? []);
	if (types.length === 0) return true;
	return types.some(t =>
		t === "string" ? typeof v === "string"
		: t === "number" ? typeof v === "number" && Number.isFinite(v)
		: t === "integer" ? Number.isInteger(v)
		: t === "boolean" ? typeof v === "boolean"
		: t === "array" ? Array.isArray(v) && v.every(i => !schema.items || typeOk(schema.items, i)) && v.length >= (schema.minItems ?? 0)
		: t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) && validate(schema, v, true)
		: false,
	);
}

function validate(schema, args, quiet = false) {
	const problems = [];
	for (const key of schema.required ?? []) if (args[key] === undefined) problems.push(`missing required "${key}"`);
	for (const [key, value] of Object.entries(args)) {
		const prop = schema.properties?.[key];
		if (!prop) problems.push(`unknown option "${key}"`);
		else if (value !== undefined && !typeOk(prop, value)) problems.push(`"${key}" has the wrong type`);
	}
	if (quiet) return problems.length === 0;
	if (problems.length) throw new Error(`InvalidArguments: ${problems.join("; ")}; nothing was sent`);
	return true;
}

export const toolDefs = TOOLS.map(t => t.def);

export function setLogger(fn) {
	log = fn;
}

export function callTool(name, args, { requestId }) {
	const entry = TOOLS.find(t => t.def.name === name);
	const run = async () => {
		validate(entry.def.inputSchema, args);
		activeRequest = requestId;
		try {
			return { content: await entry.run(args) };
		} finally {
			activeRequest = undefined;
		}
	};
	// One call at a time: screenshot frames and refs are per-session state.
	const result = queue.then(run, run);
	queue = result.catch(() => {});
	return result;
}

export function cancelRequest(requestId) {
	if (session && requestId !== undefined && requestId === activeRequest) session.cancel();
}
