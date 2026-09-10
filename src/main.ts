import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type CourseState = "active" | "archived";

interface Course {
  id: string;
  name: string;
  enrollment_code: string;
  teachers: string[];
  state: string;
  /** Classroom updateTime ISO string (proxy for recent activity, not last access). */
  update_time?: string;
  /** Client-side: teachers fetched for this course (cached until Refresh). */
  teachersLoaded?: boolean;
}

interface CourseTeachers {
  id: string;
  teachers: string[];
}

interface Participant {
  email: string;
  name: string;
}

interface CourseDetail {
  id: string;
  name: string;
  description: string;
  owner_email: string;
  owner_name: string;
  teachers: Participant[];
  students: Participant[];
}

interface ActionResult {
  id: string;
  ok: boolean;
  message: string;
}

interface Settings {
  gam_path: string;
  show_all_active_courses?: boolean;
}

const PAGE_SIZE = 15;
let searchQuery = "";

let viewState: CourseState = "active";
/** Active view only: when false, load courses with updateTime in last 2 years. */
let showAllActive = false;
let courses: Course[] = [];
let selected = new Set<string>();
let loading = false;
let teachersLoading = false;
let page = 0;
/** Bumps when list/filter/page changes so in-flight teacher fetches can be ignored. */
let teachersFetchGen = 0;

let detailCourseId: string | null = null;
let detail: CourseDetail | null = null;
let detailLoading = false;
let detailBusy = false;
let selectedTeachers = new Set<string>();
let selectedStudents = new Set<string>();
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
  btnExit: () => document.getElementById("btn-exit") as HTMLButtonElement,
  showAllActive: () => document.getElementById("show-all-active") as HTMLInputElement,
  showAllWrap: () => document.getElementById("show-all-wrap") as HTMLElement,
  btnPrev: () => document.getElementById("btn-prev") as HTMLButtonElement,
  btnNext: () => document.getElementById("btn-next") as HTMLButtonElement,
  pageInfo: () => document.getElementById("page-info") as HTMLElement,
  settingsDialog: () => document.getElementById("settings-dialog") as HTMLDialogElement,
  gamPath: () => document.getElementById("gam-path") as HTMLInputElement,
  teacherDialog: () => document.getElementById("teacher-dialog") as HTMLDialogElement,
  teacherDialogTitle: () =>
    document.getElementById("teacher-dialog-title") as HTMLElement,
  teacherEmail: () => document.getElementById("teacher-email") as HTMLInputElement,
  teacherHint: () => document.getElementById("teacher-hint") as HTMLElement,
  confirmDialog: () => document.getElementById("confirm-dialog") as HTMLDialogElement,
  confirmTitle: () => document.getElementById("confirm-title") as HTMLElement,
  confirmBody: () => document.getElementById("confirm-body") as HTMLElement,
  resultsDialog: () => document.getElementById("results-dialog") as HTMLDialogElement,
  resultsList: () => document.getElementById("results-list") as HTMLUListElement,
  statusbar: () => document.querySelector(".statusbar") as HTMLElement,
  detailDialog: () => document.getElementById("detail-dialog") as HTMLDialogElement,
  detailName: () => document.getElementById("detail-name") as HTMLElement,
  detailDescription: () => document.getElementById("detail-description") as HTMLElement,
  detailMeta: () => document.getElementById("detail-meta") as HTMLElement,
  detailTeachers: () => document.getElementById("detail-teachers") as HTMLUListElement,
  detailStudents: () => document.getElementById("detail-students") as HTMLUListElement,
  detailStudentCount: () =>
    document.getElementById("detail-student-count") as HTMLElement,
  detailStatus: () => document.getElementById("detail-status") as HTMLElement,
  detailTransfer: () => document.getElementById("detail-transfer") as HTMLButtonElement,
  detailRemoveTeachers: () =>
    document.getElementById("detail-remove-teachers") as HTMLButtonElement,
  detailRemoveStudents: () =>
    document.getElementById("detail-remove-students") as HTMLButtonElement,
  detailAddTeacher: () =>
    document.getElementById("detail-add-teacher") as HTMLButtonElement,
  detailAddStudent: () =>
    document.getElementById("detail-add-student") as HTMLButtonElement,
};

function filteredCourses(): Course[] {
  const q = searchQuery;
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

function setDetailStatus(text: string) {
  el.detailStatus().textContent = text;
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

function updateDetailActionButtons() {
  const busy = detailLoading || detailBusy;
  const teacherCount = selectedTeachers.size;
  const studentCount = selectedStudents.size;
  el.detailTransfer().disabled = busy || teacherCount !== 1;
  el.detailRemoveTeachers().disabled = busy || teacherCount < 1;
  el.detailRemoveStudents().disabled = busy || studentCount < 1;
  el.detailAddTeacher().disabled = busy || !detailCourseId;
  el.detailAddStudent().disabled = busy || !detailCourseId;
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

    const tdName = document.createElement("td");
    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "course-name-link";
    nameBtn.textContent = course.name;
    nameBtn.title = "Open class details";
    nameBtn.disabled = loading;
    nameBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void openCourseDetail(course.id);
    });
    tdName.appendChild(nameBtn);

    const tdTeachers = document.createElement("td");
    const teachersText = teachersLabel(course);
    tdTeachers.textContent = teachersText;
    if (teachersText === "Loading..." || teachersText === "...") {
      tdTeachers.classList.add("teachers-pending");
    }

    const tdId = document.createElement("td");
    tdId.textContent = course.id;
    const tdCode = document.createElement("td");
    tdCode.textContent = course.enrollment_code || "";

    tr.appendChild(tdCheck);
    tr.appendChild(tdName);
    tr.appendChild(tdTeachers);
    tr.appendChild(tdId);
    tr.appendChild(tdCode);
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

function invalidateCourseTeachers(id: string) {
  const c = courses.find((x) => x.id === id);
  if (c) {
    c.teachersLoaded = false;
    c.teachers = [];
  }
}


function renderDetailRoster() {
  const teachersUl = el.detailTeachers();
  const studentsUl = el.detailStudents();
  teachersUl.replaceChildren();
  studentsUl.replaceChildren();

  if (!detail) {
    el.detailStudentCount().textContent = "";
    updateDetailActionButtons();
    return;
  }

  if (detail.owner_email) {
    const li = document.createElement("li");
    li.className = "owner";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "roster-check";
    cb.disabled = true;
    cb.title = "Owner cannot be removed or selected as transfer target here";
    const label = document.createElement("div");
    label.className = "roster-label";
    const emailSpan = document.createElement("span");
    emailSpan.className = "roster-email";
    emailSpan.textContent = detail.owner_email;
    const badge = document.createElement("span");
    badge.className = "roster-badge";
    badge.textContent = "Owner";
    emailSpan.appendChild(document.createTextNode(" "));
    emailSpan.appendChild(badge);
    label.appendChild(emailSpan);
    if (detail.owner_name) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "roster-name";
      nameSpan.textContent = detail.owner_name;
      label.appendChild(nameSpan);
    }
    li.appendChild(cb);
    li.appendChild(label);
    teachersUl.appendChild(li);
  }

  for (const t of detail.teachers) {
    const li = document.createElement("li");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "roster-check";
    cb.checked = selectedTeachers.has(t.email);
    cb.disabled = detailBusy || detailLoading;
    cb.addEventListener("change", () => {
      if (cb.checked) selectedTeachers.add(t.email);
      else selectedTeachers.delete(t.email);
      updateDetailActionButtons();
    });
    const label = document.createElement("div");
    label.className = "roster-label";
    const emailSpan = document.createElement("span");
    emailSpan.className = "roster-email";
    emailSpan.textContent = t.email;
    label.appendChild(emailSpan);
    if (t.name) {
      const nameSpan = document.createElement("span");
      nameSpan.className = "roster-name";
      nameSpan.textContent = t.name;
      label.appendChild(nameSpan);
    }
    li.appendChild(cb);
    li.appendChild(label);
    teachersUl.appendChild(li);
  }

  if (!detail.owner_email && detail.teachers.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No teachers listed.";
    teachersUl.appendChild(li);
  }

  el.detailStudentCount().textContent = `(${detail.students.length})`;
  if (detail.students.length === 0) {
    const li = document.createElement("li");
    li.textContent = "No students listed.";
    studentsUl.appendChild(li);
  } else {
    for (const s of detail.students) {
      const li = document.createElement("li");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.className = "roster-check";
      cb.checked = selectedStudents.has(s.email);
      cb.disabled = detailBusy || detailLoading;
      cb.addEventListener("change", () => {
        if (cb.checked) selectedStudents.add(s.email);
        else selectedStudents.delete(s.email);
        updateDetailActionButtons();
      });
      const label = document.createElement("div");
      label.className = "roster-label";
      const emailSpan = document.createElement("span");
      emailSpan.className = "roster-email";
      emailSpan.textContent = s.email;
      label.appendChild(emailSpan);
      if (s.name) {
        const nameSpan = document.createElement("span");
        nameSpan.className = "roster-name";
        nameSpan.textContent = s.name;
        label.appendChild(nameSpan);
      }
      li.appendChild(cb);
      li.appendChild(label);
      studentsUl.appendChild(li);
    }
  }

  updateDetailActionButtons();
}

function applyDetailToHeader(d: CourseDetail) {
  el.detailName().textContent = d.name || "(unnamed)";
  el.detailDescription().textContent = d.description?.trim()
    ? d.description
    : "No description.";
  el.detailMeta().textContent = `Class ID: ${d.id}`;
}

async function loadCourseDetail(id: string, keepSelections = false) {
  detailLoading = true;
  updateDetailActionButtons();
  setDetailStatus("Loading class details...");
  try {
    const d = await invoke<CourseDetail>("get_course_detail", { id });
    detail = d;
    detailCourseId = d.id;
    if (!keepSelections) {
      selectedTeachers.clear();
      selectedStudents.clear();
    } else {
      const teacherEmails = new Set(d.teachers.map((t) => t.email));
      const studentEmails = new Set(d.students.map((s) => s.email));
      selectedTeachers = new Set(
        [...selectedTeachers].filter((e) => teacherEmails.has(e))
      );
      selectedStudents = new Set(
        [...selectedStudents].filter((e) => studentEmails.has(e))
      );
    }
    applyDetailToHeader(d);
    renderDetailRoster();
    setDetailStatus(
      `Loaded ${d.teachers.length} co-teacher(s), ${d.students.length} student(s).`
    );
  } catch (e) {
    setDetailStatus(String(e));
    throw e;
  } finally {
    detailLoading = false;
    updateDetailActionButtons();
  }
}

async function openCourseDetail(id: string) {
  detailCourseId = id;
  detail = null;
  selectedTeachers.clear();
  selectedStudents.clear();
  const fromList = courses.find((c) => c.id === id);
  el.detailName().textContent = fromList?.name || "Class";
  el.detailDescription().textContent = "Loading...";
  el.detailMeta().textContent = `Class ID: ${id}`;
  el.detailTeachers().replaceChildren();
  el.detailStudents().replaceChildren();
  el.detailStudentCount().textContent = "";
  setDetailStatus("");
  updateDetailActionButtons();
  el.detailDialog().showModal();
  try {
    await loadCourseDetail(id);
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function refreshDetailAndMainTeachers() {
  if (!detailCourseId) return;
  const id = detailCourseId;
  await loadCourseDetail(id);
  invalidateCourseTeachers(id);
  renderTable();
  await ensureTeachersForVisible([id]);
}

async function refresh() {
  loading = true;
  teachersFetchGen++;
  teachersLoading = false;
  page = 0;
  updateActionButtons();
  setStatus(`Loading ${viewState} courses...`);
  try {
    const listed = await invoke<Course[]>("list_courses", {
      state: viewState,
      showAllActive: viewState === "active" ? showAllActive : true,
    });
    courses = listed.map((c) => ({
      ...c,
      teachers: [],
      teachersLoaded: false,
    }));
    const ids = new Set(courses.map((c) => c.id));
    selected = new Set([...selected].filter((id) => ids.has(id)));
    renderTable();
    const filterNote =
      viewState === "active" && !showAllActive
        ? " (updated in last 2 years)"
        : "";
    setStatus(`Loaded ${courses.length} ${viewState} course(s)${filterNote}.`);
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
  el.showAllWrap().classList.toggle("hidden", state !== "active");
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

function askEmail(mode: "bulk-teacher" | "detail-teacher" | "detail-student"): Promise<string | null> {
  return new Promise((resolve) => {
    if (mode === "bulk-teacher") {
      const ids = [...selected];
      el.teacherDialogTitle().textContent = "Add teacher";
      el.teacherHint().textContent = `Will add teacher to ${ids.length} course(s).`;
    } else if (mode === "detail-teacher") {
      el.teacherDialogTitle().textContent = "Add teacher";
      el.teacherHint().textContent = detail
        ? `Add teacher to "${detail.name}".`
        : "Add teacher to this class.";
    } else {
      el.teacherDialogTitle().textContent = "Add student";
      el.teacherHint().textContent = detail
        ? `Add student to "${detail.name}".`
        : "Add student to this class.";
    }
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
  const email = await askEmail("bulk-teacher");
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
    for (const id of ids) {
      invalidateCourseTeachers(id);
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

async function runDetailTransfer() {
  if (!detailCourseId || selectedTeachers.size !== 1) return;
  const email = [...selectedTeachers][0];
  if (
    !(await confirmAction(
      "Transfer ownership",
      `Transfer ownership of this class to ${email}? The current owner will remain as a teacher.`
    ))
  ) {
    return;
  }
  detailBusy = true;
  updateDetailActionButtons();
  setDetailStatus(`Transferring ownership to ${email}...`);
  try {
    const result = await invoke<ActionResult>("transfer_ownership", {
      id: detailCourseId,
      email,
    });
    if (!result.ok) {
      setDetailStatus(result.message);
      setStatus(result.message, true);
      return;
    }
    setStatus(result.message);
    await refreshDetailAndMainTeachers();
  } catch (e) {
    setDetailStatus(String(e));
    setStatus(String(e), true);
  } finally {
    detailBusy = false;
    updateDetailActionButtons();
  }
}

async function runDetailRemoveTeachers() {
  if (!detailCourseId || selectedTeachers.size === 0) return;
  const emails = [...selectedTeachers];
  if (
    !(await confirmAction(
      "Remove teachers",
      `Remove ${emails.length} teacher(s) from this class?\n\n${emails.join("\n")}`
    ))
  ) {
    return;
  }
  detailBusy = true;
  updateDetailActionButtons();
  setDetailStatus(`Removing ${emails.length} teacher(s)...`);
  try {
    const results = await invoke<ActionResult[]>("remove_teachers", {
      id: detailCourseId,
      emails,
    });
    showResults(results);
    await refreshDetailAndMainTeachers();
  } catch (e) {
    setDetailStatus(String(e));
    setStatus(String(e), true);
  } finally {
    detailBusy = false;
    updateDetailActionButtons();
  }
}

async function runDetailRemoveStudents() {
  if (!detailCourseId || selectedStudents.size === 0) return;
  const emails = [...selectedStudents];
  if (
    !(await confirmAction(
      "Remove students",
      `Remove ${emails.length} student(s) from this class?\n\n${emails.join("\n")}`
    ))
  ) {
    return;
  }
  detailBusy = true;
  updateDetailActionButtons();
  setDetailStatus(`Removing ${emails.length} student(s)...`);
  try {
    const results = await invoke<ActionResult[]>("remove_students", {
      id: detailCourseId,
      emails,
    });
    showResults(results);
    await refreshDetailAndMainTeachers();
  } catch (e) {
    setDetailStatus(String(e));
    setStatus(String(e), true);
  } finally {
    detailBusy = false;
    updateDetailActionButtons();
  }
}

async function runDetailAddTeacher() {
  if (!detailCourseId) return;
  const email = await askEmail("detail-teacher");
  if (!email) return;
  if (!email.includes("@")) {
    setDetailStatus("Enter a valid email address.");
    return;
  }
  if (
    !(await confirmAction(
      "Add teacher",
      `Add ${email} as teacher to this class?`
    ))
  ) {
    return;
  }
  detailBusy = true;
  updateDetailActionButtons();
  setDetailStatus(`Adding teacher ${email}...`);
  try {
    const result = await invoke<ActionResult>("add_teacher_to_course", {
      id: detailCourseId,
      email,
    });
    if (!result.ok) {
      setDetailStatus(result.message);
      setStatus(result.message, true);
      return;
    }
    await refreshDetailAndMainTeachers();
  } catch (e) {
    setDetailStatus(String(e));
    setStatus(String(e), true);
  } finally {
    detailBusy = false;
    updateDetailActionButtons();
  }
}

async function runDetailAddStudent() {
  if (!detailCourseId) return;
  const email = await askEmail("detail-student");
  if (!email) return;
  if (!email.includes("@")) {
    setDetailStatus("Enter a valid email address.");
    return;
  }
  if (
    !(await confirmAction(
      "Add student",
      `Add ${email} as student to this class?`
    ))
  ) {
    return;
  }
  detailBusy = true;
  updateDetailActionButtons();
  setDetailStatus(`Adding student ${email}...`);
  try {
    const result = await invoke<ActionResult>("add_student", {
      id: detailCourseId,
      email,
    });
    if (!result.ok) {
      setDetailStatus(result.message);
      setStatus(result.message, true);
      return;
    }
    await refreshDetailAndMainTeachers();
  } catch (e) {
    setDetailStatus(String(e));
    setStatus(String(e), true);
  } finally {
    detailBusy = false;
    updateDetailActionButtons();
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

async function persistShowAllPreference() {
  try {
    const settings = await invoke<Settings>("get_settings");
    await invoke<Settings>("set_settings", {
      settings: {
        gam_path: settings.gam_path,
        show_all_active_courses: showAllActive,
      },
    });
  } catch (e) {
    setStatus(String(e), true);
  }
}

async function loadInitialPreferences() {
  try {
    const settings = await invoke<Settings>("get_settings");
    showAllActive = Boolean(settings.show_all_active_courses);
    el.showAllActive().checked = showAllActive;
  } catch {
    showAllActive = false;
    el.showAllActive().checked = false;
  }
  el.showAllWrap().classList.toggle("hidden", viewState !== "active");
}

window.addEventListener("DOMContentLoaded", () => {
  el.btnActive().addEventListener("click", () => setView("active"));
  el.btnArchived().addEventListener("click", () => setView("archived"));
  el.btnRefresh().addEventListener("click", () => void refresh());
  el.btnArchive().addEventListener("click", () => void runArchive());
  el.btnActivate().addEventListener("click", () => void runActivate());
  el.btnAddTeacher().addEventListener("click", () => void runAddTeacher());
  el.btnSettings().addEventListener("click", () => void openSettings());
  el.btnExit().addEventListener("click", () => {
    void getCurrentWindow().close();
  });
  el.showAllActive().addEventListener("change", () => {
    showAllActive = el.showAllActive().checked;
    void (async () => {
      await persistShowAllPreference();
      await refresh();
    })();
  });
  const applySearch = () => {
    searchQuery = el.search().value.trim().toLowerCase();
    page = 0;
    onFilterOrPageChange();
  };
  el.search().addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applySearch();
    }
  });
  // Fires on Enter and when the clear (x) control is used on type=search.
  el.search().addEventListener("search", () => {
    applySearch();
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

  el.detailTransfer().addEventListener("click", () => void runDetailTransfer());
  el.detailRemoveTeachers().addEventListener("click", () =>
    void runDetailRemoveTeachers()
  );
  el.detailRemoveStudents().addEventListener("click", () =>
    void runDetailRemoveStudents()
  );
  el.detailAddTeacher().addEventListener("click", () =>
    void runDetailAddTeacher()
  );
  el.detailAddStudent().addEventListener("click", () =>
    void runDetailAddStudent()
  );

  document.getElementById("settings-form")?.addEventListener("submit", async (ev) => {
    const submitter = (ev as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value !== "save") return;
    ev.preventDefault();
    try {
      await invoke<Settings>("set_settings", {
        settings: {
          gam_path: el.gamPath().value.trim(),
          show_all_active_courses: showAllActive,
        },
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

  void (async () => {
    await loadInitialPreferences();
    await refresh();
  })();
});
