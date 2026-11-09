// Admin dashboard. Every action here is re-checked by the database
// (is_admin() in RLS policies and in each workflow function), so this page
// being reachable by URL doesn't grant anything by itself.

let currentAdmin = null;
const $ = id => document.getElementById(id);

const SECTIONS = ["overview", "approvals", "clubs", "users", "categories", "announcements"];
let profilesById = {};
let categoriesCache = [];

// ---------- sidebar (same shell as the community site) ----------

function openSidebar() {
  $("app-sidebar").classList.add("open");
  $("sidebar-overlay").classList.add("open");
}

function closeSidebar() {
  $("app-sidebar").classList.remove("open");
  $("sidebar-overlay").classList.remove("open");
}

$("hamburger-btn").addEventListener("click", openSidebar);
$("sidebar-overlay").addEventListener("click", closeSidebar);

$("logout-btn").addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.href = "/index.html";
});

// ---------- modal wiring ----------

function openModal(id) { $(id).classList.add("open"); }
function closeModalById(id) { $(id).classList.remove("open"); }

document.querySelectorAll("[data-close-modal]").forEach(btn => btn.addEventListener("click", () => closeModalById(btn.dataset.closeModal)));
document.querySelectorAll(".modal-overlay").forEach(o => o.addEventListener("click", e => { if (e.target === o) o.classList.remove("open"); }));
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  if (document.querySelector(".dialog-overlay")) return; // a confirm dialog handles its own Escape
  const open = [...document.querySelectorAll(".modal-overlay.open")].pop();
  if (!open) return;
  open.classList.remove("open");
  if (open.id === "club-modal-overlay") history.replaceState(null, "", "#clubs");
});

// ---------- routing between sections (#approvals, #clubs/<id>, ...) ----------

function currentSection() {
  const [name, param] = window.location.hash.replace(/^#/, "").split("/");
  return { name: SECTIONS.includes(name) ? name : "overview", param: param || null };
}

async function showSection() {
  const { name, param } = currentSection();
  document.querySelectorAll(".admin-panel").forEach(p => p.classList.toggle("active", p.id === `section-${name}`));
  document.querySelectorAll(".admin-nav-item").forEach(a => a.classList.toggle("active", a.dataset.section === name));
  closeSidebar();
  if (!param) window.scrollTo({ top: 0 });

  if (name === "overview") loadOverview();
  if (name === "approvals") loadApprovals();
  if (name === "clubs") {
    await loadClubs();
    if (param) openClubModal(param);
  }
  if (name === "users") loadUsers();
  if (name === "categories") loadCategories();
  if (name === "announcements") loadAnnouncements();
}

window.addEventListener("hashchange", showSection);

// ---------- shared lookups ----------

async function loadProfiles() {
  const { data, error } = await supabaseClient.from("profiles").select("*").order("first_name");
  if (error) throw error;
  profilesById = {};
  data.forEach(p => { profilesById[p.id] = p; });
  return data;
}

function personName(id) {
  return id && profilesById[id] ? fullName(profilesById[id]) : "—";
}

async function loadCategoryNames() {
  const { data } = await supabaseClient.from("club_categories").select("*").order("sort_order").order("name");
  categoriesCache = data || [];
  return categoriesCache;
}

// ============================================================
// OVERVIEW
// ============================================================

async function countOf(query) {
  const { count, error } = await query;
  return error ? "—" : count;
}

async function loadOverview() {
  const statsEl = $("admin-stats");
  statsEl.innerHTML = loadingHtml("Loading statistics…");

  const head = { count: "exact", head: true };
  const [students, teachers, activeClubs, leaderRows, memberships, pendingClubs, pendingContent, events] = await Promise.all([
    countOf(supabaseClient.from("profiles").select("id", head).eq("account_type", "student").neq("role", "admin")),
    countOf(supabaseClient.from("profiles").select("id", head).eq("account_type", "teacher").neq("role", "admin")),
    countOf(supabaseClient.from("clubs").select("id", head).eq("status", "approved")),
    supabaseClient.from("club_leaders").select("user_id").is("ended_at", null),
    countOf(supabaseClient.from("club_members").select("id", head).eq("status", "approved")),
    countOf(supabaseClient.from("clubs").select("id", head).eq("status", "pending")),
    countOf(supabaseClient.from("approval_queue").select("id", head).eq("status", "pending").neq("kind", "club")),
    countOf(supabaseClient.from("club_posts").select("id", head).eq("kind", "event").eq("status", "approved")),
  ]);
  const leaders = leaderRows.error ? "—" : new Set(leaderRows.data.map(r => r.user_id)).size;

  const tiles = [
    ["Registered students", students, "#users", "gradCap"],
    ["Teachers", teachers, "#users", "book"],
    ["Active clubs", activeClubs, "#clubs", "star"],
    ["Club leaders", leaders, "#users", "shield"],
    ["Active memberships", memberships, "#clubs", "users"],
    ["Pending club requests", pendingClubs, "#approvals", "clock", true],
    ["Pending content approvals", pendingContent, "#approvals", "list", true],
    ["Approved events", events, "#approvals", "calendar"],
  ];
  statsEl.innerHTML = tiles.map(([label, value, href, iconName, attention]) => `
    <a class="stat-card${attention && value > 0 ? " stat-card-pending" : ""}" href="${href}">
      <span class="stat-icon">${icon(iconName)}</span>
      <span class="stat-text">
        <span class="stat-value">${value}</span>
        <span class="stat-label">${label}</span>
      </span>
    </a>`).join("");

  updatePendingBadge();

  const { data: recent, error } = await supabaseClient
    .from("approval_queue")
    .select("*")
    .order("submitted_at", { ascending: false })
    .limit(8);
  const tbody = $("recent-tbody");
  tbody.innerHTML = "";
  if (error) {
    tbody.innerHTML = `<tr><td colspan="6">${errorStateHtml("Couldn't load requests. Has migration 006 been run?")}</td></tr>`;
    return;
  }
  $("recent-empty").hidden = recent.length !== 0;
  recent.forEach(r => tbody.appendChild(approvalRow(r, false)));
}

async function updatePendingBadge() {
  const { count } = await supabaseClient.from("approval_queue").select("id", { count: "exact", head: true }).eq("status", "pending");
  const badge = $("nav-pending-count");
  badge.hidden = !count;
  badge.textContent = count || "";

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) return;
  const { count: unread } = await supabaseClient.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", session.user.id).is("read_at", null);
  $("admin-unread").hidden = !unread;
  $("admin-unread").textContent = unread || "";
}

// ============================================================
// APPROVAL CENTER
// ============================================================

let approvalsCache = [];

function queueKind(r) {
  if (r.kind !== "post") return r.kind;
  return r.kind_label === "Event announcement" ? "post:event" : r.kind_label === "Event results" ? "post:event_result" : "post:announcement";
}

async function loadApprovals() {
  const tbody = $("approvals-tbody");
  tbody.innerHTML = `<tr><td colspan="7">${loadingHtml()}</td></tr>`;
  if (Object.keys(profilesById).length === 0) await loadProfiles().catch(() => {});
  const { data, error } = await supabaseClient.from("approval_queue").select("*").order("submitted_at", { ascending: true }).limit(1000);
  if (error) {
    tbody.innerHTML = `<tr><td colspan="7">${errorStateHtml("Couldn't load the approval queue. Has migration 006 been run?")}</td></tr>`;
    return;
  }
  approvalsCache = data;
  renderApprovals();
  updatePendingBadge();
}

function renderApprovals() {
  const status = $("approvals-status").value;
  const kind = $("approvals-kind").value;
  const term = $("approvals-search").value.trim().toLowerCase();
  let rows = approvalsCache.filter(r =>
    (status === "all" || r.status === status) &&
    (kind === "all" || queueKind(r) === kind) &&
    (!term || `${r.club_name} ${r.title} ${personName(r.submitted_by)}`.toLowerCase().includes(term)));
  // pending: oldest first (first come, first served); otherwise newest first
  if (status !== "pending") rows = rows.slice().reverse();

  const tbody = $("approvals-tbody");
  tbody.innerHTML = "";
  $("approvals-empty").hidden = rows.length !== 0;
  rows.forEach(r => tbody.appendChild(approvalRow(r, true)));
}

function approvalRow(r, withSubmitter) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><span class="kind-chip">${escapeHtml(r.kind_label)}</span></td>
    <td><strong>${escapeHtml(r.club_name)}</strong></td>
    <td>${escapeHtml(r.title)}</td>
    ${withSubmitter ? `<td>${escapeHtml(personName(r.submitted_by))}</td>` : ""}
    <td>${formatDate(r.submitted_at)}</td>
    <td>${statusBadge(r.status)}</td>
    <td><button class="btn ${r.status === "pending" ? "btn-primary" : "btn-secondary"} btn-sm">${r.status === "pending" ? "Review" : "View"}</button></td>`;
  tr.querySelector("button").addEventListener("click", () => openReviewModal(r));
  return tr;
}

["approvals-status", "approvals-kind"].forEach(id => $(id).addEventListener("change", renderApprovals));
$("approvals-search").addEventListener("input", renderApprovals);

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------- review modal ----------

let reviewing = null;

async function openReviewModal(r) {
  reviewing = r;
  if (Object.keys(profilesById).length === 0) await loadProfiles().catch(() => {});
  $("review-modal-title").textContent = `${r.kind_label}: ${r.title}`;
  $("review-modal-meta").innerHTML = `
    <span><strong>Club:</strong> ${escapeHtml(r.club_name)}</span>
    <span><strong>Submitted by:</strong> ${escapeHtml(personName(r.submitted_by))}</span>
    <span><strong>Submitted:</strong> ${escapeHtml(formatDateTime(r.submitted_at))}</span>
    <span>${statusBadge(r.status)}</span>`;
  $("review-note").value = r.status === "pending" ? "" : (r.review_note || "");
  $("review-error").textContent = "";
  $("review-modal-decision").hidden = r.status !== "pending";
  const preview = $("review-modal-preview");
  preview.innerHTML = loadingHtml("Loading preview…");
  openModal("review-modal-overlay");

  try {
    preview.innerHTML = await buildPreview(r);
  } catch (err) {
    preview.innerHTML = errorStateHtml(friendlyError(err));
  }
  if (r.status !== "pending" && r.review_note) {
    preview.insertAdjacentHTML("beforeend", `<p class="review-note"><strong>Review note:</strong> ${escapeHtml(r.review_note)}</p>`);
  }
}

function imgOrNone(url, cls = "preview-img") {
  return url ? `<img class="${cls}" src="${escapeHtml(url)}" alt="">` : '<span class="muted">No image</span>';
}

async function buildPreview(r) {
  if (r.kind === "club") {
    const { data: c, error } = await supabaseClient.from("clubs").select("*").eq("id", r.id).single();
    if (error) throw error;
    return `
      <dl class="preview-dl">
        <dt>Logo</dt><dd>${imgOrNone(c.logo_url, "preview-logo")}</dd>
        <dt>Name</dt><dd>${escapeHtml(c.name)}</dd>
        <dt>Category</dt><dd>${escapeHtml(c.category)}</dd>
        <dt>Description</dt><dd class="preserve-lines">${escapeHtml(c.description)}</dd>
        <dt>Requested by</dt><dd>${escapeHtml(personName(c.created_by))}</dd>
        <dt>Proposed leader</dt><dd>${escapeHtml(personName(c.proposed_leader_id || c.created_by))}</dd>
      </dl>
      <p class="muted">Approving makes the club public and gives the proposed leader the Leader Dashboard.</p>`;
  }

  if (r.kind === "club_change") {
    const { data: req, error } = await supabaseClient.from("club_change_requests").select("*, club:clubs(*)").eq("id", r.id).single();
    if (error) throw error;
    const c = req.club;
    const row = (label, before, after, isHtml = false) => {
      const changed = String(before || "") !== String(after || "");
      return `<tr class="${changed ? "is-changed" : ""}"><th>${label}</th><td>${isHtml ? before : escapeHtml(before)}</td><td>${isHtml ? after : escapeHtml(after)}</td></tr>`;
    };
    return `
      <table class="diff-table">
        <thead><tr><th></th><th>Current</th><th>Proposed</th></tr></thead>
        <tbody>
          ${row("Name", c.name, req.name)}
          ${row("Category", c.category, req.category)}
          ${row("Description", c.description, req.description)}
          ${String(c.logo_url || "") !== String(req.logo_url || "")
            ? `<tr class="is-changed"><th>Logo</th><td>${imgOrNone(c.logo_url, "preview-logo")}</td><td>${imgOrNone(req.logo_url, "preview-logo")}</td></tr>`
            : `<tr><th>Logo</th><td colspan="2">${imgOrNone(c.logo_url, "preview-logo")}</td></tr>`}
        </tbody>
      </table>
      <p class="muted">Changed rows are highlighted.</p>`;
  }

  if (r.kind === "questionnaire") {
    const { data: q, error } = await supabaseClient.from("questionnaires").select("*, questions:questionnaire_questions(*)").eq("id", r.id).single();
    if (error) throw error;
    const qs = q.questions.sort((a, b) => a.position - b.position);
    const typeLabel = { short_text: "Short answer", long_text: "Long answer", single_choice: "Multiple choice", multi_choice: "Checkboxes" };
    return `
      <h3 class="preview-title">${escapeHtml(q.title)} <span class="muted">(version ${q.version})</span></h3>
      ${q.intro ? `<p class="preserve-lines">${escapeHtml(q.intro)}</p>` : ""}
      <ol class="preview-questions">
        ${qs.map(x => `
          <li>
            <strong>${escapeHtml(x.label)}</strong> ${x.required ? '<span class="req">*</span>' : '<span class="muted">(optional)</span>'}
            <span class="kind-chip">${typeLabel[x.type]}</span>
            ${x.help_text ? `<div class="muted">${escapeHtml(x.help_text)}</div>` : ""}
            ${x.options && x.options.length ? `<ul>${x.options.map(o => `<li>${escapeHtml(o)}</li>`).join("")}</ul>` : ""}
          </li>`).join("")}
      </ol>
      <p class="muted">Approving replaces the club's current live form. Students who already applied keep their original answers.</p>`;
  }

  if (r.kind === "post") {
    const { data: p, error } = await supabaseClient.from("club_posts").select("*, photos:club_post_photos(url, position)").eq("id", r.id).single();
    if (error) throw error;
    let parent = null;
    if (p.parent_event_id) {
      const res = await supabaseClient.from("club_posts").select("title, event_date").eq("id", p.parent_event_id).maybeSingle();
      parent = res.data;
    }
    const photos = (p.photos || []).sort((a, b) => a.position - b.position);
    return `
      <div class="post-preview">
        ${p.cover_url ? `<img class="preview-img" src="${escapeHtml(p.cover_url)}" alt="">` : ""}
        <h3 class="preview-title">${escapeHtml(p.title)}</h3>
        ${p.kind === "event" ? `<p><strong>Date:</strong> ${escapeHtml(formatEventDay(p.event_date))}${p.start_time ? ` · ${escapeHtml(formatTimeRange(p.start_time, p.end_time))}` : ""}${p.location ? `<br><strong>Location:</strong> ${escapeHtml(p.location)}` : ""}</p>` : ""}
        ${parent ? `<p><strong>Results for:</strong> ${escapeHtml(parent.title)} (${escapeHtml(formatEventDay(parent.event_date))})</p>` : ""}
        ${p.body ? `<p class="preserve-lines">${escapeHtml(p.body)}</p>` : ""}
        ${photos.length ? `<div class="photo-grid photos-${photos.length}">${photos.map(ph => `<a href="${escapeHtml(ph.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(ph.url)}" alt=""></a>`).join("")}</div>` : ""}
      </div>`;
  }

  if (r.kind === "achievement") {
    const { data: a, error } = await supabaseClient.from("club_achievements").select("*").eq("id", r.id).single();
    if (error) throw error;
    return `
      <div class="post-preview">
        ${a.image_url ? `<img class="preview-img" src="${escapeHtml(a.image_url)}" alt="">` : ""}
        <h3 class="preview-title">${escapeHtml(a.title)}</h3>
        <p><strong>Date:</strong> ${escapeHtml(formatLongDate(a.achieved_on))}</p>
        ${a.description ? `<p class="preserve-lines">${escapeHtml(a.description)}</p>` : ""}
      </div>`;
  }
  return "";
}

document.querySelectorAll("[data-decision]").forEach(btn => btn.addEventListener("click", async () => {
  if (!reviewing) return;
  const decision = btn.dataset.decision;
  const note = $("review-note").value.trim();
  $("review-error").textContent = "";
  if (decision !== "approved" && !note) {
    $("review-error").textContent = "Please add a note explaining what needs to change or why it was rejected.";
    $("review-note").focus();
    return;
  }
  if (decision === "rejected") {
    const ok = await confirmDialog("Reject this request? The submitter will be notified with your note.", { title: "Reject", confirmText: "Reject", danger: true });
    if (!ok) return;
  }
  await withBusy(btn, "…", async () => {
    const { error } = await supabaseClient.rpc("review_submission", {
      p_kind: reviewing.kind,
      p_id: reviewing.id,
      p_decision: decision,
      p_note: note,
    });
    if (error) {
      $("review-error").textContent = friendlyError(error);
      return;
    }
    closeModalById("review-modal-overlay");
    showToast(decision === "approved" ? "Approved and published." : decision === "rejected" ? "Rejected." : "Sent back for changes.", "success");
    const { name } = currentSection();
    if (name === "overview") loadOverview(); else loadApprovals();
  });
}));

// ============================================================
// CLUBS
// ============================================================

let clubsCache = [];
let clubLeadersByClub = {};
let clubMemberCounts = {};

async function loadClubs() {
  const tbody = $("clubs-tbody");
  tbody.innerHTML = `<tr><td colspan="8">${loadingHtml()}</td></tr>`;
  await Promise.all([loadProfiles().catch(() => {}), loadCategoryNames()]);
  const [clubsRes, leadersRes, membersRes] = await Promise.all([
    supabaseClient.from("clubs").select("*").order("name"),
    supabaseClient.from("club_leaders").select("*").is("ended_at", null),
    supabaseClient.from("club_members").select("club_id").eq("status", "approved"),
  ]);
  if (clubsRes.error) {
    tbody.innerHTML = `<tr><td colspan="8">${errorStateHtml()}</td></tr>`;
    return;
  }
  clubsCache = clubsRes.data;
  clubLeadersByClub = {};
  (leadersRes.data || []).forEach(l => { (clubLeadersByClub[l.club_id] = clubLeadersByClub[l.club_id] || []).push(l); });
  clubMemberCounts = {};
  (membersRes.data || []).forEach(m => { clubMemberCounts[m.club_id] = (clubMemberCounts[m.club_id] || 0) + 1; });
  renderClubsTable();
}

function clubLeaderNames(clubId) {
  return (clubLeadersByClub[clubId] || [])
    .sort((a, b) => (a.position === "leader" ? -1 : 1) - (b.position === "leader" ? -1 : 1))
    .map(l => personName(l.user_id) + (l.position === "co_leader" ? " (co)" : ""));
}

function renderClubsTable() {
  const filter = $("clubs-status").value;
  const term = $("clubs-search").value.trim().toLowerCase();
  const rows = clubsCache.filter(c => {
    if (filter === "active" && c.status !== "approved") return false;
    if (filter === "suspended" && c.status !== "suspended") return false;
    if (filter === "archived" && c.status !== "archived") return false;
    if (filter === "requests" && !["pending", "changes_requested", "rejected"].includes(c.status)) return false;
    return !term || `${c.name} ${c.category} ${clubLeaderNames(c.id).join(" ")}`.toLowerCase().includes(term);
  });

  const tbody = $("clubs-tbody");
  tbody.innerHTML = "";
  $("clubs-empty").hidden = rows.length !== 0;
  rows.forEach(c => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(c.name)}</strong><br><span class="row-subtext">${escapeHtml(c.description.slice(0, 80))}</span></td>
      <td><span class="club-badge" data-category="${escapeHtml(c.category)}">${escapeHtml(c.category)}</span></td>
      <td>${escapeHtml(clubLeaderNames(c.id).join(", ") || "—")}</td>
      <td>${clubMemberCounts[c.id] || 0}</td>
      <td>${c.recruitment_open ? "Open" : "Closed"}</td>
      <td>${statusBadge(c.status)}</td>
      <td>${formatDate(c.created_at)}</td>
      <td><a class="btn btn-secondary btn-sm" href="#clubs/${c.id}">Manage</a></td>`;
    tbody.appendChild(tr);
  });
}

$("clubs-status").addEventListener("change", renderClubsTable);
$("clubs-search").addEventListener("input", renderClubsTable);

async function openClubModal(clubId) {
  const club = clubsCache.find(c => c.id === clubId);
  if (!club) {
    showToast("Club not found.", "error");
    history.replaceState(null, "", "#clubs");
    return;
  }
  const body = $("club-modal-body");
  $("club-modal-title").textContent = club.name;
  body.innerHTML = loadingHtml();
  openModal("club-modal-overlay");

  const [leadersRes, membersRes] = await Promise.all([
    supabaseClient.from("club_leaders").select("*").eq("club_id", clubId).order("started_at", { ascending: false }),
    supabaseClient.from("club_members").select("*").eq("club_id", clubId).order("joined_at", { ascending: false }),
  ]);
  const leaders = leadersRes.data || [];
  const members = membersRes.data || [];
  const activeLeaders = leaders.filter(l => !l.ended_at);
  const pastLeaders = leaders.filter(l => l.ended_at);
  const current = members.filter(m => m.status === "approved");
  const former = members.filter(m => m.status === "left");
  const managed = ["approved", "suspended", "archived"].includes(club.status);
  const students = Object.values(profilesById).filter(p => p.account_type === "student" && p.role !== "admin" && p.status === "active");

  body.innerHTML = `
    <div class="club-admin-grid">
      <section>
        <h3>Club information</h3>
        <form id="form-admin-club" novalidate>
          <div class="field"><label for="ac-name">Name</label><input type="text" id="ac-name" maxlength="80" value="${escapeHtml(club.name)}"></div>
          <div class="field"><label for="ac-category">Category</label>
            <select id="ac-category">${categoriesCache.map(c => `<option${c.name === club.category ? " selected" : ""}>${escapeHtml(c.name)}</option>`).join("")}</select></div>
          <div class="field"><label for="ac-description">Description</label><textarea id="ac-description" rows="4" maxlength="2000">${escapeHtml(club.description)}</textarea></div>
          <div class="field">
            <label>Logo</label>
            <div class="image-picker">
              <div class="image-picker-preview" id="ac-logo-preview"></div>
              <div class="image-picker-actions">
                <label class="btn btn-secondary btn-sm file-btn">Choose image<input type="file" id="ac-logo-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
                <button type="button" class="btn-link inline-link" id="ac-logo-remove" hidden>Remove</button>
              </div>
            </div>
          </div>
          <label class="checkbox-row"><input type="checkbox" id="ac-recruiting" ${club.recruitment_open ? "checked" : ""} ${club.status !== "approved" ? "disabled" : ""}> Recruitment open</label>
          <p class="form-error" id="ac-error"></p>
          <button type="submit" class="btn btn-primary btn-sm" id="ac-save">Save information</button>
        </form>

        <h3>Status: ${statusBadge(club.status)}</h3>
        <div class="button-row">
          ${managed && club.status !== "approved" ? `<button class="btn btn-secondary btn-sm" data-club-status="approved">Reactivate</button>` : ""}
          ${club.status === "approved" ? `<button class="btn btn-secondary btn-sm" data-club-status="suspended">Suspend</button>` : ""}
          ${managed && club.status !== "archived" ? `<button class="btn btn-secondary btn-sm" data-club-status="archived">Archive</button>` : ""}
          ${!managed ? `<span class="muted">This is still a request — decide it in the Approval Center.</span>` : ""}
          <a class="btn btn-secondary btn-sm" href="/index.html#/club/${club.id}" target="_blank" rel="noopener">Open public page</a>
          <button class="btn-danger" id="ac-delete">Delete club</button>
        </div>
      </section>

      <section>
        <h3>Leadership</h3>
        <div class="mini-list">
          ${activeLeaders.length === 0 ? '<p class="muted">No active leader.</p>' : activeLeaders.map(l => `
            <div class="mini-row">
              <span><strong>${escapeHtml(personName(l.user_id))}</strong> · ${l.position === "leader" ? "Leader" : "Co-leader"} since ${formatDate(l.started_at)}</span>
              <button class="btn-danger" data-end-leader="${l.id}">End</button>
            </div>`).join("")}
        </div>
        ${managed && club.status !== "archived" ? `
        <form class="assign-form" id="form-assign-leader">
          <select id="assign-user" class="admin-select" aria-label="Student">
            <option value="">Choose a student…</option>
            ${students.map(s => `<option value="${s.id}">${escapeHtml(fullName(s))}${s.graduation_year ? ` — ${escapeHtml(formatGradeLabel(s.graduation_year, s.class_section))}` : ""}</option>`).join("")}
          </select>
          <select id="assign-position" class="admin-select" aria-label="Position">
            <option value="leader">Leader (replaces current)</option>
            <option value="co_leader">Co-leader</option>
          </select>
          <button type="submit" class="btn btn-primary btn-sm">Assign</button>
        </form>` : ""}
        ${pastLeaders.length ? `<details><summary>Past leadership (${pastLeaders.length})</summary><div class="mini-list">${pastLeaders.map(l => `
          <div class="mini-row is-muted"><span>${escapeHtml(personName(l.user_id))} · ${l.position === "leader" ? "Leader" : "Co-leader"} · ${formatDate(l.started_at)} – ${formatDate(l.ended_at)}</span></div>`).join("")}</div></details>` : ""}

        <h3>Members (${current.length})</h3>
        <div class="mini-list scroll-list">
          ${current.length === 0 ? '<p class="muted">No members.</p>' : current.map(m => `
            <div class="mini-row"><span>${escapeHtml(personName(m.user_id))}</span><span class="muted">since ${formatDate(m.joined_at)}${m.leave_requested_at ? " · leave requested" : ""}</span></div>`).join("")}
        </div>
        ${former.length ? `<details><summary>Former members (${former.length})</summary><div class="mini-list scroll-list">${former.map(m => `
          <div class="mini-row is-muted"><span>${escapeHtml(personName(m.user_id))}</span><span>${formatDate(m.joined_at)} – ${formatDate(m.left_at)}</span></div>`).join("")}</div></details>` : ""}
      </section>
    </div>`;

  const logoPicker = setupImagePicker({
    input: $("ac-logo-input"), preview: $("ac-logo-preview"), removeBtn: $("ac-logo-remove"), folder: "logos", errorEl: $("ac-error"),
  });
  logoPicker.setUrl(club.logo_url);

  $("form-admin-club").addEventListener("submit", async e => {
    e.preventDefault();
    const errorEl = $("ac-error");
    errorEl.textContent = "";
    const name = $("ac-name").value.trim();
    const description = $("ac-description").value.trim();
    if (name.length < 2) { errorEl.textContent = "Name must be at least 2 characters."; return; }
    if (description.length < 10) { errorEl.textContent = "Description must be at least 10 characters."; return; }
    if (clubsCache.some(c => c.id !== club.id && c.name.toLowerCase() === name.toLowerCase() && !["rejected", "archived"].includes(c.status))) {
      errorEl.textContent = "Another club already uses this name.";
      return;
    }
    await withBusy($("ac-save"), "Saving…", async () => {
      let logoUrl;
      try { logoUrl = await logoPicker.getUrl(); } catch (err) { errorEl.textContent = friendlyError(err); return; }
      const { error } = await supabaseClient.from("clubs").update({
        name, description, category: $("ac-category").value, logo_url: logoUrl,
        recruitment_open: $("ac-recruiting").checked, updated_at: new Date().toISOString(),
      }).eq("id", club.id);
      if (error) { errorEl.textContent = friendlyError(error); return; }
      showToast("Club updated.", "success");
      await loadClubs();
      openClubModal(club.id);
    });
  });

  body.querySelectorAll("[data-club-status]").forEach(btn => btn.addEventListener("click", async () => {
    const status = btn.dataset.clubStatus;
    const verb = { approved: "Reactivate", suspended: "Suspend", archived: "Archive" }[status];
    const ok = await confirmDialog(`${verb} ${club.name}?${status !== "approved" ? " It will be hidden from the directory and recruitment will close. All history is kept." : ""}`, { title: `${verb} club`, confirmText: verb, danger: status !== "approved" });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("admin_set_club_status", { p_club: club.id, p_status: status });
      if (error) return showToast(friendlyError(error), "error");
      showToast(`Club ${status === "approved" ? "reactivated" : status}.`, "success");
      await loadClubs();
      openClubModal(club.id);
    });
  }));

  $("ac-delete").addEventListener("click", async () => {
    const ok = await confirmDialog(
      `Permanently delete "${club.name}"? This removes the club, its posts, events, applications and every member's history of it. This cannot be undone — consider archiving instead.`,
      { title: "Delete club", confirmText: "Delete permanently", danger: true });
    if (!ok) return;
    const { error } = await supabaseClient.from("clubs").delete().eq("id", club.id);
    if (error) return showToast(friendlyError(error), "error");
    closeModalById("club-modal-overlay");
    showToast("Club deleted.", "success");
    history.replaceState(null, "", "#clubs");
    loadClubs();
  });

  body.querySelectorAll("[data-end-leader]").forEach(btn => btn.addEventListener("click", async () => {
    const ok = await confirmDialog("End this leadership? The person stays a member of the club.", { title: "End leadership", confirmText: "End", danger: true });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("admin_end_leadership", { p_leader_row: btn.dataset.endLeader });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Leadership ended.", "success");
      await loadClubs();
      openClubModal(club.id);
    });
  }));

  const assignForm = $("form-assign-leader");
  if (assignForm) assignForm.addEventListener("submit", async e => {
    e.preventDefault();
    const userId = $("assign-user").value;
    const position = $("assign-position").value;
    if (!userId) return showToast("Choose a student first.", "error");
    const replacing = position === "leader" && activeLeaders.some(l => l.position === "leader" && l.user_id !== userId);
    const ok = await confirmDialog(
      `Make ${personName(userId)} ${position === "leader" ? "the leader" : "a co-leader"} of ${club.name}?${replacing ? " The current leader will step down (and stay a member)." : ""}`,
      { title: "Assign leader", confirmText: "Assign" });
    if (!ok) return;
    await withBusy(assignForm.querySelector("button"), "…", async () => {
      const { error } = await supabaseClient.rpc("admin_set_leader", { p_club: club.id, p_user: userId, p_position: position });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Leader assigned.", "success");
      await loadClubs();
      openClubModal(club.id);
    });
  });
}

$("club-modal-overlay").addEventListener("click", e => {
  if (e.target === $("club-modal-overlay")) history.replaceState(null, "", "#clubs");
});
document.querySelector('[data-close-modal="club-modal-overlay"]').addEventListener("click", () => history.replaceState(null, "", "#clubs"));

// ============================================================
// USERS
// ============================================================

let usersCache = [];
let activeLeaderUserIds = new Map(); // user_id -> [club names]
let usersShown = 50;

async function loadUsers() {
  const tbody = $("users-tbody");
  tbody.innerHTML = `<tr><td colspan="8">${loadingHtml()}</td></tr>`;
  try {
    usersCache = await loadProfiles();
  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="8">${errorStateHtml()}</td></tr>`;
    return;
  }
  const { data: leaders } = await supabaseClient.from("club_leaders").select("user_id, position, club:clubs(name)").is("ended_at", null);
  activeLeaderUserIds = new Map();
  (leaders || []).forEach(l => {
    const list = activeLeaderUserIds.get(l.user_id) || [];
    list.push(`${l.club ? l.club.name : "?"}${l.position === "co_leader" ? " (co)" : ""}`);
    activeLeaderUserIds.set(l.user_id, list);
  });
  renderUsersTable();
}

function renderUsersTable() {
  const type = $("users-type").value;
  const status = $("users-status").value;
  let term = $("users-search").value.trim().toLowerCase();
  let grade = null;
  let cls = null;
  const m = term.match(/^(?:grade\s*)?(\d{1,2})\s*([abc])?$/i);
  if (m) { grade = Number(m[1]); cls = m[2] ? m[2].toUpperCase() : null; term = ""; }

  const rows = usersCache.filter(p => {
    if (type === "admin" && p.role !== "admin") return false;
    if (type === "student" && (p.account_type !== "student" || p.role === "admin")) return false;
    if (type === "teacher" && p.account_type !== "teacher") return false;
    if (type === "leader" && !activeLeaderUserIds.has(p.id)) return false;
    if (status !== "all" && p.status !== status) return false;
    if (grade !== null && (!p.graduation_year || computeCurrentGrade(p.graduation_year) !== grade)) return false;
    if (cls && p.class_section !== cls) return false;
    return !term || `${fullName(p)} ${p.email}`.toLowerCase().includes(term);
  });

  const tbody = $("users-tbody");
  tbody.innerHTML = "";
  $("users-empty").hidden = rows.length !== 0;
  $("users-count").textContent = `${rows.length} account${rows.length === 1 ? "" : "s"}`;

  rows.slice(0, usersShown).forEach(p => {
    const isAdmin = p.role === "admin";
    const isSelf = currentAdmin && p.id === currentAdmin.id;
    const leads = activeLeaderUserIds.get(p.id);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><a href="/index.html#/student/${p.id}" target="_blank" rel="noopener">${escapeHtml(fullName(p))}</a>${leads ? `<br><span class="row-subtext">Leads: ${escapeHtml(leads.join(", "))}</span>` : ""}</td>
      <td>${escapeHtml(p.email)}</td>
      <td><span class="role-badge ${p.account_type}">${p.account_type}</span></td>
      <td>${p.account_type === "student" ? escapeHtml(formatGradeLabel(p.graduation_year, p.class_section) || "—") : "—"}</td>
      <td><span class="role-badge ${p.role}">${isAdmin ? "admin" : leads ? "club leader" : "standard"}</span></td>
      <td>${statusBadge(p.status)}</td>
      <td>${formatDate(p.created_at)}</td>
      <td class="pending-actions">
        <button class="btn btn-secondary btn-sm" data-edit-user="${p.id}">Edit</button>
        ${isAdmin || isSelf ? "" : `<button class="btn btn-secondary btn-sm" data-suspend-user="${p.id}">${p.status === "suspended" ? "Reactivate" : "Suspend"}</button>`}
        <button class="btn-danger" data-delete-user="${p.id}" ${isAdmin ? "disabled title=\"Admin accounts can't be deleted\"" : ""}>Delete</button>
      </td>`;
    tbody.appendChild(tr);
  });
  $("users-more-btn").hidden = rows.length <= usersShown;

  tbody.querySelectorAll("[data-edit-user]").forEach(btn => btn.addEventListener("click", () => openUserModal(btn.dataset.editUser)));
  tbody.querySelectorAll("[data-suspend-user]").forEach(btn => btn.addEventListener("click", () => toggleSuspend(btn.dataset.suspendUser, btn)));
  tbody.querySelectorAll("[data-delete-user]").forEach(btn => btn.addEventListener("click", async () => {
    const profile = profilesById[btn.dataset.deleteUser];
    const ok = await confirmDialog(
      `Permanently delete the account for ${fullName(profile)}? Their memberships, applications and notifications are deleted. Clubs they founded are kept. This cannot be undone.`,
      { title: "Delete account", confirmText: "Delete account", danger: true });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      try {
        await callAdminApi("/api/admin-delete-user", { userId: profile.id });
        showToast("Account deleted.", "success");
        loadUsers();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }));
}

["users-type", "users-status"].forEach(id => $(id).addEventListener("change", () => { usersShown = 50; renderUsersTable(); }));
$("users-search").addEventListener("input", () => { usersShown = 50; renderUsersTable(); });
$("users-more-btn").addEventListener("click", () => { usersShown += 50; renderUsersTable(); });

async function callAdminApi(path, body) {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error("Your session expired. Please log in again.");
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || (res.status === 404 ? "This action needs the server functions deployed on Vercel." : "Request failed."));
  }
}

async function toggleSuspend(userId, btn) {
  const p = profilesById[userId];
  const suspend = p.status !== "suspended";
  const ok = await confirmDialog(
    suspend
      ? `Suspend ${fullName(p)}? They will be signed out, can't log in, and can't take any actions until reactivated. Their data is kept.`
      : `Reactivate ${fullName(p)}'s account?`,
    { title: suspend ? "Suspend account" : "Reactivate account", confirmText: suspend ? "Suspend" : "Reactivate", danger: suspend });
  if (!ok) return;
  await withBusy(btn, "…", async () => {
    try {
      await callAdminApi("/api/admin-user-status", { userId, status: suspend ? "suspended" : "active" });
      showToast(suspend ? "Account suspended." : "Account reactivated.", "success");
      loadUsers();
    } catch (err) {
      showToast(err.message, "error");
    }
  });
}

let editingUserId = null;

function openUserModal(userId) {
  const p = profilesById[userId];
  editingUserId = userId;
  $("user-error").textContent = "";
  $("user-modal-title").textContent = `Edit ${fullName(p)}`;
  $("user-first").value = p.first_name;
  $("user-last").value = p.last_name;
  $("user-type").value = p.account_type;
  $("user-role").value = p.role;
  $("user-role").disabled = currentAdmin && p.id === currentAdmin.id;
  const grade = p.graduation_year ? computeCurrentGrade(p.graduation_year) : null;
  $("user-grade").value = grade === null ? "" : grade > 12 ? "grad" : String(grade);
  $("user-class").value = p.class_section || "";
  $("user-grade-row").hidden = p.account_type !== "student";
  const leads = activeLeaderUserIds.get(p.id);
  $("user-leadership").innerHTML = leads
    ? `<p class="muted">Currently leads: <strong>${escapeHtml(leads.join(", "))}</strong>. Manage leadership from each club's page.</p>`
    : "";
  openModal("user-modal-overlay");
}

$("user-type").addEventListener("change", () => { $("user-grade-row").hidden = $("user-type").value !== "student"; });

$("form-user").addEventListener("submit", async e => {
  e.preventDefault();
  const p = profilesById[editingUserId];
  const errorEl = $("user-error");
  errorEl.textContent = "";
  const first = $("user-first").value.trim();
  const last = $("user-last").value.trim();
  if (!first || !last) { errorEl.textContent = "First and last name are required."; return; }
  const accountType = $("user-type").value;
  const role = $("user-role").value;
  const gradeValue = $("user-grade").value;

  let graduationYear = null;
  let classSection = null;
  if (accountType === "student") {
    graduationYear = gradeValue === "grad" ? (p.graduation_year && computeCurrentGrade(p.graduation_year) > 12 ? p.graduation_year : getSchoolYear()) : gradeValue ? computeGraduationYear(Number(gradeValue)) : null;
    classSection = $("user-class").value || null;
  }

  if (accountType === "teacher" && activeLeaderUserIds.has(p.id)) {
    errorEl.textContent = "This person leads a club. End their leadership before changing them to a teacher account.";
    return;
  }
  if (role !== p.role) {
    const ok = await confirmDialog(
      role === "admin" ? `Give ${fullName(p)} full administrator access?` : `Remove administrator access from ${fullName(p)}?`,
      { title: "Change permissions", confirmText: "Confirm", danger: role === "admin" });
    if (!ok) return;
  }

  await withBusy($("user-save-btn"), "Saving…", async () => {
    const { error } = await supabaseClient.from("profiles").update({
      first_name: first, last_name: last, account_type: accountType, role,
      graduation_year: graduationYear, class_section: classSection,
    }).eq("id", p.id);
    if (error) { errorEl.textContent = friendlyError(error); return; }
    closeModalById("user-modal-overlay");
    showToast("Account updated.", "success");
    loadUsers();
  });
});

// ============================================================
// CATEGORIES
// ============================================================

async function loadCategories() {
  const tbody = $("categories-tbody");
  tbody.innerHTML = `<tr><td colspan="4">${loadingHtml()}</td></tr>`;
  const [cats, clubs] = await Promise.all([loadCategoryNames(), supabaseClient.from("clubs").select("category")]);
  const counts = {};
  (clubs.data || []).forEach(c => { counts[c.category] = (counts[c.category] || 0) + 1; });
  tbody.innerHTML = "";
  cats.forEach(c => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="text" class="admin-search inline-input" value="${escapeHtml(c.name)}" maxlength="40" data-cat-name aria-label="Category name"></td>
      <td>${counts[c.name] || 0}</td>
      <td><input type="number" class="admin-search inline-input narrow" value="${c.sort_order}" data-cat-order aria-label="Sort order"></td>
      <td class="pending-actions">
        <button class="btn btn-secondary btn-sm" data-cat-save>Save</button>
        <button class="btn-danger" data-cat-delete ${counts[c.name] ? `disabled title="Move its clubs to another category first"` : ""}>Delete</button>
      </td>`;
    tr.querySelector("[data-cat-save]").addEventListener("click", async e => {
      const name = tr.querySelector("[data-cat-name]").value.trim();
      const order = Number(tr.querySelector("[data-cat-order]").value) || 0;
      if (!name) return showToast("Category name can't be empty.", "error");
      await withBusy(e.currentTarget, "…", async () => {
        // renaming cascades to every club using the category
        const { error } = await supabaseClient.from("club_categories").update({ name, sort_order: order }).eq("name", c.name);
        if (error) return showToast(friendlyError(error), "error");
        showToast("Category saved.", "success");
        loadCategories();
      });
    });
    tr.querySelector("[data-cat-delete]").addEventListener("click", async e => {
      const ok = await confirmDialog(`Delete the category "${c.name}"?`, { title: "Delete category", confirmText: "Delete", danger: true });
      if (!ok) return;
      await withBusy(e.currentTarget, "…", async () => {
        const { error } = await supabaseClient.from("club_categories").delete().eq("name", c.name);
        if (error) return showToast(/foreign key/i.test(error.message) ? "This category is still used by clubs." : friendlyError(error), "error");
        showToast("Category deleted.", "success");
        loadCategories();
      });
    });
    tbody.appendChild(tr);
  });
}

$("form-category").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("category-error");
  errorEl.textContent = "";
  const name = $("category-name").value.trim();
  if (!name) { errorEl.textContent = "Enter a category name."; return; }
  if (categoriesCache.some(c => c.name.toLowerCase() === name.toLowerCase())) { errorEl.textContent = "That category already exists."; return; }
  const maxOrder = Math.max(0, ...categoriesCache.map(c => c.sort_order));
  const { error } = await supabaseClient.from("club_categories").insert({ name, sort_order: maxOrder + 1 });
  if (error) { errorEl.textContent = friendlyError(error); return; }
  $("category-name").value = "";
  showToast("Category added.", "success");
  loadCategories();
});

// ============================================================
// SCHOOL-WIDE ANNOUNCEMENTS
// ============================================================

let announcementsCache = [];
const announcementImagePicker = setupImagePicker({
  input: $("announcement-image-input"),
  preview: $("announcement-image-preview"),
  removeBtn: $("announcement-image-remove"),
  folder: "announcements",
  errorEl: $("announcement-error"),
});

async function loadAnnouncements() {
  const { data, error } = await supabaseClient.from("announcements").select("*").order("created_at", { ascending: false });
  if (error) { console.error(error); return; }
  announcementsCache = data;
  renderAnnouncementsTable();
}

function renderAnnouncementsTable() {
  const term = $("announcements-search").value.trim().toLowerCase();
  const rows = term
    ? announcementsCache.filter(a => a.title.toLowerCase().includes(term) || (a.description || "").toLowerCase().includes(term))
    : announcementsCache;

  const tbody = $("announcements-tbody");
  tbody.innerHTML = "";
  $("announcements-empty").hidden = rows.length !== 0;

  rows.forEach(a => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(a.title)}</strong><br><span class="row-subtext">${escapeHtml((a.description || "").slice(0, 80))}</span></td>
      <td>${a.event_date ? formatDateTime(a.event_date) : "—"}</td>
      <td>${formatDate(a.created_at)}</td>
      <td><button class="btn-danger">Delete</button></td>`;
    tr.querySelector("button").addEventListener("click", async e => {
      const ok = await confirmDialog(`Delete the announcement "${a.title}"?`, { title: "Delete announcement", confirmText: "Delete", danger: true });
      if (!ok) return;
      await withBusy(e.currentTarget, "…", async () => {
        const { error } = await supabaseClient.from("announcements").delete().eq("id", a.id);
        if (error) return showToast(friendlyError(error), "error");
        showToast("Announcement deleted.", "success");
        loadAnnouncements();
      });
    });
    tbody.appendChild(tr);
  });
}

$("announcements-search").addEventListener("input", renderAnnouncementsTable);

$("new-announcement-btn").addEventListener("click", () => {
  $("announcement-error").textContent = "";
  $("form-announcement").reset();
  announcementImagePicker.setUrl(null);
  openModal("announcement-modal-overlay");
});
$("announcement-modal-close-btn").addEventListener("click", () => closeModalById("announcement-modal-overlay"));
$("announcement-modal-cancel-btn").addEventListener("click", () => closeModalById("announcement-modal-overlay"));

$("form-announcement").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("announcement-error");
  errorEl.textContent = "";
  const title = $("announcement-title").value.trim();
  const dateValue = $("announcement-date").value;
  const description = $("announcement-description").value.trim();
  if (!title) { errorEl.textContent = "Title is required."; return; }

  await withBusy($("announcement-submit-btn"), "Posting…", async () => {
    let imageUrl;
    try { imageUrl = await announcementImagePicker.getUrl(); } catch (err) { errorEl.textContent = friendlyError(err); return; }
    const { error } = await supabaseClient.from("announcements").insert({
      title,
      description,
      event_date: dateValue ? new Date(dateValue).toISOString() : null,
      image_url: imageUrl,
      created_by: currentAdmin.id,
    });
    if (error) { errorEl.textContent = friendlyError(error); return; }
    closeModalById("announcement-modal-overlay");
    showToast("Announcement posted.", "success");
    loadAnnouncements();
  });
});

// ============================================================
// BOOT
// ============================================================

(async function boot() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "/index.html";
    return;
  }
  const { data: profile, error } = await supabaseClient.from("profiles").select("*").eq("id", session.user.id).single();
  if (error || !profile || profile.role !== "admin" || profile.status !== "active") {
    window.location.href = "/index.html";
    return;
  }

  currentAdmin = profile;
  $("profile-btn").textContent = initials(profile);
  $("profile-menu-name").textContent = fullName(profile);
  $("profile-menu-email").textContent = profile.email;
  await loadCategoryNames();
  showSection();
  setInterval(() => { if (document.visibilityState === "visible") updatePendingBadge(); }, 60000);
})();
