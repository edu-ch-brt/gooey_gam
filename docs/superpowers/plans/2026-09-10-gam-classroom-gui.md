# GAM Classroom GUI Implementation Plan

**Goal:** Ship a Tauri 2 Windows desktop app that lists Google Classroom courses via local `gam`, supports search/select, archive/activate, and add-teacher by email.

**Architecture:** Vite + TypeScript frontend + Rust Tauri commands that spawn `gam`, parse JSON, and return typed results. Persist gam path in app config.

**Tech Stack:** Tauri 2, Rust, Vite, TypeScript, Windows target.

## Tasks

### Task 1: Scaffold Tauri 2 + Vite app — done
### Task 2: Gam runner + course parsing (Rust) — in progress
### Task 3: Tauri commands API
### Task 4: Frontend UI
### Task 5: Polish + docs + tests

## Manual smoke (Spock)

1. `gam version` / `gam print courses states active showitemcountonly`
2. `npm run tauri dev` from `C:\dev\gam_classroom_gui`
3. List active → search → archive one disposable course → activate → add teacher on a test course.
