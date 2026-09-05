let currentAdmin = null;

const profileBtn = document.getElementById("profile-btn");
const profileMenu = document.getElementById("profile-menu");
const profileMenuName = document.getElementById("profile-menu-name");
const profileMenuEmail = document.getElementById("profile-menu-email");
const logoutBtn = document.getElementById("logout-btn");

const statUsers = document.getElementById("stat-users");
const statClubs = document.getElementById("stat-clubs");
const statPending = document.getElementById("stat-pending");

const pendingTbody = document.getElementById("pending-tbody");
const pendingEmpty = document.getElementById("pending-empty");
const clubsTbody = document.getElementById("clubs-tbody");
const clubsEmpty = document.getElementById("clubs-empty");
const usersTbody = document.getElementById("users-tbody");
const usersEmpty = document.getElementById("users-empty");

const announcementsTbody = document.getElementById("announcements-tbody");
const announcementsEmpty = document.getElementById("announcements-empty");
const newAnnouncementBtn = document.getElementById("new-announcement-btn");
const announcementModalOverlay = document.getElementById("announcement-modal-overlay");
const announcementModalCloseBtn = document.getElementById("announcement-modal-close-btn");
const announcementModalCancelBtn = document.getElementById("announcement-modal-cancel-btn");
const formAnnouncement = document.getElementById("form-announcement");
const announcementError = document.getElementById("announcement-error");

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle("open");
});
document.addEventListener("click", () => profileMenu.classList.remove("open"));

logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  window.location.href = "/index.html";
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

// ---------- announcements ----------

async function loadAnnouncements() {
  const { data: announcements, error } = await supabaseClient
    .from("announcements")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) { console.error(error); return; }

  announcementsTbody.innerHTML = "";

  if (announcements.length === 0) {
    announcementsEmpty.hidden = false;
    return;
  }
  announcementsEmpty.hidden = true;

  announcements.forEach(a => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(a.title)}</strong><br><span class="row-subtext">${escapeHtml((a.description || "").slice(0, 80))}</span></td>
      <td>${a.event_date ? formatDateTime(a.event_date) : "—"}</td>
      <td>${formatDate(a.created_at)}</td>
      <td><button class="btn-danger" data-announcement-id="${a.id}">Delete</button></td>
    `;
    announcementsTbody.appendChild(tr);
  });

  announcementsTbody.querySelectorAll("[data-announcement-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this announcement?")) return;
      btn.disabled = true;
      const { error: delError } = await supabaseClient
        .from("announcements")
        .delete()
        .eq("id", btn.dataset.announcementId);
      if (delError) { alert(delError.message); btn.disabled = false; return; }
      await loadAnnouncements();
    });
  });
}

function openAnnouncementModal() {
  announcementError.textContent = "";
  formAnnouncement.reset();
  announcementModalOverlay.classList.add("open");
}

function closeAnnouncementModal() {
  announcementModalOverlay.classList.remove("open");
}

newAnnouncementBtn.addEventListener("click", openAnnouncementModal);
announcementModalCloseBtn.addEventListener("click", closeAnnouncementModal);
announcementModalCancelBtn.addEventListener("click", closeAnnouncementModal);
announcementModalOverlay.addEventListener("click", (e) => {
  if (e.target === announcementModalOverlay) closeAnnouncementModal();
});

formAnnouncement.addEventListener("submit", async (e) => {
  e.preventDefault();
  announcementError.textContent = "";

  const title = document.getElementById("announcement-title").value.trim();
  const dateValue = document.getElementById("announcement-date").value;
  const description = document.getElementById("announcement-description").value.trim();

  if (!title) {
    announcementError.textContent = "Title is required.";
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();

  const { error } = await supabaseClient.from("announcements").insert({
    title,
    description,
    event_date: dateValue ? new Date(dateValue).toISOString() : null,
    created_by: session.user.id,
  });

  if (error) {
    announcementError.textContent = error.message;
    return;
  }

  closeAnnouncementModal();
  await loadAnnouncements();
});

async function loadPendingClubs() {
  const { data: clubs, error } = await supabaseClient
    .from("clubs")
    .select("*, creator:profiles(first_name, last_name)")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) { console.error(error); return; }

  statPending.textContent = clubs.length;
  pendingTbody.innerHTML = "";

  if (clubs.length === 0) {
    pendingEmpty.hidden = false;
    return;
  }
  pendingEmpty.hidden = true;

  clubs.forEach(club => {
    const createdByName = `${club.creator.first_name} ${club.creator.last_name}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(club.name)}</strong><br><span class="row-subtext">${escapeHtml(club.description).slice(0, 80)}</span></td>
      <td><span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span></td>
      <td>${escapeHtml(createdByName)}</td>
      <td>${formatDate(club.created_at)}</td>
      <td class="pending-actions">
        <button class="btn-approve" data-approve-id="${club.id}">Approve</button>
        <button class="btn-danger" data-reject-id="${club.id}">Reject</button>
      </td>
    `;
    pendingTbody.appendChild(tr);
  });

  pendingTbody.querySelectorAll("[data-approve-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await supabaseClient
        .from("clubs")
        .update({ status: "approved" })
        .eq("id", btn.dataset.approveId);
      if (error) {
        alert(error.message);
        btn.disabled = false;
        return;
      }
      await refresh();
    });
  });

  pendingTbody.querySelectorAll("[data-reject-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const club = clubs.find(c => c.id === btn.dataset.rejectId);
      if (!confirm(`Reject and delete the request "${club.name}"?`)) return;
      btn.disabled = true;
      const { error } = await supabaseClient.from("clubs").delete().eq("id", club.id);
      if (error) {
        alert(error.message);
        btn.disabled = false;
        return;
      }
      await refresh();
    });
  });
}

async function loadClubs() {
  const { data: clubs, error } = await supabaseClient
    .from("clubs")
    .select("*, creator:profiles(first_name, last_name)")
    .eq("status", "approved")
    .order("created_at", { ascending: false });

  if (error) { console.error(error); return; }

  statClubs.textContent = clubs.length;
  clubsTbody.innerHTML = "";

  if (clubs.length === 0) {
    clubsEmpty.hidden = false;
    return;
  }
  clubsEmpty.hidden = true;

  clubs.forEach(club => {
    const createdByName = `${club.creator.first_name} ${club.creator.last_name}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(club.name)}</strong><br><span class="row-subtext">${escapeHtml(club.description).slice(0, 80)}</span></td>
      <td><span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span></td>
      <td>${escapeHtml(createdByName)}</td>
      <td>${formatDate(club.created_at)}</td>
      <td><button class="btn-danger" data-club-id="${club.id}">Delete</button></td>
    `;
    clubsTbody.appendChild(tr);
  });

  clubsTbody.querySelectorAll("[data-club-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const club = clubs.find(c => c.id === btn.dataset.clubId);
      if (!confirm(`Delete the club "${club.name}"? This cannot be undone.`)) return;
      btn.disabled = true;
      const { error } = await supabaseClient.from("clubs").delete().eq("id", club.id);
      if (error) {
        alert(error.message);
        btn.disabled = false;
        return;
      }
      await refresh();
    });
  });
}

async function loadUsers() {
  const { data: profiles, error: profErr } = await supabaseClient
    .from("profiles")
    .select("*")
    .order("created_at", { ascending: false });
  if (profErr) { console.error(profErr); return; }

  const { data: allClubs, error: clubsErr } = await supabaseClient
    .from("clubs")
    .select("id, created_by");
  if (clubsErr) { console.error(clubsErr); return; }

  const clubCountByUser = {};
  allClubs.forEach(c => {
    clubCountByUser[c.created_by] = (clubCountByUser[c.created_by] || 0) + 1;
  });

  statUsers.textContent = profiles.filter(p => p.role === "student").length;
  usersTbody.innerHTML = "";

  if (profiles.length === 0) {
    usersEmpty.hidden = false;
    return;
  }
  usersEmpty.hidden = true;

  profiles.forEach(profile => {
    const isAdmin = profile.role === "admin";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(profile.first_name)} ${escapeHtml(profile.last_name)}</td>
      <td>${escapeHtml(profile.email)}</td>
      <td><span class="role-badge ${profile.account_type}">${profile.account_type}</span></td>
      <td><span class="role-badge ${profile.role}">${profile.role}</span></td>
      <td>${clubCountByUser[profile.id] || 0}</td>
      <td>${formatDate(profile.created_at)}</td>
      <td><button class="btn-danger" data-user-id="${profile.id}" ${isAdmin ? "disabled" : ""}>Delete</button></td>
    `;
    usersTbody.appendChild(tr);
  });

  usersTbody.querySelectorAll("[data-user-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const profile = profiles.find(p => p.id === btn.dataset.userId);
      if (!confirm(`Delete the account for ${profile.first_name} ${profile.last_name}? This also deletes any clubs they created.`)) return;
      btn.disabled = true;
      try {
        await deleteUserAccount(profile.id);
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function deleteUserAccount(userId) {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  const res = await fetch("/api/admin-delete-user", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify({ userId }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete account.");
  }
}

async function refresh() {
  await Promise.all([loadAnnouncements(), loadPendingClubs(), loadClubs(), loadUsers()]);
}

(async function boot() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session) {
    window.location.href = "/index.html";
    return;
  }

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();

  if (error || !profile || profile.role !== "admin") {
    window.location.href = "/index.html";
    return;
  }

  currentAdmin = profile;
  profileMenuName.textContent = `${profile.first_name} ${profile.last_name}`;
  profileMenuEmail.textContent = profile.email;
  await refresh();
})();
