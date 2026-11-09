// Leader Dashboard (#/lead/<clubId>/<tab>). Loaded after script.js and uses
// its helpers ($, currentUser, navigate, renderQuestionnaireForm, ...).
//
// Everything here only *requests* changes. The database functions check
// that the caller really leads the club, and anything public (posts,
// events, achievements, profile edits, recruitment forms) waits for an
// administrator's approval.

const LEAD_TABS = ["overview", "applications", "members", "recruitment", "posts", "achievements", "profile"];
const QUESTION_TYPES = {
  short_text: "Short answer",
  long_text: "Long answer",
  single_choice: "Multiple choice (one answer)",
  multi_choice: "Checkboxes (several answers)",
};

const lead = {
  clubId: null,
  tab: "overview",
  data: null,          // everything loaded for the selected club
  appFilter: "pending",
  appSearch: "",
  builder: null,       // questionnaire being edited { title, intro, questions: [...] }
  builderDirty: false,
};

const leadPanel = $("lead-panel");
const leadTabButtons = document.querySelectorAll("[data-lead-tab]");

leadTabButtons.forEach(btn => btn.addEventListener("click", () => {
  if (!confirmLeaveBuilder()) return;
  selectLeadTab(btn.dataset.leadTab);
  history.replaceState(null, "", `#/lead/${lead.clubId}/${lead.tab}`);
}));

$("lead-club-select").addEventListener("change", e => {
  if (!confirmLeaveBuilder()) {
    e.target.value = lead.clubId;
    return;
  }
  navigate(`#/lead/${e.target.value}/${lead.tab}`);
});

function confirmLeaveBuilder() {
  if (lead.tab === "recruitment" && lead.builderDirty) {
    return window.confirm("You have unsaved changes to the recruitment form. Leave without saving?");
  }
  return true;
}

window.addEventListener("beforeunload", e => {
  if (lead.tab === "recruitment" && lead.builderDirty && $("view-lead").classList.contains("active")) {
    e.preventDefault();
    e.returnValue = "";
  }
});

function selectLeadTab(tab) {
  lead.tab = LEAD_TABS.includes(tab) ? tab : "overview";
  leadTabButtons.forEach(b => b.classList.toggle("active", b.dataset.leadTab === lead.tab));
  renderLeadTab();
}

async function showLeaderDashboard(clubIdParam, tab) {
  const leads = currentUser.leaderships;
  const select = $("lead-club-select");
  select.innerHTML = leads.map(l => `<option value="${l.club_id}">${escapeHtml(l.club.name)}</option>`).join("");
  select.hidden = leads.length < 2;

  const chosen = leads.find(l => l.club_id === clubIdParam) || leads[0];
  if (clubIdParam && chosen.club_id !== clubIdParam) {
    showToast("You don't lead that club.", "error");
  }
  select.value = chosen.club_id;
  $("lead-view-club-link").href = `#/club/${chosen.club_id}`;

  const clubChanged = lead.clubId !== chosen.club_id;
  lead.clubId = chosen.club_id;
  if (clubChanged) {
    lead.builder = null;
    lead.builderDirty = false;
  }
  lead.tab = LEAD_TABS.includes(tab) ? tab : "overview";
  leadTabButtons.forEach(b => b.classList.toggle("active", b.dataset.leadTab === lead.tab));

  leadPanel.innerHTML = loadingHtml("Loading your club…");
  await loadLeadData();
  renderLeadTab();
}

async function loadLeadData() {
  const id = lead.clubId;
  const [club, members, formerMembers, apps, posts, achievements, forms, changes, leaders] = await Promise.all([
    supabaseClient.from("clubs").select("*").eq("id", id).single(),
    supabaseClient.from("club_members")
      .select("*, profile:profiles(id, first_name, last_name, graduation_year, class_section)")
      .eq("club_id", id).eq("status", "approved").order("joined_at"),
    supabaseClient.from("club_members")
      .select("*, profile:profiles(id, first_name, last_name)")
      .eq("club_id", id).eq("status", "left").order("left_at", { ascending: false }).limit(200),
    supabaseClient.from("applications")
      .select("*, profile:profiles!applications_user_id_fkey(id, first_name, last_name, graduation_year, class_section)")
      .eq("club_id", id).order("submitted_at", { ascending: false }),
    supabaseClient.from("club_posts")
      .select("*, photos:club_post_photos(url, position)")
      .eq("club_id", id).order("submitted_at", { ascending: false }),
    supabaseClient.from("club_achievements").select("*").eq("club_id", id).order("achieved_on", { ascending: false }),
    supabaseClient.from("questionnaires")
      .select("*, questions:questionnaire_questions(*)")
      .eq("club_id", id).order("version", { ascending: false }),
    supabaseClient.from("club_change_requests").select("*").eq("club_id", id).order("submitted_at", { ascending: false }).limit(10),
    supabaseClient.from("club_leaders").select("user_id, position").eq("club_id", id).is("ended_at", null),
  ]);

  if (club.error) {
    leadPanel.innerHTML = errorStateHtml("Couldn't load this club. Please refresh.");
    lead.data = null;
    return;
  }
  (forms.data || []).forEach(f => f.questions.sort((a, b) => a.position - b.position));
  lead.data = {
    club: club.data,
    members: members.data || [],
    formerMembers: formerMembers.data || [],
    applications: apps.data || [],
    posts: posts.data || [],
    achievements: achievements.data || [],
    forms: forms.data || [],
    changes: changes.data || [],
    leaderIds: new Map((leaders.data || []).map(l => [l.user_id, l.position])),
  };
}

async function reloadLead() {
  await loadLeadData();
  renderLeadTab();
  refreshLeaderBadge();
}

function renderLeadTab() {
  if (!lead.data) return;
  const d = lead.data;
  const pendingApps = d.applications.filter(a => a.status === "pending").length;
  const leaveReqs = d.members.filter(m => m.leave_requested_at).length;
  $("lead-tab-apps-count").textContent = pendingApps ? pendingApps : "";
  $("lead-tab-members-count").textContent = leaveReqs ? leaveReqs : "";

  const banner = d.club.status !== "approved"
    ? `<div class="notice notice-warn">${icon("shield")}This club is <strong>${escapeHtml(STATUS_LABELS[d.club.status] || d.club.status)}</strong>. Recruiting and new posts are disabled until an administrator reactivates it.</div>`
    : "";

  const renderers = {
    overview: renderLeadOverview,
    applications: renderLeadApplications,
    members: renderLeadMembers,
    recruitment: renderLeadRecruitment,
    posts: renderLeadPosts,
    achievements: renderLeadAchievements,
    profile: renderLeadProfile,
  };
  leadPanel.innerHTML = banner;
  const body = document.createElement("div");
  leadPanel.appendChild(body);
  renderers[lead.tab](body, d);
}

function liveForm(d) { return d.forms.find(f => f.status === "approved") || null; }
function workingForm(d) { return d.forms.find(f => ["draft", "pending", "changes_requested"].includes(f.status)) || null; }

// ---------- overview ----------

function renderLeadOverview(el, d) {
  const pendingApps = d.applications.filter(a => a.status === "pending").length;
  const leaveReqs = d.members.filter(m => m.leave_requested_at).length;
  const awaiting = d.posts.filter(p => p.status === "pending").length
    + d.achievements.filter(a => a.status === "pending").length
    + d.forms.filter(f => f.status === "pending").length
    + d.changes.filter(c => c.status === "pending").length;
  const returned = d.posts.filter(p => p.status === "changes_requested").length
    + d.achievements.filter(a => a.status === "changes_requested").length
    + d.forms.filter(f => f.status === "changes_requested").length
    + d.changes.filter(c => c.status === "changes_requested").length;
  const today = todayDateStr();
  const upcoming = d.posts.filter(p => p.kind === "event" && p.status === "approved" && p.event_date >= today);
  const live = liveForm(d);

  el.innerHTML = `
    <div class="lead-header">
      <span class="lead-logo" data-category="${escapeHtml(d.club.category)}">${clubLogoHtml(d.club)}</span>
      <div>
        <h3 class="lead-club-name">${escapeHtml(d.club.name)}</h3>
        <span class="club-badge" data-category="${escapeHtml(d.club.category)}">${escapeHtml(d.club.category)}</span>
      </div>
    </div>

    <div class="stat-grid">
      <a class="stat-tile" href="#/lead/${d.club.id}/members"><span class="stat-tile-value">${d.members.length}</span><span class="stat-tile-label">Current members</span></a>
      <a class="stat-tile${pendingApps ? " is-attention" : ""}" href="#/lead/${d.club.id}/applications"><span class="stat-tile-value">${pendingApps}</span><span class="stat-tile-label">Pending applications</span></a>
      <a class="stat-tile${leaveReqs ? " is-attention" : ""}" href="#/lead/${d.club.id}/members"><span class="stat-tile-value">${leaveReqs}</span><span class="stat-tile-label">Leave requests</span></a>
      <a class="stat-tile" href="#/lead/${d.club.id}/posts"><span class="stat-tile-value">${awaiting}</span><span class="stat-tile-label">Awaiting approval</span></a>
      <a class="stat-tile${returned ? " is-attention" : ""}" href="#/lead/${d.club.id}/posts"><span class="stat-tile-value">${returned}</span><span class="stat-tile-label">Returned for changes</span></a>
      <a class="stat-tile" href="#/lead/${d.club.id}/posts"><span class="stat-tile-value">${upcoming.length}</span><span class="stat-tile-label">Upcoming events</span></a>
    </div>

    <div class="lead-section">
      <h3>Recruitment</h3>
      ${recruitmentToggleHtml(d, live)}
    </div>

    <div class="lead-section">
      <h3>Quick actions</h3>
      <div class="quick-actions">
        <button class="btn btn-secondary btn-sm btn-with-icon" data-quick="event">${icon("calendar")}Announce an event</button>
        <button class="btn btn-secondary btn-sm btn-with-icon" data-quick="event_result">${icon("image")}Post event results</button>
        <button class="btn btn-secondary btn-sm btn-with-icon" data-quick="announcement">${icon("megaphone")}Club announcement</button>
        <button class="btn btn-secondary btn-sm btn-with-icon" data-quick="achievement">${icon("trophy")}Add achievement</button>
      </div>
    </div>
  `;
  wireRecruitmentToggle(el, d);
  el.querySelectorAll("[data-quick]").forEach(btn => btn.addEventListener("click", () => {
    if (btn.dataset.quick === "achievement") openAchievementModal();
    else openPostModal(btn.dataset.quick);
  }));
}

function recruitmentToggleHtml(d, live) {
  const open = d.club.recruitment_open;
  const canOpen = !!live && d.club.status === "approved";
  return `
    <div class="recruit-box">
      <div>
        <strong>${open ? "Recruitment is open" : "Recruitment is closed"}</strong>
        <p class="muted">${open
          ? "Students can see the Apply button and fill in your approved form."
          : canOpen ? "Open recruitment to let students apply with your approved form."
          : "You can open recruitment once an administrator approves your recruitment form."}</p>
      </div>
      <button class="btn ${open ? "btn-secondary" : "btn-primary"} btn-sm" data-toggle-recruitment ${!open && !canOpen ? "disabled" : ""}>
        ${open ? "Close recruitment" : "Open recruitment"}
      </button>
    </div>`;
}

function wireRecruitmentToggle(el, d) {
  const btn = el.querySelector("[data-toggle-recruitment]");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    const open = !d.club.recruitment_open;
    if (!open) {
      const ok = await confirmDialog("Close recruitment? Pending applications stay open for you to review.", { title: "Close recruitment", confirmText: "Close" });
      if (!ok) return;
    }
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("set_recruitment", { p_club: d.club.id, p_open: open });
      if (error) return showToast(friendlyError(error), "error");
      showToast(open ? "Recruitment is now open." : "Recruitment closed.", "success");
      reloadLead();
    });
  });
}

// ---------- applications ----------

function renderLeadApplications(el, d) {
  const counts = { pending: 0, accepted: 0, rejected: 0, withdrawn: 0 };
  d.applications.forEach(a => { counts[a.status] = (counts[a.status] || 0) + 1; });
  const term = lead.appSearch.toLowerCase();
  const rows = d.applications.filter(a =>
    (lead.appFilter === "all" || a.status === lead.appFilter) &&
    (!term || fullName(a.profile).toLowerCase().includes(term)));

  el.innerHTML = `
    <div class="lead-toolbar">
      <div class="segmented" id="lead-app-filter">
        ${["pending", "accepted", "rejected", "withdrawn", "all"].map(s => `
          <button class="segmented-btn${lead.appFilter === s ? " active" : ""}" data-filter="${s}">${s === "all" ? "All" : STATUS_LABELS[s]}${s !== "all" ? ` <span class="count">${counts[s] || 0}</span>` : ""}</button>`).join("")}
      </div>
      <div class="search-box small-search">
        ${icon("users")}
        <input type="search" id="lead-app-search" placeholder="Search applicants..." value="${escapeHtml(lead.appSearch)}" aria-label="Search applicants">
      </div>
    </div>
    <div class="lead-list" id="lead-app-list">
      ${rows.length === 0 ? `<p class="empty-state">${lead.appFilter === "pending" ? "No pending applications." : "No applications here."}</p>` : rows.map(a => `
        <div class="lead-row">
          <span class="member-row-avatar">${escapeHtml(initials(a.profile))}</span>
          <div class="lead-row-main">
            <strong>${escapeHtml(fullName(a.profile))}</strong>
            <span class="muted">${escapeHtml(formatGradeLabel(a.profile && a.profile.graduation_year, a.profile && a.profile.class_section))} · applied ${formatShortDate(a.submitted_at)}</span>
          </div>
          ${statusBadge(a.status)}
          <button class="btn btn-secondary btn-sm" data-open-app="${a.id}">${a.status === "pending" ? "Review" : "View"}</button>
        </div>`).join("")}
    </div>`;

  el.querySelectorAll("#lead-app-filter [data-filter]").forEach(btn => btn.addEventListener("click", () => {
    lead.appFilter = btn.dataset.filter;
    renderLeadTab();
  }));
  const search = el.querySelector("#lead-app-search");
  search.addEventListener("input", () => {
    lead.appSearch = search.value;
    const pos = search.selectionStart;
    renderLeadTab();
    const again = $("lead-app-search");
    again.focus();
    again.setSelectionRange(pos, pos);
  });
  el.querySelectorAll("[data-open-app]").forEach(btn => btn.addEventListener("click", () => openApplicationModal(btn.dataset.openApp)));
}

function formatAnswer(a) {
  if (a.answer === null || a.answer === undefined || (Array.isArray(a.answer) && a.answer.length === 0)) {
    return '<span class="muted">No answer</span>';
  }
  if (Array.isArray(a.answer)) return `<ul class="answer-list">${a.answer.map(v => `<li>${escapeHtml(v)}</li>`).join("")}</ul>`;
  return `<span class="preserve-lines">${escapeHtml(a.answer)}</span>`;
}

async function openApplicationModal(appId) {
  const app = lead.data.applications.find(a => a.id === appId);
  if (!app) return;
  const body = $("application-modal-body");
  body.innerHTML = loadingHtml("Loading application…");
  $("application-modal-title").textContent = `Application — ${fullName(app.profile)}`;
  openModal("application-modal-overlay");

  const [answersRes, historyRes, noteRes] = await Promise.all([
    supabaseClient.from("application_answers").select("*").eq("application_id", appId).order("position"),
    supabaseClient.from("application_status_history").select("*").eq("application_id", appId).order("changed_at"),
    supabaseClient.from("application_notes").select("*").eq("application_id", appId).maybeSingle(),
  ]);
  const answers = answersRes.data || [];
  const history = historyRes.data || [];
  const note = noteRes.data ? noteRes.data.note : "";
  const isPending = app.status === "pending";

  body.innerHTML = `
    <div class="app-detail-head">
      <span class="profile-header-avatar small">${escapeHtml(initials(app.profile))}</span>
      <div>
        <strong>${escapeHtml(fullName(app.profile))}</strong>
        <span class="muted">${escapeHtml(formatGradeLabel(app.profile.graduation_year, app.profile.class_section))}</span>
        <a class="inline-link" href="#/student/${app.user_id}" data-close-app>View public profile &amp; club history →</a>
      </div>
      ${statusBadge(app.status)}
    </div>
    <p class="muted">Submitted ${escapeHtml(formatDateTime(app.submitted_at))}</p>

    <div class="answers">
      ${app.message ? `<div class="answer"><span class="answer-q">Message</span><span class="preserve-lines">${escapeHtml(app.message)}</span></div>` : ""}
      ${answers.map((a, i) => `<div class="answer"><span class="answer-q">${i + 1}. ${escapeHtml(a.question_label)}</span>${formatAnswer(a)}</div>`).join("")}
      ${answers.length === 0 && !app.message ? '<p class="muted">This application has no answers (it was submitted before recruitment forms existed).</p>' : ""}
    </div>

    <div class="field">
      <label for="app-note">Internal note <span class="optional">(only club leaders and administrators can see this)</span></label>
      <textarea id="app-note" rows="2" maxlength="2000">${escapeHtml(note)}</textarea>
      <button class="btn btn-secondary btn-sm" id="app-note-save">Save note</button>
    </div>

    ${history.length ? `<details class="status-history"><summary>Status history</summary><ul>${history.map(h => `
      <li>${h.from_status ? `${escapeHtml(STATUS_LABELS[h.from_status] || h.from_status)} → ` : ""}<strong>${escapeHtml(STATUS_LABELS[h.to_status] || h.to_status)}</strong> · ${escapeHtml(formatDateTime(h.changed_at))}</li>`).join("")}</ul></details>` : ""}

    <p class="form-error" id="app-error" role="alert"></p>
    <div class="modal-actions">
      <button class="btn btn-secondary" data-close-modal-inline>Close</button>
      ${isPending ? `
        <button class="btn btn-danger-solid" id="app-reject">Reject</button>
        <button class="btn btn-primary" id="app-accept">Accept</button>` : ""}
    </div>`;

  body.querySelector("[data-close-modal-inline]").addEventListener("click", () => closeModalById("application-modal-overlay"));
  body.querySelector("[data-close-app]").addEventListener("click", () => closeModalById("application-modal-overlay"));
  $("app-note-save").addEventListener("click", async e => {
    await withBusy(e.currentTarget, "Saving…", async () => {
      const { error } = await supabaseClient.rpc("save_application_note", { p_application: appId, p_note: $("app-note").value });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Note saved.", "success");
    });
  });

  if (isPending) {
    const decide = async (decision, btn) => {
      const name = fullName(app.profile);
      const ok = await confirmDialog(
        decision === "accepted" ? `Accept ${name} into ${lead.data.club.name}? They become a member right away.` : `Reject ${name}'s application?`,
        { title: decision === "accepted" ? "Accept application" : "Reject application", confirmText: decision === "accepted" ? "Accept" : "Reject", danger: decision !== "accepted" });
      if (!ok) return;
      await withBusy(btn, "…", async () => {
        const { error } = await supabaseClient.rpc("decide_application", { p_application: appId, p_decision: decision });
        if (error) {
          $("app-error").textContent = friendlyError(error);
          return;
        }
        closeModalById("application-modal-overlay");
        showToast(decision === "accepted" ? `${name} is now a member.` : "Application rejected.", "success");
        reloadLead();
      });
    };
    $("app-accept").addEventListener("click", e => decide("accepted", e.currentTarget));
    $("app-reject").addEventListener("click", e => decide("rejected", e.currentTarget));
  }
}

// ---------- members ----------

function renderLeadMembers(el, d) {
  const requests = d.members.filter(m => m.leave_requested_at);
  el.innerHTML = `
    ${requests.length ? `
      <div class="lead-section">
        <h3>Leave requests</h3>
        <div class="lead-list">${requests.map(m => `
          <div class="lead-row">
            <span class="member-row-avatar">${escapeHtml(initials(m.profile))}</span>
            <div class="lead-row-main">
              <strong>${escapeHtml(fullName(m.profile))}</strong>
              <span class="muted">Asked to leave on ${formatShortDate(m.leave_requested_at)} · member since ${formatShortDate(m.joined_at)}</span>
            </div>
            <button class="btn btn-secondary btn-sm" data-leave-decline="${m.id}">Decline</button>
            <button class="btn-approve" data-leave-approve="${m.id}">Confirm leave</button>
          </div>`).join("")}</div>
      </div>` : ""}

    <div class="lead-section">
      <h3>Current members (${d.members.length})</h3>
      <div class="lead-list">${d.members.length === 0 ? '<p class="empty-state">No members yet.</p>' : d.members.map(m => {
        const pos = d.leaderIds.get(m.user_id);
        return `
          <div class="lead-row">
            <span class="member-row-avatar">${escapeHtml(initials(m.profile))}</span>
            <div class="lead-row-main">
              <a href="#/student/${m.user_id}"><strong>${escapeHtml(fullName(m.profile))}</strong></a>
              <span class="muted">${escapeHtml(formatGradeLabel(m.profile.graduation_year, m.profile.class_section))} · joined ${formatLongDate(m.joined_at)}</span>
            </div>
            ${pos ? `<span class="member-owner-tag">${pos === "leader" ? "Leader" : "Co-leader"}</span>` : `<button class="btn-danger" data-remove-member="${m.id}">Remove</button>`}
          </div>`;
      }).join("")}</div>
    </div>

    ${d.formerMembers.length ? `
      <details class="lead-section former-members">
        <summary>Former members (${d.formerMembers.length})</summary>
        <div class="lead-list">${d.formerMembers.map(m => `
          <div class="lead-row is-muted">
            <span class="member-row-avatar">${escapeHtml(initials(m.profile))}</span>
            <div class="lead-row-main">
              <a href="#/student/${m.user_id}"><strong>${escapeHtml(fullName(m.profile))}</strong></a>
              <span class="muted">${formatLongDate(m.joined_at)} – ${formatLongDate(m.left_at)}${m.end_reason === "removed" ? " · removed" : ""}</span>
            </div>
          </div>`).join("")}</div>
      </details>` : ""}
    <p class="muted small-note">Leadership changes are handled by an administrator.</p>
  `;

  const memberName = id => fullName((d.members.find(m => m.id === id) || {}).profile);

  el.querySelectorAll("[data-leave-approve]").forEach(btn => btn.addEventListener("click", async () => {
    const ok = await confirmDialog(`End ${memberName(btn.dataset.leaveApprove)}'s membership? It stays on their club history.`, { title: "Confirm leave", confirmText: "Confirm" });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("decide_leave", { p_membership: btn.dataset.leaveApprove, p_approve: true });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Membership ended.", "success");
      reloadLead();
    });
  }));
  el.querySelectorAll("[data-leave-decline]").forEach(btn => btn.addEventListener("click", async () => {
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("decide_leave", { p_membership: btn.dataset.leaveDecline, p_approve: false });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Leave request declined.", "success");
      reloadLead();
    });
  }));
  el.querySelectorAll("[data-remove-member]").forEach(btn => btn.addEventListener("click", async () => {
    const ok = await confirmDialog(`Remove ${memberName(btn.dataset.removeMember)} from ${d.club.name}? Their past membership stays on their history.`, { title: "Remove member", confirmText: "Remove", danger: true });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("remove_member", { p_membership: btn.dataset.removeMember });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Member removed.", "success");
      reloadLead();
    });
  }));
}

// ---------- recruitment questionnaire builder ----------

function newQuestion(type = "short_text") {
  return { type, label: "", help_text: "", required: true, options: type.endsWith("choice") ? ["", ""] : [] };
}

function builderFromForm(form) {
  if (!form) {
    return {
      title: "Application form",
      intro: "",
      questions: [
        { type: "long_text", label: "Why do you want to join this club?", help_text: "", required: true, options: [] },
      ],
    };
  }
  return {
    title: form.title,
    intro: form.intro,
    questions: form.questions.map(q => ({
      type: q.type, label: q.label, help_text: q.help_text, required: q.required,
      options: Array.isArray(q.options) ? q.options.slice() : [],
    })),
  };
}

function renderLeadRecruitment(el, d) {
  const live = liveForm(d);
  const working = workingForm(d);
  const latestRejected = d.forms.find(f => f.status === "rejected");
  // working copy if there is one, else start from the live form (or the
  // most recent rejected one, so its feedback can be addressed)
  if (!lead.builder) {
    lead.builder = builderFromForm(working || live || latestRejected || null);
    lead.builderDirty = false;
  }
  const b = lead.builder;

  let statusHtml;
  if (working && working.status === "pending") {
    statusHtml = `<div class="notice">${icon("clock")}Version ${working.version} is <strong>waiting for administrator approval</strong> (submitted ${formatShortDate(working.submitted_at)}). Saving changes will take it out of the review queue until you submit again.</div>`;
  } else if (working && working.status === "changes_requested") {
    statusHtml = `<div class="notice notice-warn">${icon("edit")}An administrator asked for changes to version ${working.version}:<br><strong>${escapeHtml(working.review_note)}</strong></div>`;
  } else if (working) {
    statusHtml = `<div class="notice">${icon("edit")}Version ${working.version} is a <strong>draft</strong>. Submit it for approval when it's ready.</div>`;
  } else if (latestRejected && (!live || latestRejected.version > live.version)) {
    statusHtml = `<div class="notice notice-warn">${icon("x")}Version ${latestRejected.version} was rejected: <strong>${escapeHtml(latestRejected.review_note)}</strong> You can edit it below and submit a new version.</div>`;
  } else {
    statusHtml = "";
  }

  el.innerHTML = `
    <div class="lead-section">
      <h3>Status</h3>
      ${live ? `<p>Live form: <strong>version ${live.version}</strong>, approved ${formatShortDate(live.reviewed_at)} · ${live.questions.length} question${live.questions.length === 1 ? "" : "s"}</p>`
        : `<p class="muted">No approved form yet — students can't apply until one is approved.</p>`}
      ${recruitmentToggleHtml(d, live)}
      ${statusHtml}
    </div>

    <div class="lead-section">
      <h3>${working ? `Edit version ${working.version}` : live ? "Create a new version" : "Create your recruitment form"}</h3>
      <div class="field">
        <label for="qb-title">Form title</label>
        <input type="text" id="qb-title" maxlength="120" value="${escapeHtml(b.title)}">
      </div>
      <div class="field">
        <label for="qb-intro">Introduction (optional)</label>
        <textarea id="qb-intro" rows="2" maxlength="2000" placeholder="Tell applicants what you're looking for...">${escapeHtml(b.intro)}</textarea>
      </div>
      <div class="q-builder" id="qb-questions"></div>
      <div class="q-add-row">
        <span class="muted">Add question:</span>
        ${Object.entries(QUESTION_TYPES).map(([t, label]) => `<button type="button" class="btn btn-secondary btn-sm" data-add-q="${t}">${icon("plus")}${escapeHtml(label.split(" (")[0])}</button>`).join("")}
      </div>
      <p class="form-error" id="qb-error" role="alert"></p>
      <div class="form-actions-row sticky-actions">
        <button type="button" class="btn btn-secondary" id="qb-preview">${icon("eye")} Preview</button>
        <button type="button" class="btn btn-secondary" id="qb-save">Save draft</button>
        <button type="button" class="btn btn-primary" id="qb-submit" ${d.club.status !== "approved" ? "disabled" : ""}>Save &amp; submit for approval</button>
      </div>
    </div>
  `;

  wireRecruitmentToggle(el, d);
  renderQuestionBuilder();

  $("qb-title").addEventListener("input", e => { b.title = e.target.value; lead.builderDirty = true; });
  $("qb-intro").addEventListener("input", e => { b.intro = e.target.value; lead.builderDirty = true; });
  el.querySelectorAll("[data-add-q]").forEach(btn => btn.addEventListener("click", () => {
    if (b.questions.length >= 30) return showToast("A form can have at most 30 questions.", "error");
    b.questions.push(newQuestion(btn.dataset.addQ));
    lead.builderDirty = true;
    renderQuestionBuilder();
    const items = document.querySelectorAll(".q-item");
    const last = items[items.length - 1];
    if (last) last.querySelector("[data-q-label]").focus();
  }));
  $("qb-preview").addEventListener("click", previewQuestionnaire);
  $("qb-save").addEventListener("click", e => saveQuestionnaire(false, e.currentTarget));
  $("qb-submit").addEventListener("click", e => saveQuestionnaire(true, e.currentTarget));
}

function renderQuestionBuilder() {
  const b = lead.builder;
  const wrap = $("qb-questions");
  wrap.innerHTML = b.questions.length === 0 ? '<p class="empty-state">No questions yet. Add one below.</p>' : "";
  b.questions.forEach((q, i) => {
    const isChoice = q.type.endsWith("choice");
    const item = document.createElement("div");
    item.className = "q-item";
    item.innerHTML = `
      <div class="q-item-head">
        <span class="q-num">${i + 1}</span>
        <select data-q-type aria-label="Question type">
          ${Object.entries(QUESTION_TYPES).map(([t, label]) => `<option value="${t}"${t === q.type ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
        <label class="q-required"><input type="checkbox" data-q-required ${q.required ? "checked" : ""}> Required</label>
        <span class="q-item-tools">
          <button type="button" class="icon-btn" data-q-up ${i === 0 ? "disabled" : ""} aria-label="Move up">${icon("arrowUp")}</button>
          <button type="button" class="icon-btn" data-q-down ${i === b.questions.length - 1 ? "disabled" : ""} aria-label="Move down">${icon("arrowDown")}</button>
          <button type="button" class="icon-btn is-danger" data-q-delete aria-label="Delete question">${icon("trash")}</button>
        </span>
      </div>
      <div class="field">
        <input type="text" data-q-label maxlength="300" placeholder="Question" value="${escapeHtml(q.label)}" aria-label="Question ${i + 1}">
      </div>
      <div class="field">
        <input type="text" data-q-help maxlength="500" placeholder="Help text (optional)" value="${escapeHtml(q.help_text)}" aria-label="Help text">
      </div>
      ${isChoice ? `
        <div class="q-options">
          ${q.options.map((opt, j) => `
            <div class="q-option">
              <span class="q-option-mark ${q.type === "single_choice" ? "is-radio" : ""}" aria-hidden="true"></span>
              <input type="text" data-q-option="${j}" maxlength="100" placeholder="Option ${j + 1}" value="${escapeHtml(opt)}" aria-label="Option ${j + 1}">
              <button type="button" class="icon-btn" data-q-option-delete="${j}" ${q.options.length <= 2 ? "disabled" : ""} aria-label="Remove option">${icon("x")}</button>
            </div>`).join("")}
          <button type="button" class="btn-link inline-link" data-q-option-add ${q.options.length >= 20 ? "disabled" : ""}>+ Add option</button>
        </div>` : ""}
    `;

    const dirty = () => { lead.builderDirty = true; };
    item.querySelector("[data-q-type]").addEventListener("change", e => {
      const t = e.target.value;
      q.type = t;
      if (t.endsWith("choice") && q.options.length < 2) q.options = q.options.concat(["", ""]).slice(0, Math.max(2, q.options.length));
      dirty();
      renderQuestionBuilder();
    });
    item.querySelector("[data-q-required]").addEventListener("change", e => { q.required = e.target.checked; dirty(); });
    item.querySelector("[data-q-label]").addEventListener("input", e => { q.label = e.target.value; dirty(); });
    item.querySelector("[data-q-help]").addEventListener("input", e => { q.help_text = e.target.value; dirty(); });
    item.querySelector("[data-q-up]").addEventListener("click", () => { [b.questions[i - 1], b.questions[i]] = [b.questions[i], b.questions[i - 1]]; dirty(); renderQuestionBuilder(); });
    item.querySelector("[data-q-down]").addEventListener("click", () => { [b.questions[i + 1], b.questions[i]] = [b.questions[i], b.questions[i + 1]]; dirty(); renderQuestionBuilder(); });
    item.querySelector("[data-q-delete]").addEventListener("click", async () => {
      if (q.label.trim()) {
        const ok = await confirmDialog(`Delete question ${i + 1}?`, { title: "Delete question", confirmText: "Delete", danger: true });
        if (!ok) return;
      }
      b.questions.splice(i, 1);
      dirty();
      renderQuestionBuilder();
    });
    item.querySelectorAll("[data-q-option]").forEach(inp => inp.addEventListener("input", e => { q.options[Number(inp.dataset.qOption)] = e.target.value; dirty(); }));
    item.querySelectorAll("[data-q-option-delete]").forEach(btn => btn.addEventListener("click", () => { q.options.splice(Number(btn.dataset.qOptionDelete), 1); dirty(); renderQuestionBuilder(); }));
    const addOpt = item.querySelector("[data-q-option-add]");
    if (addOpt) addOpt.addEventListener("click", () => {
      q.options.push("");
      dirty();
      renderQuestionBuilder();
      const inputs = $("qb-questions").querySelectorAll(".q-item")[i].querySelectorAll("[data-q-option]");
      inputs[inputs.length - 1].focus();
    });
    wrap.appendChild(item);
  });
}

// mirrors the checks in save_questionnaire() so mistakes show instantly
function validateBuilder() {
  const b = lead.builder;
  if (b.questions.length === 0) return "Add at least one question.";
  for (let i = 0; i < b.questions.length; i++) {
    const q = b.questions[i];
    if (!q.label.trim()) return `Question ${i + 1} needs a label.`;
    if (q.type.endsWith("choice")) {
      const opts = q.options.map(o => o.trim()).filter(Boolean);
      if (new Set(opts).size < 2) return `Question ${i + 1} needs at least two different options.`;
    }
  }
  return "";
}

function builderPayload() {
  return lead.builder.questions.map(q => ({
    type: q.type,
    label: q.label.trim(),
    help_text: q.help_text.trim(),
    required: q.required,
    options: q.type.endsWith("choice") ? q.options.map(o => o.trim()).filter(Boolean) : [],
  }));
}

function previewQuestionnaire() {
  const problem = validateBuilder();
  if (problem) {
    $("qb-error").textContent = problem;
    return;
  }
  $("qb-error").textContent = "";
  const qs = builderPayload().map((q, i) => ({ ...q, id: `preview-${i}` }));
  $("preview-modal-title").textContent = lead.builder.title.trim() || "Application form";
  const body = $("preview-modal-body");
  renderQuestionnaireForm(body, { intro: lead.builder.intro.trim() }, qs, "preview");
  openModal("preview-modal-overlay");
}

async function saveQuestionnaire(submit, btn) {
  const errorEl = $("qb-error");
  errorEl.textContent = "";
  const problem = validateBuilder();
  if (problem) {
    errorEl.textContent = problem;
    return;
  }
  if (submit) {
    const ok = await confirmDialog("Submit this form to an administrator? Once approved it replaces your current live form.", { title: "Submit for approval", confirmText: "Submit" });
    if (!ok) return;
  }
  await withBusy(btn, submit ? "Submitting…" : "Saving…", async () => {
    const { data: id, error } = await supabaseClient.rpc("save_questionnaire", {
      p_club: lead.clubId,
      p_title: lead.builder.title,
      p_intro: lead.builder.intro,
      p_questions: builderPayload(),
    });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    if (submit) {
      const { error: subErr } = await supabaseClient.rpc("submit_questionnaire", { p_questionnaire: id });
      if (subErr) {
        errorEl.textContent = friendlyError(subErr);
        lead.builderDirty = false;
        return;
      }
    }
    lead.builderDirty = false;
    lead.builder = null;
    showToast(submit ? "Form submitted for approval." : "Draft saved.", "success");
    reloadLead();
  });
}

// ---------- posts & events ----------

const POST_KIND_LABELS = { event: "Event announcement", event_result: "Event results", announcement: "Club announcement" };

function renderLeadPosts(el, d) {
  const disabled = d.club.status !== "approved" ? "disabled" : "";
  const today = todayDateStr();
  el.innerHTML = `
    <div class="quick-actions">
      <button class="btn btn-primary btn-sm btn-with-icon" data-new-post="event" ${disabled}>${icon("calendar")}New event</button>
      <button class="btn btn-secondary btn-sm btn-with-icon" data-new-post="event_result" ${disabled}>${icon("image")}Post event results</button>
      <button class="btn btn-secondary btn-sm btn-with-icon" data-new-post="announcement" ${disabled}>${icon("megaphone")}New announcement</button>
    </div>
    <div class="lead-list">
      ${d.posts.length === 0 ? '<p class="empty-state">Nothing posted yet.</p>' : d.posts.map(p => {
        const parent = p.parent_event_id ? d.posts.find(x => x.id === p.parent_event_id) : null;
        const lifecycle = p.kind === "event" && p.status === "approved"
          ? (p.event_date >= today ? '<span class="status-badge is-open">Upcoming</span>' : '<span class="status-badge is-closed">Completed</span>') : "";
        return `
        <div class="lead-row lead-post">
          ${p.cover_url ? `<img class="lead-thumb" src="${escapeHtml(p.cover_url)}" alt="">` : p.photos && p.photos.length ? `<img class="lead-thumb" src="${escapeHtml(p.photos[0].url)}" alt="">` : `<span class="lead-thumb is-icon">${icon(p.kind === "event" ? "calendar" : p.kind === "event_result" ? "image" : "megaphone")}</span>`}
          <div class="lead-row-main">
            <strong>${escapeHtml(p.title)}</strong>
            <span class="muted">${POST_KIND_LABELS[p.kind]}${p.kind === "event" ? ` · ${escapeHtml(formatEventDay(p.event_date))}` : ""}${parent ? ` · for “${escapeHtml(parent.title)}”` : ""} · submitted ${formatShortDate(p.submitted_at)}</span>
            ${p.review_note && p.status !== "approved" ? `<p class="review-note"><strong>Administrator:</strong> ${escapeHtml(p.review_note)}</p>` : ""}
          </div>
          <span class="lead-row-badges">${statusBadge(p.status)}${lifecycle}</span>
          <span class="lead-row-actions">
            ${["pending", "changes_requested"].includes(p.status) ? `<button class="btn btn-secondary btn-sm" data-edit-post="${p.id}">${p.status === "changes_requested" ? "Edit &amp; resubmit" : "Edit"}</button>` : ""}
            ${p.status !== "approved" ? `<button class="btn-danger" data-withdraw-post="${p.id}">${p.status === "rejected" ? "Delete" : "Withdraw"}</button>` : ""}
            ${p.status === "approved" && p.kind === "event" && p.event_date <= today && !d.posts.some(x => x.parent_event_id === p.id && x.status !== "rejected") ? `<button class="btn btn-secondary btn-sm" data-results-for="${p.id}">Add results</button>` : ""}
          </span>
        </div>`;
      }).join("")}
    </div>
    <p class="muted small-note">Approved posts can't be edited. Published events move to the club's Event History automatically after their date.</p>`;

  el.querySelectorAll("[data-new-post]").forEach(btn => btn.addEventListener("click", () => openPostModal(btn.dataset.newPost)));
  el.querySelectorAll("[data-edit-post]").forEach(btn => btn.addEventListener("click", () => openPostModal(null, d.posts.find(p => p.id === btn.dataset.editPost))));
  el.querySelectorAll("[data-results-for]").forEach(btn => btn.addEventListener("click", () => openPostModal("event_result", null, btn.dataset.resultsFor)));
  el.querySelectorAll("[data-withdraw-post]").forEach(btn => btn.addEventListener("click", async () => {
    const post = d.posts.find(p => p.id === btn.dataset.withdrawPost);
    const ok = await confirmDialog(`${post.status === "rejected" ? "Delete" : "Withdraw"} “${post.title}”?`, { title: "Remove post", confirmText: post.status === "rejected" ? "Delete" : "Withdraw", danger: true });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("withdraw_submission", { p_kind: "post", p_id: post.id });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Post removed.", "success");
      reloadLead();
    });
  }));
}

// ---------- post modal ----------

const postState = { kind: "event", editing: null, photos: [] };
const postCoverPicker = setupImagePicker({
  input: $("post-cover-input"),
  preview: $("post-cover-preview"),
  removeBtn: $("post-cover-remove"),
  folder: "posters",
  errorEl: $("post-error"),
});
const postKindButtons = document.querySelectorAll("[data-post-kind]");

postKindButtons.forEach(btn => btn.addEventListener("click", () => {
  if (postState.editing) return;
  setPostKind(btn.dataset.postKind);
}));

function setPostKind(kind) {
  postState.kind = kind;
  postKindButtons.forEach(b => b.classList.toggle("active", b.dataset.postKind === kind));
  document.querySelectorAll("#form-post [data-post-only]").forEach(el => {
    el.hidden = !el.dataset.postOnly.split(" ").includes(kind);
  });
  $("post-cover-label").textContent = kind === "event" ? "Poster (optional, one image)" : "Image (optional)";
  $("post-body").placeholder = kind === "event_result" ? "How did it go? Results, winners, highlights..." : kind === "event" ? "What's happening and who should come?" : "Your announcement...";
  if (kind === "event") $("post-date").min = todayDateStr();
}

function openPostModal(kind, post = null, parentId = null) {
  const d = lead.data;
  if (!d) return;
  postState.editing = post;
  const k = post ? post.kind : kind;
  $("form-post").reset();
  $("post-error").textContent = "";
  $("post-modal-title").textContent = post ? `Edit ${POST_KIND_LABELS[k].toLowerCase()}` : `New ${POST_KIND_LABELS[k].toLowerCase()}`;
  $("post-submit-btn").textContent = post ? "Resubmit for approval" : "Submit for approval";
  postKindButtons.forEach(b => { b.disabled = !!post; });

  const today = todayDateStr();
  const pastEvents = d.posts.filter(p => p.kind === "event" && p.status === "approved" && p.event_date <= today)
    .sort((a, b) => b.event_date.localeCompare(a.event_date));
  $("post-parent").innerHTML = pastEvents.length
    ? pastEvents.map(p => `<option value="${p.id}">${escapeHtml(p.title)} — ${escapeHtml(formatEventDay(p.event_date))}</option>`).join("")
    : '<option value="">No completed events yet</option>';

  setPostKind(k);

  if (post) {
    $("post-title").value = post.title;
    $("post-body").value = post.body;
    $("post-date").value = post.event_date || "";
    $("post-start").value = formatTime(post.start_time);
    $("post-end").value = formatTime(post.end_time);
    $("post-location").value = post.location || "";
    if (post.parent_event_id) $("post-parent").value = post.parent_event_id;
  } else if (parentId) {
    $("post-parent").value = parentId;
    const parent = pastEvents.find(p => p.id === parentId);
    if (parent) $("post-title").value = `Results: ${parent.title}`.slice(0, 150);
  }
  postCoverPicker.setUrl(post ? post.cover_url : null);
  postState.photos = post && post.photos ? post.photos.slice().sort((a, b) => a.position - b.position).map(p => ({ url: p.url })) : [];
  renderPostPhotos();
  openModal("post-modal-overlay");
  $("post-title").focus();
}

function renderPostPhotos() {
  const wrap = $("post-photos");
  wrap.innerHTML = postState.photos.map((p, i) => `
    <div class="photo-thumb">
      <img src="${escapeHtml(p.preview || p.url)}" alt="Photo ${i + 1}">
      <button type="button" class="icon-btn" data-remove-photo="${i}" aria-label="Remove photo">${icon("x")}</button>
    </div>`).join("") || '<span class="muted">No photos yet.</span>';
  wrap.querySelectorAll("[data-remove-photo]").forEach(btn => btn.addEventListener("click", () => {
    postState.photos.splice(Number(btn.dataset.removePhoto), 1);
    renderPostPhotos();
  }));
  $("post-photos-add").hidden = postState.photos.length >= 3;
}

$("post-photos-input").addEventListener("change", e => {
  const files = [...e.target.files];
  e.target.value = "";
  for (const file of files) {
    if (postState.photos.length >= 3) {
      showToast("You can add at most 3 photos.", "error");
      break;
    }
    const problem = validateImageFile(file);
    if (problem) {
      $("post-error").textContent = problem;
      continue;
    }
    postState.photos.push({ file, preview: URL.createObjectURL(file) });
  }
  renderPostPhotos();
});

$("form-post").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("post-error");
  errorEl.textContent = "";
  const kind = postState.kind;
  const title = $("post-title").value.trim();
  const body = $("post-body").value.trim();
  const eventDate = $("post-date").value;
  const start = $("post-start").value;
  const end = $("post-end").value;
  const parent = $("post-parent").value;

  if (title.length < 3) { errorEl.textContent = "Title must be at least 3 characters."; return; }
  if (kind === "event") {
    if (!eventDate) { errorEl.textContent = "Please choose the event date."; return; }
    if (eventDate < todayDateStr()) { errorEl.textContent = "The event date can't be in the past."; return; }
    if (end && !start) { errorEl.textContent = "Add a start time too."; return; }
    if (start && end && end < start) { errorEl.textContent = "The end time must be after the start time."; return; }
  } else if (kind === "event_result") {
    if (!parent) { errorEl.textContent = "Choose which event these results are for."; return; }
    if (!body) { errorEl.textContent = "Please describe the results."; return; }
    if (postState.photos.length < 1) { errorEl.textContent = "Add at least one photo (up to 3)."; return; }
  } else if (!body) {
    errorEl.textContent = "Please write the announcement.";
    return;
  }

  await withBusy($("post-submit-btn"), "Uploading…", async () => {
    let coverUrl = null;
    let photoUrls = [];
    try {
      if (kind !== "event_result") coverUrl = await postCoverPicker.getUrl();
      if (kind === "event_result") {
        for (const p of postState.photos) {
          if (p.file) {
            p.url = await uploadImage(p.file, "photos");
            delete p.file;
          }
          photoUrls.push(p.url);
        }
      }
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      return;
    }

    const { error } = await supabaseClient.rpc("submit_club_post", {
      p_club: lead.clubId,
      p_kind: kind,
      p_title: title,
      p_body: body,
      p_event_date: kind === "event" ? eventDate : null,
      p_start_time: kind === "event" && start ? start : null,
      p_end_time: kind === "event" && end ? end : null,
      p_location: kind === "event" ? $("post-location").value.trim() : "",
      p_cover_url: coverUrl,
      p_parent_event: kind === "event_result" ? parent : null,
      p_photos: photoUrls,
      p_post_id: postState.editing ? postState.editing.id : null,
    });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    closeModalById("post-modal-overlay");
    showToast("Submitted! It will be published once an administrator approves it.", "success");
    if (lead.tab !== "posts") {
      navigate(`#/lead/${lead.clubId}/posts`);
    } else {
      reloadLead();
    }
  });
});

// ---------- achievements ----------

let editingAchievement = null;
const achievementPicker = setupImagePicker({
  input: $("achievement-image-input"),
  preview: $("achievement-image-preview"),
  removeBtn: $("achievement-image-remove"),
  folder: "achievements",
  errorEl: $("achievement-error"),
});

function renderLeadAchievements(el, d) {
  el.innerHTML = `
    <div class="quick-actions">
      <button class="btn btn-primary btn-sm btn-with-icon" data-new-achievement ${d.club.status !== "approved" ? "disabled" : ""}>${icon("trophy")}Add achievement</button>
    </div>
    <div class="lead-list">
      ${d.achievements.length === 0 ? '<p class="empty-state">No achievements yet. Won a competition or reached a milestone? Add it here.</p>' : d.achievements.map(a => `
        <div class="lead-row">
          ${a.image_url ? `<img class="lead-thumb" src="${escapeHtml(a.image_url)}" alt="">` : `<span class="lead-thumb is-icon">${icon("trophy")}</span>`}
          <div class="lead-row-main">
            <strong>${escapeHtml(a.title)}</strong>
            <span class="muted">${formatLongDate(a.achieved_on)}</span>
            ${a.review_note && a.status !== "approved" ? `<p class="review-note"><strong>Administrator:</strong> ${escapeHtml(a.review_note)}</p>` : ""}
          </div>
          ${statusBadge(a.status)}
          <span class="lead-row-actions">
            ${["pending", "changes_requested"].includes(a.status) ? `<button class="btn btn-secondary btn-sm" data-edit-achievement="${a.id}">Edit</button>` : ""}
            ${a.status !== "approved" ? `<button class="btn-danger" data-withdraw-achievement="${a.id}">Remove</button>` : ""}
          </span>
        </div>`).join("")}
    </div>`;
  const newBtn = el.querySelector("[data-new-achievement]");
  newBtn.addEventListener("click", () => openAchievementModal());
  el.querySelectorAll("[data-edit-achievement]").forEach(btn => btn.addEventListener("click", () => openAchievementModal(d.achievements.find(a => a.id === btn.dataset.editAchievement))));
  el.querySelectorAll("[data-withdraw-achievement]").forEach(btn => btn.addEventListener("click", async () => {
    const ok = await confirmDialog("Remove this achievement submission?", { title: "Remove achievement", confirmText: "Remove", danger: true });
    if (!ok) return;
    await withBusy(btn, "…", async () => {
      const { error } = await supabaseClient.rpc("withdraw_submission", { p_kind: "achievement", p_id: btn.dataset.withdrawAchievement });
      if (error) return showToast(friendlyError(error), "error");
      showToast("Achievement removed.", "success");
      reloadLead();
    });
  }));
}

function openAchievementModal(a = null) {
  editingAchievement = a;
  $("form-achievement").reset();
  $("achievement-error").textContent = "";
  $("achievement-modal-title").textContent = a ? "Edit achievement" : "New achievement";
  $("achievement-date").max = todayDateStr();
  if (a) {
    $("achievement-title").value = a.title;
    $("achievement-date").value = a.achieved_on;
    $("achievement-description").value = a.description;
  }
  achievementPicker.setUrl(a ? a.image_url : null);
  openModal("achievement-modal-overlay");
  $("achievement-title").focus();
}

$("form-achievement").addEventListener("submit", async e => {
  e.preventDefault();
  const errorEl = $("achievement-error");
  errorEl.textContent = "";
  const title = $("achievement-title").value.trim();
  const date = $("achievement-date").value;
  if (title.length < 3) { errorEl.textContent = "Title must be at least 3 characters."; return; }
  if (!date) { errorEl.textContent = "Please add the date."; return; }
  if (date > todayDateStr()) { errorEl.textContent = "The date can't be in the future."; return; }

  await withBusy($("achievement-submit-btn"), "Submitting…", async () => {
    let imageUrl;
    try {
      imageUrl = await achievementPicker.getUrl();
    } catch (err) {
      errorEl.textContent = friendlyError(err);
      return;
    }
    const { error } = await supabaseClient.rpc("submit_achievement", {
      p_club: lead.clubId,
      p_title: title,
      p_description: $("achievement-description").value.trim(),
      p_achieved_on: date,
      p_image_url: imageUrl,
      p_id: editingAchievement ? editingAchievement.id : null,
    });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    closeModalById("achievement-modal-overlay");
    showToast("Achievement submitted for approval.", "success");
    if (lead.tab !== "achievements") navigate(`#/lead/${lead.clubId}/achievements`);
    else reloadLead();
  });
});

// ---------- club profile (change requests) ----------

let profileLogoPicker = null;

function renderLeadProfile(el, d) {
  const open = d.changes.find(c => ["pending", "changes_requested"].includes(c.status));
  const lastDecided = d.changes.find(c => ["approved", "rejected"].includes(c.status));
  const src = open || d.club;

  el.innerHTML = `
    ${open ? `<div class="notice ${open.status === "changes_requested" ? "notice-warn" : ""}">${icon(open.status === "pending" ? "clock" : "edit")}
      ${open.status === "pending" ? `Your profile changes (submitted ${formatShortDate(open.submitted_at)}) are <strong>waiting for approval</strong>. You can still edit them below.`
        : `An administrator asked for changes: <strong>${escapeHtml(open.review_note)}</strong>`}
      <button class="btn-link inline-link" id="withdraw-change">Withdraw request</button></div>`
      : lastDecided && lastDecided.status === "rejected" ? `<div class="notice notice-warn">${icon("x")}Your last change request was rejected: <strong>${escapeHtml(lastDecided.review_note)}</strong></div>` : ""}

    <p class="muted">Changes to the club's public profile go live after an administrator approves them.</p>
    <form id="form-club-change" novalidate>
      <div class="field">
        <label for="cc-name">Club name</label>
        <input type="text" id="cc-name" maxlength="80" value="${escapeHtml(src.name)}" required>
      </div>
      <div class="field">
        <label for="cc-category">Category</label>
        <select id="cc-category">${categoriesCache.map(c => `<option${c === src.category ? " selected" : ""}>${escapeHtml(c)}</option>`).join("")}</select>
      </div>
      <div class="field">
        <label for="cc-description">Description</label>
        <textarea id="cc-description" rows="5" maxlength="2000" required>${escapeHtml(src.description)}</textarea>
      </div>
      <div class="field">
        <label>Logo</label>
        <div class="image-picker">
          <div class="image-picker-preview" id="cc-logo-preview"></div>
          <div class="image-picker-actions">
            <label class="btn btn-secondary btn-sm file-btn">Choose image<input type="file" id="cc-logo-input" accept="image/png,image/jpeg,image/webp,image/gif" hidden></label>
            <button type="button" class="btn-link inline-link" id="cc-logo-remove" hidden>Remove</button>
            <span class="field-hint">PNG, JPG, WEBP or GIF, up to 5 MB.</span>
          </div>
        </div>
      </div>
      <p class="form-error" id="cc-error" role="alert"></p>
      <button type="submit" class="btn btn-primary" id="cc-submit" ${d.club.status !== "approved" ? "disabled" : ""}>Submit changes for approval</button>
    </form>`;

  profileLogoPicker = setupImagePicker({
    input: $("cc-logo-input"),
    preview: $("cc-logo-preview"),
    removeBtn: $("cc-logo-remove"),
    folder: "logos",
    errorEl: $("cc-error"),
  });
  profileLogoPicker.setUrl(src.logo_url);

  const withdraw = $("withdraw-change");
  if (withdraw) withdraw.addEventListener("click", async () => {
    const ok = await confirmDialog("Withdraw your pending profile changes?", { title: "Withdraw request", confirmText: "Withdraw", danger: true });
    if (!ok) return;
    const { error } = await supabaseClient.rpc("withdraw_submission", { p_kind: "club_change", p_id: open.id });
    if (error) return showToast(friendlyError(error), "error");
    showToast("Request withdrawn.", "success");
    reloadLead();
  });

  $("form-club-change").addEventListener("submit", async e => {
    e.preventDefault();
    const errorEl = $("cc-error");
    errorEl.textContent = "";
    const name = $("cc-name").value.trim();
    const description = $("cc-description").value.trim();
    if (name.length < 2) { errorEl.textContent = "Club name must be at least 2 characters."; return; }
    if (description.length < 10) { errorEl.textContent = "Description must be at least 10 characters."; return; }
    await withBusy($("cc-submit"), "Submitting…", async () => {
      let logoUrl;
      try {
        logoUrl = await profileLogoPicker.getUrl();
      } catch (err) {
        errorEl.textContent = friendlyError(err);
        return;
      }
      const { error } = await supabaseClient.rpc("submit_club_change", {
        p_club: lead.clubId,
        p_name: name,
        p_category: $("cc-category").value,
        p_description: description,
        p_logo_url: logoUrl,
      });
      if (error) {
        errorEl.textContent = friendlyError(error);
        return;
      }
      showToast("Profile changes submitted for approval.", "success");
      reloadLead();
    });
  });
}

// ---------- sidebar badge: items waiting for this leader ----------

async function refreshLeaderBadge() {
  const badge = $("lead-badge");
  if (!currentUser || currentUser.leaderships.length === 0) {
    badge.hidden = true;
    return;
  }
  const ids = currentUser.leaderships.map(l => l.club_id);
  const [apps, leaves] = await Promise.all([
    supabaseClient.from("applications").select("id", { count: "exact", head: true }).in("club_id", ids).eq("status", "pending"),
    supabaseClient.from("club_members").select("id", { count: "exact", head: true }).in("club_id", ids).eq("status", "approved").not("leave_requested_at", "is", null),
  ]);
  const total = (apps.count || 0) + (leaves.count || 0);
  badge.hidden = !total;
  badge.textContent = total > 99 ? "99+" : String(total || "");
}
