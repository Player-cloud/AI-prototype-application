# 2026-11-13 click-through video (joshua, laptop)

- **When and who:** 13 Nov 2026, about 12:00 (UK). Recorded by joshua. Read by Claude from the video, frame by frame (one frame every 2 seconds, plus full-size frames where text was small).
- **Where:** a Windows laptop (user folder `C:\Users\Lapto`). The title bar says "AI Prototype", the rail says "Engine: running (v0.0.1)". The video does **not** show whether this was a `tauri dev` run or an installed copy, and it does not show which commit it was. The "Simple view" box is there, so it includes PR #79.
- **Source:** `/mnt/project-files/20261113-1200-16.4145106.mp4` in the project files (1920×1200, 76 seconds, 42 MB). Not committed to the repo. It has an audio track; I did not hear it.

## What the video shows

| Step from the baseline entry | Result | What was seen |
| --- | --- | --- |
| 1. Rail shows "Engine: running" | **passed** | "Engine: running (v0.0.1)" in every frame. |
| 2. Settings: saved key is still there | **passed** | "Claude (Anthropic): Key saved". Budget "Spent this month £0.10 ($0.13) of £20". |
| 2. Test connection works | **not run** | The button is on screen; it was not pressed. |
| 3. Projects: Club HR opens with plan and features | **passed** | Plan review (5 findings), code folder `C:\Users\Lapto\Downloads\test code` ("Ready on branch main"), tools for this project, Decisions and blockers, the seven plan tabs (The idea … What "done" means). F-01 login is listed. |
| 4. Build: builds list shows F-01 | **passed** | "F-01 · 12 Nov 2026, 09:50 · tests and checks pass · kept into main", Undo this kept build, "Ways of building compared". |
| 4. History opens | **partly** | The change history is at the bottom of Settings (Kept F-01, two code-folder changes, each with Undo). No separate History screen was opened. |
| 5. Tools opens | **passed** | "21 of 26 tools on", the computer check, each tool. |
| 5. Capability Centre opens without errors | **passed** | Filters (All 26, In use 21, On trial 1, Not tested 3, Retired 1) worked; the list showed real records. |
| 6. Build one feature, then Undo | **not run** | No build or Undo was started. |

Also seen: "Simple view" was ticked near the end (about 70 seconds) and unticked at the end. I could not see its effect in those frames, because the menu was scrolled out of view (see below).

## Problems seen

| ID | Problem | Where | Notes |
| --- | --- | --- | --- |
| V-1 | **The left menu disappears when a long page is scrolled.** Only "Engine: running" and "Simple view" stay; Projects, Build, Tools, Capability Centre and Settings are not visible until you scroll back to the top. | Projects, Capability Centre and Settings (long pages) | Seen in about 20 frames. It also hides the effect of "Simple view". Fix not made yet. |
| V-2 | The ask-first rule text says "needs joshua's OK" to every user. | Settings, "Ask-first rules" | Known. The words live in `packages/gatekeeper`, which only joshua edits. |
| V-3 | Capability Centre is one very long list (about 26 entries, each with 6 lines such as "Not rated" / "Not tested"). | Capability Centre | Hard to scan. Not an error. |
| V-4 | "Your name" and "Your email" are empty while a data folder is set. | Settings | Not wrong. They are needed only for "Create a new data folder here" (R3). |

## What this does not show

- That the **installed** app works. The video doesn't say how the app was started.
- Any paid action: Test connection, a build, Undo, phone messages, GitHub sync.
- The installer, signing, upgrade or uninstall.
- Sound: I did not transcribe the audio, so anything joshua said aloud is not recorded here.
- Accessibility, keyboard use or other screen sizes.

## Next

- joshua to say whether this was `tauri dev` or the CI installer, and which commit.
- V-1 gets its own PR if joshua says go.
