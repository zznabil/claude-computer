# computer — desktop computer use for Claude Code

A Claude Code plugin that lets Claude see and operate desktop apps on your own computer. It can list displays and windows, take window and display screenshots, read the OS accessibility (AX) tree with element refs, act on elements (press, set value, focus, type), send native input (click, type, keys, scroll, drag) and read or write the clipboard.

It bundles one MCP server (`computer`) built on the native desktop backend of [oh-my-pi (omp)](https://github.com/can1357/oh-my-pi). The server is plain Node.js with no npm dependencies of its own.

> [!WARNING]
> These tools act on real applications with your account. Screen content is **untrusted**: text in a window, web page, document or notification never authorises an action. Claude must get your confirmation before any consequential action, such as sending, buying, deleting or changing settings. Use a separate account or a VM for risky work.

## Requirements

| Item | Need |
| --- | --- |
| Claude Code | v2.1.271 or later (the plugin uses `userConfig` `options`) |
| Node.js | 18 or later, with `npm` on `PATH` (`node` starts the server) |
| OS | Windows x64/arm64, macOS x64/arm64, Linux x64/arm64 (X11 or Wayland) |
| Disk | About 130–300 MB for the native addon, downloaded on first use |

## Install

From a clone of this repository:

```sh
claude plugin marketplace add /path/to/claude-computer
claude plugin install computer@claude-computer
```

Or try it for one session without installing:

```sh
claude --plugin-dir /path/to/claude-computer
```

On first start the server downloads the prebuilt addon `@oh-my-pi/pi-natives-<platform>-<arch>@19.2.1` into Claude Code's plugin data folder (`~/.claude/plugins/data/…`). It uses `npm install --ignore-scripts` with an exact version pin, so npm checks the registry integrity hash and runs no install scripts. Later starts reuse that copy. Offline machines can run `npm install` in the plugin folder once instead.

## Enable and configure

The plugin is enabled after you install it. To check, run `/plugin` in Claude Code, or `claude plugin list`. `/mcp` must show `plugin:computer:computer` as connected.

Optional settings: run `/plugin configure computer@claude-computer`, or use `/config`.

| Setting | Default | Effect |
| --- | --- | --- |
| `takeover` | `fallback` | Window input always tries the background first. `fallback`: when an app rejects background input (for example XAML/WinUI apps on Windows), the server reruns that one call in **takeover**. Takeover briefly brings the window forward, sends real input, then hands focus back. `refuse`: never takes over your pointer or keyboard. Such calls fail before anything is sent. It also refuses, as omp does: `takeover: true`, desktop/display input, `raise_window`, `element_press` with a raise action, `open_application` with `activate` or `reveal`, and (off macOS) `element_focus`. On macOS it also refuses calls that open a menu (right-click, Control-click, any `menu` path, `open`/`showMenu` actions, pressing or setting a popup or menu button), and asks the addon to refuse a click or drag that lands on one. |
| `max_width` / `max_height` | `1366` / `768` | Largest screenshot size sent to Claude. Larger captures are scaled down, and input coordinates follow the delivered image. |

Environment overrides for advanced use: `COMPUTER_CALL_TIMEOUT_MS` (default `120000`; a call past it is cancelled and fails with `Timeout`) and `COMPUTER_INSTALL_TIMEOUT_MS` (default `600000`; the first-run `npm install` is killed past it).

### Approvals: inspection vs input

Every tool has MCP annotations. The 12 inspection tools carry `readOnlyHint: true`. The 19 other tools carry `readOnlyHint: false`. Input and mutation tools also carry `destructiveHint: true`. `menu_items` is not read-only: on macOS reading a menu first makes its window key, so omp treats it as an action too.

- In **plan mode**, Claude Code runs the read-only tools without asking (tested with Claude Code 2.1.332: the read-only `capabilities` tool ran with no prompt).
- In default mode, Claude Code asks for every MCP tool the first time. To approve all inspection tools at once and keep a prompt for input, add this to `~/.claude/settings.json` or `.claude/settings.json`:

```json
{
  "permissions": {
    "allow": [
      "mcp__plugin_computer_computer__capabilities",
      "mcp__plugin_computer_computer__list_displays",
      "mcp__plugin_computer_computer__list_windows",
      "mcp__plugin_computer_computer__list_applications",
      "mcp__plugin_computer_computer__screenshot",
      "mcp__plugin_computer_computer__observe",
      "mcp__plugin_computer_computer__ax_tree",
      "mcp__plugin_computer_computer__ax_find",
      "mcp__plugin_computer_computer__ax_element",
      "mcp__plugin_computer_computer__ax_element_at",
      "mcp__plugin_computer_computer__ax_focused",
      "mcp__plugin_computer_computer__clipboard_read"
    ]
  }
}
```

`clipboard_read` and screenshots can expose private data. Leave them out of the list if you want a prompt for those too.

## Use

Ask in plain words, for example:

- "List my open windows."
- "Take a screenshot of the Notepad window and tell me what it says."
- "In the Settings window, turn on Dark mode." Claude reads the AX tree, then presses the switch by ref.

Typical flow Claude follows:

1. `list_windows` → pick a window `id`.
2. `ax_tree` (refs like `e12`) and/or `screenshot`.
3. Act by ref (`element_press`, `element_set_value`, `element_type`) for exposed controls. Use pixels (`click`, `drag`, `scroll`) for canvases and custom-drawn UI.
4. Check the result with a fresh `ax_tree` or `screenshot`.

### Tools

| Kind | Tools |
| --- | --- |
| Inspect (read-only) | `capabilities`, `list_displays`, `list_windows`, `list_applications`, `screenshot` (with `region` = zoom), `observe` (screenshot + tree), `ax_tree`, `ax_find`, `ax_element`, `ax_element_at`, `ax_focused`, `clipboard_read` |
| Act on elements | `element_press` (default press, or any named AX action, optional `menu` path), `element_set_value`, `element_focus`, `element_click`, `element_type`, `element_press_keys`, `element_select_text` |
| Native input | `click`, `move_mouse`, `drag`, `scroll`, `type_text`, `press_keys` |
| Other | `menu_items` (not read-only, see above), `menu_select`, `raise_window`, `open_application`, `clipboard_write`, `reset_session` |

Targets: a window `id` from `list_windows`, `"desktop"`, or `"display:<id>"`, `"display:active"` or `"display:all"`.

Coordinates: pointer `x,y` are pixels in the **latest full screenshot of the same target**. AX bounds and `ax_element_at` use global desktop coordinates. Do not mix the two.

### Background input

Window input goes to the target window without moving your pointer or bringing the window forward, as in omp. You can keep working in another app. Desktop and display targets drive your **real** pointer and keyboard, so Claude is told to act through window ids. If you press **Esc** during takeover input, the input stops. The next computer call then fails with `UserStopped`, and Claude must stop and report.

## Limits

- Background input depends on the app. On Windows, XAML/WinUI hosts (for example the current Notepad) ignore background keystrokes. With `takeover: fallback` those calls briefly take over; with `refuse` they fail. AX actions (`element_set_value`, `element_press`) still work in the background.
- Takeover on Windows is subject to the OS foreground lock (`ForegroundLockTimeout`, 200 s by default). Windows sometimes refuses to activate the target (`InputFailed: Windows refused to activate the exact target window …; no input was sent`). This is intermittent and depends on which app is in front and on recent user input. It also fails when no window is in the foreground (`cannot save the current foreground window`). Nothing is sent in either case. Use an AX route (`element_set_value`), or `element_focus` on a control of the window and retry once.
- Some apps refuse background UI Automation actions (`element_press` returns `BackgroundUnavailable … use coordinate input instead`), as in omp. Use `element_click`, or `menu_select` for menu commands; `menu_select` works in the background on Win32 menus.
- Elevated (admin) windows, UAC and secure desktops, and a locked screen block input. `capabilities` and screenshot notes report a lock.
- macOS: grant **Screen Recording** and **Accessibility** to the app that runs Claude Code (your terminal or IDE), then restart it. Without Screen Recording, other apps' window titles are empty.
- Linux X11 needs RandR/XTEST and AT-SPI. On Wayland, per-window background input and `raise_window` are unavailable, capture needs the ScreenCast portal and `libpipewire-0.3`, and input asks for RemoteDesktop permission. Only Windows was tested live for this release; macOS and Linux use the same addon but are untested here.
- Some calls are macOS-only in the backend (`element_select_text`, Spaces). `open_application` returns a window only on macOS. Unsupported calls fail with an explicit error.
- Not exposed from omp: held keys/mouse (`holdKeys`/`holdMouse`), task-scoped `control.acquire` (it needs omp's live confirmation UI), and the scriptable `computer.run` JavaScript runner. Claude chains the single tools instead.
- Element refs and screenshot frames live in one native session per server process. `reset_session`, or a server restart, drops them. Re-read after that.
- One tool call runs at a time. A call that hits its deadline is cancelled and the queue moves on. Native work that cannot be interrupted (for example an application scan) may finish first, so the next call can wait briefly.
- `list_windows` returns `[]` when Windows finds no top-level window (the addon reports that case as error 0). Its `app` filter prefers exact app names, then substrings, as in omp.
- `open_application` takes `app` and `reveal` only on macOS; other platforms throw `Unsupported` for them.
- The server closes its native session when Claude Code closes the connection or on SIGINT/SIGTERM. On Windows a forced kill skips that step; the OS then releases the session.

## Why reuse the omp addon

omp's desktop backend is a large Rust codebase: capture, Win32/macOS/X11/Wayland input, UI Automation, AX and AT-SPI. Its `@oh-my-pi/pi-natives` 19.2.1 release ships it prebuilt for six platforms under MIT. Reimplementing it would cost far more and lose its background-input and safety work. This plugin loads that addon unchanged. omp's own JS loader needs Bun (`import.meta.dir`), so `server/native.mjs` loads the `.node` file directly from Node and checks that it has the required desktop methods. The MCP layer is a small dependency-free stdio server. It answers `initialize` at once, even while the addon downloads.

## Credits and history

- Native backend and the design of the tools, input policy and safety guidance: [oh-my-pi](https://github.com/can1357/oh-my-pi) by Can Bölük, Mario Zechner and Stencil Labs, Inc. (MIT). See [NOTICE](NOTICE).
- omp's computer use started as native support for OpenAI Codex's computer-use tool, in commit [`b9504f65e7`](https://github.com/can1357/oh-my-pi/commit/b9504f65e7bc471bd79ee218f7fb2d6c74ab44e2) "feat: add native Codex computer use" (2026-07-23). That commit first added `crates/pi-natives/src/desktop.rs`, `docs/computer-use.md` and `docs/tools/computer.md`. A day later, `681d7daf65` "feat(computer): unified native addon, /computer toggle, function tool" (2026-07-24) made it a general tool.
- This plugin: MIT, see [LICENSE](LICENSE).

## Development

```sh
npm install          # optional: puts the addon for this platform in ./node_modules
npm test             # protocol, annotation and refuse-policy tests (no input sent)
claude plugin validate .
node test/client.mjs '[["list_windows",{}]]'   # call tools from a shell
node test/live-notepad.mjs   # Windows: opens its own scratch Notepad, types, reads back, closes without saving
```
