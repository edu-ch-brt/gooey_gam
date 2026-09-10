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

## GAM commands used

```text
gam print courses states <active|archived> show teachers formatjson
gam update course <id> state archived|active
gam course <id> add teachers <email>
```
