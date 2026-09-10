# GAM Classroom GUI — Design Spec

**Date:** 2026-09-10  
**Status:** Approved (sections §1–§3)  
**Target path on Spock:** `C:\dev\gam_classroom_gui`

## Goal

A Windows desktop app that wraps the local [GAM](https://github.com/GAM-team/GAM) CLI so admins can manage Google Classroom **courses** without memorising commands: list active or archived classes, search by name, multi-select archive/restore, and add a teacher by email.

## Architecture (§1)

- **Stack:** Tauri 2 — Vite + TypeScript frontend + Rust backend.
- **Integration:** Rust shells out to the local `gam` binary (configurable path; default `C:\GAM7\gam.exe`). No Google API keys in the app; reuses existing GAM OAuth / service-account auth on the machine.
- **Intended machine:** Spock (Windows 11), project under `C:\dev\gam_classroom_gui`.

### Flow

1. UI requests courses for state `active` or `archived`.
2. Backend runs `gam print courses …`, parses structured output.
3. UI filters client-side by name search; user multi-selects rows.
4. Archive / Activate / Add teacher runs the matching `gam` commands (with confirm), shows per-item results, refreshes the list.

## Data & GAM commands (§2)

### List

- Toggle: **Active** | **Archived** → `states active` / `states archived`.
- Command (GAM 7.39.03):

```text
gam print courses states <active|archived> show teachers formatjson
```

- Required fields per course: `id`, `name`, `enrollmentCode` (join code), teachers (emails and/or names from `show teachers`).
- GAM 7 `formatjson` emits CSV with `id,JSON[,JSON-teachers]` columns; the app parses that (and also bare JSON arrays for fixtures).
- **Search:** case-insensitive substring on class **name** only (v1).

### Actions

| Action | Command (GAM 7) |
|--------|-----------------|
| Archive | `gam update course <id> state archived` |
| Activate | `gam update course <id> state active` |
| Add teacher | `gam course <id> add teachers <email>` |

- Confirm dialog stating count (and email for add-teacher) before running.
- Run per selected id; continue on individual failures; show per-row success/fail; refresh list when the batch finishes.

### Config

- Setting: path to `gam.exe` (default: `C:\GAM7\gam.exe`). Persist in `%APPDATA%\gam_classroom_gui\settings.json`.

### Table columns

| Column | Source |
|--------|--------|
| Name | course name |
| Teachers | teacher list (comma-separated emails or display names) |
| Class ID | course id |
| Join code | enrollmentCode |

## UI & errors (§3)

### Layout

- **Toolbar:** Active | Archived toggle · search box · Refresh · Archive · Activate · Add teacher… · Settings
- **Table:** checkbox column + Name | Teachers | Class ID | Join code; select-all for visible/filtered rows.
- **Status bar:** loading progress, last error summary, selection count.

### Behaviour

- Disable Archive when viewing Archived; disable Activate when viewing Active. Both disabled when selection empty.
- Add teacher: dialog for Google email; validate non-empty email-shaped string client-side; confirm; then run.
- Missing / failed `gam`: clear error message + Settings for path.
- Long-running list: show spinner / indeterminate progress.

### Testing (v1)

- Unit-test Rust parsing of sample `gam` JSON fixtures (no live Google calls in CI).
- Manual smoke on Spock with real `gam`.

## Out of scope (v1)

- Create / delete courses, remove teacher, students, bulk CSV, fancy installer.

## Success criteria

1. Switch Active/Archived and see courses with the four columns.
2. Search filters the table by name instantly.
3. Multi-select + Archive or Activate updates via GAM and refreshes.
4. Add teacher by email works for selected course(s).
5. Bad gam path or command failure is understandable in the UI.

