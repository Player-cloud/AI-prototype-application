# apps/desktop

The desktop app: a small Tauri (Rust) window around React screens. Runs on Windows and Linux.

## Run it

You need Node 22+, pnpm 10 and Rust (stable). On Windows, WebView2 is already part of Windows 10/11. If the build fails with "An Application Control policy has blocked this file (os error 4551)", Windows Smart App Control is blocking Rust's build steps; it has to be off to build on that PC.
On Linux, first install: `libwebkit2gtk-4.1-dev libsoup-3.0-dev librsvg2-dev libgtk-3-dev libdbus-1-dev build-essential`, and have a keyring running (GNOME Keyring or KWallet) for saving API keys.

After every `git pull`, run `pnpm install` first: a new step may add packages.

```
pnpm install
pnpm --filter @aip/desktop tauri dev     # rebuilds the engine helper, opens the window, reloads on change
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

## Talking to Claude

Settings → Claude → **Test connection** asks Haiku one tiny question with your saved key and shows the reply and cost
in £ and $. The key goes from the password store to the engine for that one call. The engine runs Claude through the
Claude Agent SDK with no tools, no PC Claude settings, and its own config folder, and passes only a short list of safe
environment variables, so it can never use another Claude login on the PC.

## OpenAI and DeepSeek

Both use the same "chat completions" web API, so one adapter in `packages/models` serves both (plain `fetch`, no
extra packages). **Test connection** for these two only asks for the provider's model list, which is free; it does
not run a model. Model names per job (`gpt-5` / `gpt-5-mini`, `deepseek-reasoner` / `deepseek-chat`) are starting
defaults, not checked against the providers' docs. Change them in Settings → Budget and models. Until a model's
price is set there, its costs show as "cost unknown".

## Budget and models

Settings → **Budget and models** holds the provider for the app's jobs, the monthly budget in £ (shown in $ too),
the £ per $ rate, the strong and everyday models for OpenAI and DeepSeek, and their prices in $ per million tokens.
Claude's models follow the fixed per-job rule. These are saved in `settings.json` in the app's config folder on
each computer (no keys in it). The engine checks every value, so a bad number gets a plain message instead of being
saved. The budget is only stored for now; stopping before going over it needs spending records (build step 5).
