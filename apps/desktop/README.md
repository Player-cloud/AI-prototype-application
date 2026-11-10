# apps/desktop

The desktop app: a small Tauri (Rust) window around React screens. Runs on Windows and Linux.

## Run it

You need Node 22+, pnpm 10 and Rust (stable). On Windows, WebView2 is already part of Windows 10/11.
On Linux, first install: `libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libgtk-3-dev libdbus-1-dev build-essential`, and have a keyring running (GNOME Keyring or KWallet) for saving API keys.

```
pnpm install
pnpm typecheck                           # also builds the engine helper
pnpm --filter @aip/desktop tauri dev     # opens the window, reloads on change
pnpm --filter @aip/desktop tauri build   # makes the installer (.msi/.exe on Windows, .deb/.AppImage on Linux)
```

## Layout

- `src/` React screens. `screens.ts` lists the screens in rail order; Projects is the main screen.
- `src-tauri/` the Rust shell. Kept tiny: it opens the window and starts the engine helper.
- The engine helper is `packages/engine/dist/helper.js`, run with Node. It talks to the window with one JSON line per message over stdin/stdout, and stops when the window closes. Set `AIP_ENGINE` to a different helper.js path to override. The rail shows `Engine: running (vX)` when it is up.
- `src-tauri/capabilities/default.json` what the window may do. Only core features for now.

## API keys

Settings saves keys in the system's own password store (`src-tauri/src/keys.rs`): Credential Manager on Windows,
the Secret Service keyring on Linux. Keys are never written to a file or sent back to the screens. The screens can
only save, remove, or ask whether a key is saved. Each computer keeps its own copy.
