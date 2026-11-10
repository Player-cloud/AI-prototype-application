# apps/desktop

The desktop app: a small Tauri (Rust) window around React screens. Runs on Windows and Linux.

## Run it

You need Node 22+, pnpm 10 and Rust (stable). On Windows, WebView2 is already part of Windows 10/11.
On Linux, first install: `libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libgtk-3-dev build-essential`.

```
pnpm install
pnpm --filter @aip/desktop tauri dev     # opens the window, reloads on change
pnpm --filter @aip/desktop tauri build   # makes the installer (.msi/.exe on Windows, .deb/.AppImage on Linux)
```

## Layout

- `src/` React screens. `screens.ts` lists the screens in rail order; Projects is the main screen.
- `src-tauri/` the Rust shell. Kept tiny: it opens the window and (from step 3b) starts the engine helper.
- `src-tauri/capabilities/default.json` what the window may do. Only core features for now.
