const SCHOOL_EMAIL_DOMAIN = "@shinezuunbileg.edu.mn";
const TOKEN_KEY = "shzb_token";

let currentUser = null;

// ---------- API helper ----------

async function api(path, options = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || "Something went wrong.");
  }
  return data;
}

// ---------- elements ----------

const viewAuth = document.getElementById("view-auth");
const viewApp = document.getElementById("view-app");

const authTabs = document.querySelectorAll(".auth-tab");
const formRegister = document.getElementById("form-register");
const formLogin = document.getElementById("form-login");
const registerError = document.getElementById("register-error");
const loginError = document.getElementById("login-error");

const profileBtn = document.getElementById("profile-btn");
const profileMenu = document.getElementById("profile-menu");
const profileMenuName = document.getElementById("profile-menu-name");
const profileMenuEmail = document.getElementById("profile-menu-email");
const logoutBtn = document.getElementById("logout-btn");
const brandHomeBtn = document.getElementById("brand-home-btn");

const clubGrid = document.getElementById("club-grid");
const clubEmpty = document.getElementById("club-empty");

const viewClubList = document.getElementById("view-club-list");
const viewClubDetail = document.getElementById("view-club-detail");
const detailBackBtn = document.getElementById("detail-back-btn");
const detailCategory = document.getElementById("detail-category");
const detailName = document.getElementById("detail-name");
const detailMeta = document.getElementById("detail-meta");
const detailDescription = document.getElementById("detail-description");
const detailMeeting = document.getElementById("detail-meeting");

const toast = document.getElementById("toast");
const fabCreateClub = document.getElementById("fab-create-club");
const modalOverlay = document.getElementById("modal-overlay");
const modalCloseBtn = document.getElementById("modal-close-btn");
const modalCancelBtn = document.getElementById("modal-cancel-btn");
const formCreateClub = document.getElementById("form-create-club");
const createClubError = document.getElementById("create-club-error");

// ---------- auth tab switching ----------

authTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    authTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.tab;
    formRegister.classList.toggle("active", target === "register");
    formLogin.classList.toggle("active", target === "login");
    registerError.textContent = "";
    loginError.textContent = "";
  });
});

// ---------- register ----------

formRegister.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.textContent = "";

  const firstName = document.getElementById("reg-firstname").value.trim();
  const lastName = document.getElementById("reg-lastname").value.trim();
  const email = document.getElementById("reg-email").value.trim().toLowerCase();
  const password = document.getElementById("reg-password").value;
  const passwordConfirm = document.getElementById("reg-password-confirm").value;

  if (!email.endsWith(SCHOOL_EMAIL_DOMAIN)) {
    registerError.textContent = `Email must end with ${SCHOOL_EMAIL_DOMAIN}`;
    return;
  }
  if (password !== passwordConfirm) {
    registerError.textContent = "Passwords do not match.";
    return;
  }

  try {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ firstName, lastName, email, password }),
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    currentUser = data.user;
    enterApp();
  } catch (err) {
    registerError.textContent = err.message;
  }
});

// ---------- login ----------

formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const email = document.getElementById("login-email").value.trim().toLowerCase();
  const password = document.getElementById("login-password").value;

  try {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem(TOKEN_KEY, data.token);
    currentUser = data.user;

    if (currentUser.role === "admin") {
      window.location.href = "/admin.html";
      return;
    }
    enterApp();
  } catch (err) {
    loginError.textContent = err.message;
  }
});

// ---------- app entry / profile ----------

function enterApp() {
  if (!currentUser) return;

  viewAuth.style.display = "none";
  viewApp.style.display = "block";

  const initials = (currentUser.firstName[0] || "") + (currentUser.lastName[0] || "");
  profileBtn.textContent = initials.toUpperCase();
  profileMenuName.textContent = `${currentUser.firstName} ${currentUser.lastName}`;
  profileMenuEmail.textContent = currentUser.email;

  showClubList();
}

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle("open");
});

document.addEventListener("click", () => {
  profileMenu.classList.remove("open");
});

logoutBtn.addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  currentUser = null;
  viewApp.style.display = "none";
  viewAuth.style.display = "flex";
  formLogin.reset();
  formRegister.reset();
});

brandHomeBtn.addEventListener("click", showClubList);

// ---------- club list / detail navigation ----------

function showClubList() {
  viewClubList.classList.add("active");
  viewClubDetail.classList.remove("active");
  renderClubs();
}

function showClubDetail(club) {
  viewClubList.classList.remove("active");
  viewClubDetail.classList.add("active");

  detailCategory.textContent = club.category;
  detailCategory.dataset.category = club.category;
  detailName.textContent = club.name;
  detailMeta.textContent = `Created by ${club.createdByName}`;
  detailDescription.textContent = club.description;
  detailMeeting.textContent = club.meeting || "Not specified";
}

detailBackBtn.addEventListener("click", showClubList);

async function renderClubs() {
  let clubs = [];
  try {
    const data = await api("/api/clubs");
    clubs = data.clubs;
  } catch (err) {
    if (err.message.includes("session")) {
      logoutBtn.click();
      return;
    }
  }

  clubGrid.innerHTML = "";

  if (clubs.length === 0) {
    clubEmpty.hidden = false;
    return;
  }
  clubEmpty.hidden = true;

  clubs.forEach(club => {
    const card = document.createElement("button");
    card.className = "club-card";
    card.innerHTML = `
      <span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span>
      <h3>${escapeHtml(club.name)}</h3>
      <p>${escapeHtml(club.description)}</p>
      <div class="club-card-footer">by ${escapeHtml(club.createdByName)}</div>
    `;
    card.addEventListener("click", () => showClubDetail(club));
    clubGrid.appendChild(card);
  });
}

let toastTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add("show"));
  toastTimer = setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => { toast.hidden = true; }, 300);
  }, 4000);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- create club modal ----------

function openModal() {
  createClubError.textContent = "";
  formCreateClub.reset();
  modalOverlay.classList.add("open");
}

function closeModal() {
  modalOverlay.classList.remove("open");
}

fabCreateClub.addEventListener("click", openModal);
modalCloseBtn.addEventListener("click", closeModal);
modalCancelBtn.addEventListener("click", closeModal);
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) closeModal();
});

formCreateClub.addEventListener("submit", async (e) => {
  e.preventDefault();
  createClubError.textContent = "";

  const name = document.getElementById("club-name").value.trim();
  const category = document.getElementById("club-category").value;
  const description = document.getElementById("club-description").value.trim();
  const meeting = document.getElementById("club-meeting").value.trim();

  if (!name || !description) {
    createClubError.textContent = "Please fill in the required fields.";
    return;
  }

  try {
    await api("/api/clubs", {
      method: "POST",
      body: JSON.stringify({ name, category, description, meeting }),
    });
    closeModal();
    showClubList();
    showToast("Club submitted! An admin will review it before it appears publicly.");
  } catch (err) {
    createClubError.textContent = err.message;
  }
});

// ---------- boot ----------

(async function boot() {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    viewAuth.style.display = "flex";
    viewApp.style.display = "none";
    return;
  }

  try {
    const data = await api("/api/auth/me");
    currentUser = data.user;
    if (currentUser.role === "admin") {
      window.location.href = "/admin.html";
      return;
    }
    enterApp();
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    viewAuth.style.display = "flex";
    viewApp.style.display = "none";
  }
})();
