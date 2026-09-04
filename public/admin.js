const TOKEN_KEY = "shzb_token";

let currentAdmin = null;

async function api(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

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

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle("open");
});
document.addEventListener("click", () => profileMenu.classList.remove("open"));

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  window.location.href = "/index.html";
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatDate(iso) {
  return new Date(iso.replace(" ", "T") + "Z").toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

async function loadPendingClubs() {
  const { clubs } = await api("/api/admin/clubs/pending");
  statPending.textContent = clubs.length;
  pendingTbody.innerHTML = "";

  if (clubs.length === 0) {
    pendingEmpty.hidden = false;
    return;
  }
  pendingEmpty.hidden = true;

  clubs.forEach(club => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(club.name)}</strong><br><span class="row-subtext">${escapeHtml(club.description).slice(0, 80)}</span></td>
      <td><span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span></td>
      <td>${escapeHtml(club.createdByName)}</td>
      <td>${formatDate(club.createdAt)}</td>
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
      try {
        await api(`/api/admin/clubs/${btn.dataset.approveId}/approve`, { method: "POST" });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });

  pendingTbody.querySelectorAll("[data-reject-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const club = clubs.find(c => String(c.id) === btn.dataset.rejectId);
      if (!confirm(`Reject and delete the request "${club.name}"?`)) return;
      btn.disabled = true;
      try {
        await api(`/api/clubs/${club.id}`, { method: "DELETE" });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadClubs() {
  const { clubs } = await api("/api/clubs");
  statClubs.textContent = clubs.length;
  clubsTbody.innerHTML = "";

  if (clubs.length === 0) {
    clubsEmpty.hidden = false;
    return;
  }
  clubsEmpty.hidden = true;

  clubs.forEach(club => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(club.name)}</strong><br><span class="row-subtext">${escapeHtml(club.description).slice(0, 80)}</span></td>
      <td><span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span></td>
      <td>${escapeHtml(club.createdByName)}</td>
      <td>${formatDate(club.createdAt)}</td>
      <td><button class="btn-danger" data-club-id="${club.id}">Delete</button></td>
    `;
    clubsTbody.appendChild(tr);
  });

  clubsTbody.querySelectorAll("[data-club-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const club = clubs.find(c => String(c.id) === btn.dataset.clubId);
      if (!confirm(`Delete the club "${club.name}"? This cannot be undone.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/clubs/${club.id}`, { method: "DELETE" });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function loadUsers() {
  const { users } = await api("/api/admin/users");
  statUsers.textContent = users.filter(u => u.role === "student").length;
  usersTbody.innerHTML = "";

  if (users.length === 0) {
    usersEmpty.hidden = false;
    return;
  }
  usersEmpty.hidden = true;

  users.forEach(user => {
    const tr = document.createElement("tr");
    const isAdmin = user.role === "admin";
    tr.innerHTML = `
      <td>${escapeHtml(user.firstName)} ${escapeHtml(user.lastName)}</td>
      <td>${escapeHtml(user.email)}</td>
      <td><span class="role-badge ${user.role}">${user.role}</span></td>
      <td>${user.clubCount}</td>
      <td>${formatDate(user.createdAt)}</td>
      <td><button class="btn-danger" data-user-id="${user.id}" ${isAdmin ? "disabled" : ""}>Delete</button></td>
    `;
    usersTbody.appendChild(tr);
  });

  usersTbody.querySelectorAll("[data-user-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const user = users.find(u => String(u.id) === btn.dataset.userId);
      if (!confirm(`Delete the account for ${user.firstName} ${user.lastName}? This also deletes any clubs they created.`)) return;
      btn.disabled = true;
      try {
        await api(`/api/admin/users/${user.id}`, { method: "DELETE" });
        await refresh();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

async function refresh() {
  await Promise.all([loadPendingClubs(), loadClubs(), loadUsers()]);
}

(async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    window.location.href = "/index.html";
    return;
  }

  try {
    const { user } = await api("/api/auth/me");
    if (user.role !== "admin") {
      window.location.href = "/index.html";
      return;
    }
    currentAdmin = user;
    profileMenuName.textContent = `${user.firstName} ${user.lastName}`;
    profileMenuEmail.textContent = user.email;
    await refresh();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    window.location.href = "/index.html";
  }
})();
