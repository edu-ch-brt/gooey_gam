# GAM Classroom GUI

Windows desktop app (Tauri 2 + Vite + TypeScript) that wraps local [GAM](https://github.com/GAM-team/GAM) for Google Classroom course admin.

**Project path (Spock):** `C:\dev\gam_classroom_gui`

## Requirements

- Node.js LTS + npm
- Rust stable (`rustc` / `cargo`)
- Visual Studio 2022 Build Tools with C++ workload (MSVC)
- WebView2 Runtime (usually present on Windows 11)
- Local GAM 7 (`C:\GAM7\gam.exe` by default)

## Run (dev)

```powershell
cd C:\dev\gam_classroom_gui
npm install
npm run tauri dev
```

## Build

```powershell
npm run tauri build
```

## Tests

```powershell
cd src-tauri
cargo test
```

## Settings

Open **Settings** in the app and set the path to `gam.exe` if it is not `C:\GAM7\gam.exe`.

## Docs

- Design: `docs/superpowers/specs/2026-09-10-gam-classroom-gui-design.md`
- Plan: `docs/superpowers/plans/2026-09-10-gam-classroom-gui.md`

## Active courses: recent filter

Classroom/GAM does **not** expose true last-accessed time per course. This app uses Classroom **`updateTime`** (course last updated) as a proxy — **not** last student access.

- **Active** view default: only courses with `updateTime` on/after today minus 2 years.
- Toolbar checkbox **Show all active courses** (unchecked by default) reloads without the time filter. Preference is stored in `%APPDATA%\gam_classroom_gui\settings.json`.
- **Archived** view always loads the full archived list (no 2-year filter).

Probe on Spock (2026-09-10, `timefilter updatetime start 2024-09-10`):

| Mode | GAM “Got N Courses” | Rows returned | Wall time |
|------|---------------------|---------------|-----------|
| Filtered (2y) | 1470 | **534** | ~5.9s |
| All active | 1470 | **1470** | ~6.4s |

GAM still enumerates all active courses then applies `timefilter` locally, so fetch time is similar; the smaller UI list helps pagination and teacher loading.

## GAM commands used

```text
gam print courses states active timefilter updatetime start YYYY-MM-dd formatjson
gam print courses states <active|archived> formatjson
gam print courses course <id>... show teachers formatjson
gam update course <id> state archived|active
gam course <id> add teachers <email>
```
