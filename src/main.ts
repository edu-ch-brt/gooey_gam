import { invoke } from "@tauri-apps/api/core";

type CourseState = "active" | "archived";

interface Course {
  id: string;
  name: string;
  enrollment_code: string;
  teachers: string[];
  state: string;
  /** Client-side: teachers fetched for this course (cached until Refresh). */
  teachersLoaded?: boolean;
}

interface CourseTeachers {
  id: string;
  teachers: string[];
}

interface ActionResult {
  id: string;
  ok: boolean;
  message: string;
}

interface Settings {
  gam_path: string;
}

const PAGE_SIZE = 15;

let viewState: CourseState = "active";
let courses: Course[] = [];
let selected = new Set<string>();
let loading = false;
let teachersLoading = false;
let page = 0;
/** Bumps when list/filter/page changes so in-flight teacher fetches can be ignored. */
let teachersFetchGen = 0;

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
  btnPrev: () => document.getElementById("btn-prev") as HTMLButtonElement,
  btnNext: () => document.getElementById("btn-next") as HTMLButtonElement,
  pageInfo: () => document.getElementById("page-info") as HTMLElement,
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

function totalPages(): number {
  const n = filteredCourses().length;
  return Math.max(1, Math.ceil(n / PAGE_SIZE) || 1);
}

function clampPage() {
  const max = totalPages() - 1;
  if (page > max) page = max;
  if (page < 0) page = 0;
}

function pagedCourses(): Course[] {
  clampPage();
  const rows = filteredCourses();
  const start = page * PAGE_SIZE;
  return rows.slice(start, start + PAGE_SIZE);
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

  const pages = totalPages();
  const filteredLen = filteredCourses().length;
  el.btnPrev().disabled = loading || page <= 0;
  el.btnNext().disabled = loading || page >= pages - 1 || filteredLen === 0;
  const start = filteredLen === 0 ? 0 : page * PAGE_SIZE + 1;
  const end = Math.min((page + 1) * PAGE_SIZE, filteredLen);
  el.pageInfo().textContent =
    filteredLen === 0
      ? "Page 0 / 0"
      : `Page ${page + 1} / ${pages} (${start}-${end} of ${filteredLen})`;
}

function teachersLabel(course: Course): string {
  if (course.teachersLoaded) {
    return course.teachers.join(", ") || "";
  }
  return teachersLoading ? "Loading..." : "...";
}

function renderTable() {
  const rows = pagedCourses();
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
      teachersLabel(course),
      course.id,
      course.enrollment_code || "",
    ];
    tr.appendChild(tdCheck);
    for (const text of cells) {
      const td = document.createElement("td");
      td.textContent = text;
      if (text === "Loading..." || text === "...") {
        td.classList.add("teachers-pending");
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  el.empty().classList.toggle("hidden", filteredCourses().length > 0 || loading);
  syncSelectAll();
  updateActionButtons();
}

function syncSelectAll() {
  const rows = pagedCourses();
  const all = rows.length > 0 && rows.every((c) => selected.has(c.id));
  const some = rows.some((c) => selected.has(c.id));
  el.selectAll().checked = all;
  el.selectAll().indeterminate = some && !all;
}

function applyTeacherResults(results: CourseTeachers[]) {
  const byId = new Map(results.map((r) => [r.id, r.teachers]));
  for (const course of courses) {
    if (byId.has(course.id)) {
      course.teachers = byId.get(course.id) ?? [];
      course.teachersLoaded = true;
    }
  }
}

async function ensureTeachersForVisible(forceIds?: string[]) {
  const visible = pagedCourses();
  const need = forceIds
    ? [...new Set(forceIds)]
    : visible.filter((c) => !c.teachersLoaded).map((c) => c.id);
  if (need.length === 0) {
    renderTable();
    return;
  }

  const gen = ++teachersFetchGen;
  teachersLoading = true;
  renderTable();
  try {
    const results = await invoke<CourseTeachers[]>("fetch_course_teachers", {
      ids: need,
    });
    if (gen !== teachersFetchGen) return;
    applyTeacherResults(results);
    // Mark requested ids as loaded even if GAM omitted them (empty teachers).
    for (const id of need) {
      const c = courses.find((x) => x.id === id);
      if (c && !c.teachersLoaded) {
        c.teachers = c.teachers ?? [];
        c.teachersLoaded = true;
      }
    }
  } catch (e) {
    if (gen !== teachersFetchGen) return;
    setStatus(String(e), true);
  } finally {
    if (gen === teachersFetchGen) {
      teachersLoading = false;
      renderTable();
    }
  }
}

async function refresh() {
  loading = true;
  teachersFetchGen++;
  teachersLoading = false;
  page = 0;
  updateActionButtons();
  setStatus(`Loading ${viewState} courses...`);
  try {
    const listed = await invoke<Course[]>("list_courses", { state: viewState });
    courses = listed.map((c) => ({
      ...c,
      teachers: [],
      teachersLoaded: false,
    }));
    const ids = new Set(courses.map((c) => c.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    renderTable();
    setStatus(`Loaded ${courses.length} ${viewState} course(s).`);
    await ensureTeachersForVisible();
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
  page = 0;
  void refresh();
}

function onFilterOrPageChange() {
  clampPage();
  renderTable();
  void ensureTeachersForVisible();
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
  setStatus(`Archiving ${ids.length} course(s)...`);
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
  setStatus(`Activating ${ids.length} course(s)...`);
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
  setStatus(`Adding teacher to ${ids.length} course(s)...`);
  try {
    const results = await invoke<ActionResult[]>("add_teacher", { ids, email });
    showResults(results);
    // Invalidate teacher cache for affected courses and refetch those ids.
    for (const id of ids) {
      const c = courses.find((x) => x.id === id);
      if (c) {
        c.teachersLoaded = false;
        c.teachers = [];
      }
    }
    renderTable();
    await ensureTeachersForVisible(ids);
    setStatus(`Added teacher; refreshed teachers for ${ids.length} course(s).`);
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
  el.search().addEventListener("input", () => {
    page = 0;
    onFilterOrPageChange();
  });
  el.btnPrev().addEventListener("click", () => {
    if (page > 0) {
      page -= 1;
      onFilterOrPageChange();
    }
  });
  el.btnNext().addEventListener("click", () => {
    if (page < totalPages() - 1) {
      page += 1;
      onFilterOrPageChange();
    }
  });

  el.selectAll().addEventListener("change", () => {
    const rows = pagedCourses();
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
