// Tool catalogue and handlers. Behaviour follows oh-my-pi's `computer` Eval
// prelude (packages/coding-agent/src/tools/computer/worker.ts, MIT): window
// input runs in the background first; a call whose background route is
// unavailable is rerun once in takeover (setting "fallback") or refused
// (setting "refuse").

import { dataDir, HOST, SETTING_SOURCES, SETTINGS, SETTINGS_FILE, VERSION } from "./config.mjs";
import { loadNative } from "./native.mjs";

const TAKEOVER = SETTINGS.takeover;
const MAX_W = SETTINGS.max_width;
const MAX_H = SETTINGS.max_height;
const CALL_MS = SETTINGS.call_timeout_ms;
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

function refuse(call, effect, route = "Use a window target, an element action, or ask the user.") {
	throw new Error(
		`${BG}${call} would ${effect}; the plugin's takeover setting is "refuse", which keeps input in the background, so nothing was sent. ${route}`,
	);
}

// Refuse rules ported from omp worker.ts (refuseForeground / refuseMenu / refuseControlMenu /
// refusePointerMenu / refuseMenuPress). Menu rules apply on macOS only, as in omp.
const MENU_ROUTE = "Use menu_select on the window's menu bar, or an element action such as element_press, instead.";
const MENU_CONTROL_ROLES = ["AXPopUpButton", "AXMenuButton"];
const MENU_CONTROL_ROUTE =
	"Its options are chosen only through that menu: use menu_select if the menu bar has the same command, or tell the user the step needs their screen.";
const quartz = s => s.capabilities.backend === "quartz";

/** Under "refuse" on macOS, a call that opens a menu is refused: an open menu takes the user's keyboard. */
function refuseMenu(s, call, menu, route = MENU_ROUTE) {
	if (TAKEOVER !== "refuse" || !quartz(s)) return;
	refuse(call, `open ${menu}, which takes the user's keyboard while it is open`, route);
}

/** refuseMenu for an element call on a popup button or menu button. */
function refuseControlMenu(s, call, role) {
	if (MENU_CONTROL_ROLES.includes(role)) refuseMenu(s, `${call} on an ${role}`, "its menu", MENU_CONTROL_ROUTE);
}

/** refuseMenu for pointer input: right button, left with Control, a left press on a menu control, or a menu path. */
function refusePointerMenu(s, method, { button, modifiers, keys, menu }, role) {
	const pressed = typeof button === "string" ? button.trim().toLowerCase() : "left";
	const control = [modifiers, keys].some(
		list =>
			Array.isArray(list) &&
			list.some(e => typeof e === "string" && e.split("+").some(k => ["ctrl", "control"].includes(k.trim().toLowerCase()))),
	);
	if (pressed === "right") refuseMenu(s, `${method} with button: "right"`, "a context menu");
	else if (pressed === "left" && control) refuseMenu(s, `${method} with Control held`, "a context menu");
	else if (pressed === "left" && role !== undefined) refuseControlMenu(s, method, role);
	if (menu !== undefined) refuseMenu(s, `${method} with menu`, "a menu");
}

/** Under "refuse" on macOS, native refuses a click/drag that lands on a menu control (only native knows what a pixel hits). */
function refuseMenuPress(s, opts) {
	if (TAKEOVER === "refuse" && quartz(s)) opts.refuseMenu = true;
}

/** The element's native role, read only when a macOS refuse rule needs it. */
async function roleFor(s, ref) {
	return TAKEOVER === "refuse" && quartz(s) ? (await s.axNode(ref)).nativeRole : undefined;
}

/** omp's nativeActionKey: the action name lower-cased with an "ax" prefix, as macOS native resolves it. */
function actionKey(action) {
	const name = action.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").replace(/[A-Z]/g, c => c.toLowerCase());
	if (name === "show_menu") return "axshowmenu";
	return name.startsWith("ax") ? name : `ax${name}`;
}

/** omp's valueText: a number that cannot be written exactly as plain decimal text is refused. */
function valueText(value) {
	if (typeof value === "string") return value;
	const t = String(value);
	if (Number.isInteger(value) && !Number.isSafeInteger(value))
		throw new Error(
			`InvalidArguments: value ${t} is a whole number past 2^53 that a number cannot hold exactly; pass it as a decimal string such as "9007199254740993"; nothing was sent`,
		);
	if (/e/i.test(t))
		throw new Error(`InvalidArguments: value ${t} prints with an exponent; pass it as a decimal string such as "0.0000001"; nothing was sent`);
	return t;
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
				: /refused to activate the exact target window/.test(m)
					? " Windows' foreground lock refused this time (it is intermittent). Use an AX route (element_set_value), or element_focus on a control of this window (it moves keyboard focus there) and retry the call once."
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
		return [json({ ...s.capabilities, screenState: s.screenState, serverVersion: VERSION, takeoverSetting: TAKEOVER, escapeStops: s.escapeStops, host: HOST, dataDir: dataDir(), settings: SETTINGS, settingSources: SETTING_SOURCES, settingsFile: SETTINGS_FILE, platform: `${process.platform}-${process.arch}` })];
	}),
	tool("list_displays", "List displays", "Monitors with global logical geometry and pixel size.", obj({}), RO, async () => [json(await (await getSession()).listDisplays())]),
	tool(
		"list_windows",
		"List windows",
		"Capturable top-level windows: {id, app, title, pid, x, y, width, height, focused}. app prefers exact app names (case-insensitive) and falls back to substrings, as in omp; title is a case-insensitive substring. A failed title filter does not prove a window is absent.",
		obj({ app: str("App name (exact preferred, else substring)."), title: str("Title substring."), limit: int("Max results (default 100).") }),
		RO,
		async a => {
			const has = (v, q) => q === undefined || String(v ?? "").toLowerCase().includes(q.toLowerCase());
			let all;
			try {
				all = await (await getSession()).listWindows();
			} catch (error) {
				// Win32 addon quirk: an enumeration that finds no window reports failure with error 0.
				if (!/window enumeration query failed.*\(0x00000000\)/.test(error?.message ?? "")) throw error;
				all = [];
			}
			const exact = a.app === undefined ? [] : all.filter(w => String(w.app ?? "").toLowerCase() === a.app.toLowerCase());
			const byApp = exact.length ? exact : all.filter(w => has(w.app, a.app));
			return [json(byApp.filter(w => has(w.title, a.title)).slice(0, a.limit ?? 100))];
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
		"Native menu-bar items of a window; with path, that menu's items (depth-first, full paths). Not read-only: on macOS reading a menu first makes its window key in its app (omp classifies it as exec).",
		obj({ target: TARGET, path: strs('Menu path, e.g. ["File"].') }, ["target"]),
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
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
			refusePointerMenu(s, "click", o);
			refuseMenuPress(s, o);
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
			const o = pick(a, ["button", "modifiers", "keys", "takeover"]);
			refusePointerMenu(s, "drag", o);
			refuseMenuPress(s, o);
			return input(s, "drag", a.target, o, opts => s.drag(a.target, a.path, opts));
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
			const action = a.action ?? "press";
			if (!action.trim()) throw new Error("InvalidArguments: action must be non-empty; nothing was sent");
			const key = actionKey(action);
			const call = `element_press(${JSON.stringify(action)})`;
			if (TAKEOVER === "refuse") {
				if (key === "axraise")
					refuse(call, "bring the window's application to the front", "Background input reaches covered windows, so no raise is needed.");
				if (quartz(s)) {
					if (key === "axopen")
						refuse(call, "bring the window's application to the front, as it can on an Open panel item", "Use element_press on a button that does the same, or tell the user the step needs their screen.");
					if (key === "axshowmenu") refuseMenu(s, call, "a context menu");
					if (a.menu !== undefined) refuseMenu(s, `${call} with menu`, "a menu");
					if (key === "axpress") refuseControlMenu(s, call, await roleFor(s, a.ref));
				}
			}
			await s.axPerform(a.ref, action, a.menu);
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
			const value = valueText(a.value);
			// Native chooses a popup's option by opening its menu.
			const role = await roleFor(s, a.ref);
			if (role === "AXPopUpButton") refuseControlMenu(s, "element_set_value", role);
			await s.axSetValue(a.ref, value);
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
			const o = pick(a, ["button", "count", "modifiers", "menu", "takeover"]);
			refusePointerMenu(s, "element_click", o, await roleFor(s, a.ref));
			refuseMenuPress(s, o);
			return input(s, "element_click", "element", o, opts => s.axClick(a.ref, opts));
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
		"Launch an application by id/path/unique name from list_applications (behind the user's app unless activate). On macOS it also opens a file, folder or URL (in its default app, or app), or with reveal shows it selected in Finder, and returns the window; other platforms throw Unsupported for URLs, app and reveal.",
		obj(
			{
				id: str("Application id, path or exact name; on macOS also a file, folder or URL."),
				activate: bool("Bring it to the front (default false)."),
				app: str("macOS: application to open the item with."),
				reveal: bool("macOS: show the item selected in Finder, which comes to the front."),
			},
			["id"],
		),
		ACT,
		async a => {
			const s = await getSession();
			checkEscape(s);
			if (a.activate && TAKEOVER === "refuse") refuse("open_application with activate", "bring the app forward");
			if (a.reveal && TAKEOVER === "refuse") refuse("open_application with reveal", "bring Finder forward");
			return [json(await s.openApplication(a.id, pick(a, ["activate", "app", "reveal"])))];
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
		// A first-run install has its own timeout; the call deadline starts once the addon is loaded.
		native ??= (await loadNative(log)).native;
		activeRequest = requestId;
		let timer;
		const deadline = new Promise((_, reject) => {
			timer = setTimeout(() => {
				session?.cancel();
				reject(
					new Error(
						`Timeout: ${name} did not finish within ${CALL_MS} ms and was cancelled. Input may have been partly delivered: inspect the target before retrying.`,
					),
				);
			}, CALL_MS + Math.min(1000, Math.ceil(CALL_MS / 10)));
		});
		try {
			return { content: await Promise.race([entry.run(args), deadline]) };
		} finally {
			clearTimeout(timer);
			activeRequest = undefined;
		}
	};
	// One call at a time: screenshot frames and refs are per-session state.
	const result = queue.then(run, run);
	queue = result.catch(() => {});
	return result;
}

/** Cancel queued native work and close the session, bounded so shutdown never hangs. */
export async function shutdown(ms = 2000) {
	const s = session;
	session = undefined;
	if (!s) return;
	try {
		s.cancel();
		await Promise.race([s.close(), new Promise(r => setTimeout(r, ms).unref())]);
	} catch (error) {
		log(`session close failed: ${error?.message ?? error}`);
	}
}

export function cancelRequest(requestId) {
	if (session && requestId !== undefined && requestId === activeRequest) session.cancel();
}
