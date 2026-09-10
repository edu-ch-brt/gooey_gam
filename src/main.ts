import { invoke } from "@tauri-apps/api/core";

type CourseState = "active" | "archived";

interface Course {
  id: string;
  name: string;
  enrollment_code: string;
  teachers: string[];
  state: string;
}

interface ActionResult {
  id: string;
  ok: boolean;
  message: string;
}

interface Settings {
  gam_path: string;
}

let viewState: CourseState = "active";
let courses: Course[] = [];
let selected = new Set<string>();
let loading = false;

const el = {
  body: () => document.getElementById("courses-body") as HTMLTableSectionElement,
  search: () => document.getElementById("search") as HTMLInputElement,
  status: () => document.getElementById("status-text") as HTMLElement,
  selection: () => document.getElementById("selection-text") as HTMLElement,
  selectAll: () => document.getElementById("select-all") as HTMLInputElement,
  empty: () => document.getElementById("empty-msg") as HTMLElement,
  btnActive: () => document.getElementById("btn-active") as HTMLButtonElement,
  btnArchived: () => document.getElementById("btn-archived") as HTMLButtonElement,
  btnRefresh: () => document.getElementById("btn-refresh") as HTMLButtonElement,
  btnArchive: () => document.getElementById("btn-archive") as HTMLButtonElement,
  btnActivate: () => document.getElementById("btn-activate") as HTMLButtonElement,
  btnAddTeacher: () => document.getElementById("btn-add-teacher") as HTMLButtonElement,
  btnSettings: () => document.getElementById("btn-settings") as HTMLButtonElement,
  settingsDialog: () => document.getElementById("settings-dialog") as HTMLDialogElement,
  gamPath: () => document.getElementById("gam-path") as HTMLInputElement,
  teacherDialog: () => document.getElementById("teacher-dialog") as HTMLDialogElement,
  teacherEmail: () => document.getElementById("teacher-email") as HTMLInputElement,
  teacherHint: () => document.getElementById("teacher-hint") as HTMLElement,
  confirmDialog: () => document.getElementById("confirm-dialog") as HTMLDialogElement,
  confirmTitle: () => document.getElementById("confirm-title") as HTMLElement,
  confirmBody: () => document.getElementById("confirm-body") as HTMLElement,
  resultsDialog: () => document.getElementById("results-dialog") as HTMLDialogElement,
  resultsList: () => document.getElementById("results-list") as HTMLUListElement,
  statusbar: () => document.querySelector(".statusbar") as HTMLElement,
};

function filteredCourses(): Course[] {
  const q = el.search().value.trim().toLowerCase();
  if (!q) return courses;
  return courses.filter((c) => c.name.toLowerCase().includes(q));
}

function setStatus(text: string, isError = false) {
  el.status().textContent = text;
  el.statusbar().classList.toggle("error", isError);
}

function updateActionButtons() {
  const n = selected.size;
  el.btnArchive().disabled = loading || n === 0 || viewState !== "active";
  el.btnActivate().disabled = loading || n === 0 || viewState !== "archived";
  el.btnAddTeacher().disabled = loading || n === 0;
  el.btnRefresh().disabled = loading;
  el.selection().textContent = n ? `${n} selected` : "";
}

function renderTable() {
  const rows = filteredCourses();
  const tbody = el.body();
  tbody.replaceChildren();

  for (const course of rows) {
    const tr = document.createElement("tr");
    if (selected.has(course.id)) tr.classList.add("selected");

    const tdCheck = document.createElement("td");
    tdCheck.className = "col-check";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = selected.has(course.id);
    cb.addEventListener("change", () => {
      if (cb.checked) selected.add(course.id);
      else selected.delete(course.id);
      tr.classList.toggle("selected", cb.checked);
      syncSelectAll();
      updateActionButtons();
    });
    tdCheck.appendChild(cb);

    const cells = [
      course.name,
      course.teachers.join(", "),
      course.id,
      course.enrollment_code || "",
    ];
    tr.appendChild(tdCheck);
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  el.empty().classList.toggle("hidden", rows.length > 0 || loading);
  syncSelectAll();
  updateActionButtons();
}

function syncSelectAll() {
  const rows = filteredCourses();
  const all =
    rows.length > 0 && rows.every((c) => selected.has(c.id));
  const some = rows.some((c) => selected.has(c.id));
  el.selectAll().checked = all;
  el.selectAll().indeterminate = some && !all;
}

async function refresh() {
  loading = true;
  updateActionButtons();
  setStatus(`Loading ${viewState} courses…`);
  try {
    courses = await invoke<Course[]>("list_courses", { state: viewState });
    // Drop selections that disappeared
    const ids = new Set(courses.map((c) => c.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    renderTable();
    setStatus(`Loaded ${courses.length} ${viewState} course(s).`);
  } catch (e) {
    courses = [];
    renderTable();
    setStatus(String(e), true);
  } finally {
    loading = false;
    updateActionButtons();
  }
}

function setView(state: CourseState) {
  viewState = state;
  el.btnActive().classList.toggle("active", state === "active");
  el.btnArchived().classList.toggle("active", state === "archived");
  selected.clear();
  void refresh();
}

function confirmAction(title: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    el.confirmTitle().textContent = title;
    el.confirmBody().textContent = body;
    const dialog = el.confirmDialog();
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      resolve(dialog.returnValue === "ok");
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
  });
}

function showResults(results: ActionResult[]) {
  const list = el.resultsList();
  list.replaceChildren();
  for (const r of results) {
    const li = document.createElement("li");
    li.className = r.ok ? "ok" : "fail";
    li.textContent = `${r.id}: ${r.message}`;
    list.appendChild(li);
  }
  el.resultsDialog().showModal();
}

async function runArchive() {
  const ids = [...selected];
  if (
    !(await confirmAction(
      "Archive courses",
      `Archive ${ids.length} selected course(s)?`
    ))
  ) {
    return;
  }
  loading = true;
  updateActionButtons();
  setStatus(`Archiving ${ids.length} course(s)…`);
  try {
    const results = await invoke<ActionResult[]>("archive_courses", { ids });
    showResults(results);
    await refresh();
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    loading = false;
    updateActionButtons();
  }
}

async function runActivate() {
  const ids = [...selected];
  if (
    !(await confirmAction(
      "Activate courses",
      `Activate ${ids.length} selected course(s)?`
    ))
  ) {
    return;
  }
  loading = true;
  updateActionButtons();
  setStatus(`Activating ${ids.length} course(s)…`);
  try {
    const results = await invoke<ActionResult[]>("activate_courses", { ids });
    showResults(results);
    await refresh();
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    loading = false;
    updateActionButtons();
  }
}

function askTeacherEmail(): Promise<string | null> {
  return new Promise((resolve) => {
    const ids = [...selected];
    el.teacherHint().textContent = `Will add teacher to ${ids.length} course(s).`;
    el.teacherEmail().value = "";
    const dialog = el.teacherDialog();
    const onClose = () => {
      dialog.removeEventListener("close", onClose);
      if (dialog.returnValue !== "ok") {
        resolve(null);
        return;
      }
      resolve(el.teacherEmail().value.trim());
    };
    dialog.addEventListener("close", onClose);
    dialog.showModal();
    el.teacherEmail().focus();
  });
}

async function runAddTeacher() {
  const email = await askTeacherEmail();
  if (!email) return;
  if (!email.includes("@")) {
    setStatus("Enter a valid email address.", true);
    return;
  }
  const ids = [...selected];
  if (
    !(await confirmAction(
      "Add teacher",
      `Add ${email} as teacher to ${ids.length} course(s)?`
    ))
  ) {
    return;
  }
  loading = true;
  updateActionButtons();
  setStatus(`Adding teacher to ${ids.length} course(s)…`);
  try {
    const results = await invoke<ActionResult[]>("add_teacher", { ids, email });
    showResults(results);
    await refresh();
  } catch (e) {
    setStatus(String(e), true);
  } finally {
    loading = false;
    updateActionButtons();
  }
}

async function openSettings() {
  try {
    const settings = await invoke<Settings>("get_settings");
    el.gamPath().value = settings.gam_path;
  } catch {
    el.gamPath().value = "C:\\GAM7\\gam.exe";
  }
  el.settingsDialog().showModal();
}

window.addEventListener("DOMContentLoaded", () => {
  el.btnActive().addEventListener("click", () => setView("active"));
  el.btnArchived().addEventListener("click", () => setView("archived"));
  el.btnRefresh().addEventListener("click", () => void refresh());
  el.btnArchive().addEventListener("click", () => void runArchive());
  el.btnActivate().addEventListener("click", () => void runActivate());
  el.btnAddTeacher().addEventListener("click", () => void runAddTeacher());
  el.btnSettings().addEventListener("click", () => void openSettings());
  el.search().addEventListener("input", () => renderTable());

  el.selectAll().addEventListener("change", () => {
    const rows = filteredCourses();
    if (el.selectAll().checked) {
      for (const c of rows) selected.add(c.id);
    } else {
      for (const c of rows) selected.delete(c.id);
    }
    renderTable();
  });

  document.getElementById("settings-form")?.addEventListener("submit", async (ev) => {
    const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== "save") return;
    ev.preventDefault();
    try {
      await invoke<Settings>("set_settings", {
        settings: { gam_path: el.gamPath().value.trim() },
      });
      el.settingsDialog().close("save");
      setStatus("Settings saved.");
      await refresh();
    } catch (e) {
      setStatus(String(e), true);
    }
  });

  document.getElementById("teacher-form")?.addEventListener("submit", (ev) => {
    const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === "ok") {
      const email = el.teacherEmail().value.trim();
      if (!email || !email.includes("@")) {
        ev.preventDefault();
        el.teacherHint().textContent = "Enter a valid email (must contain @).";
      }
    }
  });

  void refresh();
});



