const SCHOOL_EMAIL_DOMAIN = "@shinezuunbileg.edu.mn";
// TEMPORARY: domain restriction disabled for testing. Set back to true before
// real launch (and re-enable the matching check in the database trigger —
// see supabase/migration_003_teacher_type_and_domain_toggle.sql).
const ENFORCE_SCHOOL_EMAIL_DOMAIN = false;

// The signed-in person. `profile` is their profiles row; the flags below are
// for showing/hiding UI only — every permission is enforced again by the
// database (RLS policies + workflow functions in migration 006).
let currentUser = null;
let selectedAccountType = "student";
let categoriesCache = [];

const $ = id => document.getElementById(id);

// ============================================================
// AUTH
// ============================================================

const viewAuth = $("view-auth");
const viewApp = $("view-app");

const authTabsEl = $("auth-tabs");
const authTabs = document.querySelectorAll(".auth-tab");
const formRegister = $("form-register");
const formLogin = $("form-login");
const registerError = $("register-error");
const loginError = $("login-error");

const panelVerify = $("panel-verify");
const formVerify = $("form-verify");
const verifyError = $("verify-error");
const verifyEmailDisplay = $("verify-email-display");
const verifyCodeInput = $("verify-code");
const resendCodeBtn = $("resend-code-btn");

const panelForgot = $("panel-forgot");
const panelReset = $("panel-reset");

// Password-reset links land on this page with the session in the URL hash
// (#access_token=…&type=recovery). Capture that before anything else runs —
// supabase-js clears the hash once it has read the session.
const initialHash = window.location.hash;
let recoveryMode = /type=recovery/.test(initialHash);
const authLinkError = (() => {
  const params = new URLSearchParams(initialHash.replace(/^#/, ""));
  return params.get("error_description") || null;
})();

const AUTH_PANELS = { register: formRegister, login: formLogin, verify: panelVerify, forgot: panelForgot, reset: panelReset };

function showAuthPanel(name) {
  Object.entries(AUTH_PANELS).forEach(([key, el]) => el.classList.toggle("active", key === name));
  authTabsEl.hidden = !(name === "register" || name === "login");
  authTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  [registerError, loginError, verifyError, $("forgot-error"), $("reset-error"), $("recovery-code-error")].forEach(el => { el.textContent = ""; });
}

function showAuthView() {
  viewApp.style.display = "none";
  viewAuth.style.display = "flex";
}

// ---------- show / hide password ----------

const passwordToggles = document.querySelectorAll("[data-toggle-password]");

function setPasswordVisible(btn, visible) {
  const input = $(btn.dataset.togglePassword);
  input.type = visible ? "text" : "password";
  btn.innerHTML = icon(visible ? "eyeOff" : "eye");
  btn.setAttribute("aria-label", visible ? "Hide password" : "Show password");
}

passwordToggles.forEach(btn => {
  setPasswordVisible(btn, false);
  btn.addEventListener("click", () => {
    const input = $(btn.dataset.togglePassword);
    setPasswordVisible(btn, input.type === "password");
  });
});

authTabs.forEach(tab => tab.addEventListener("click", () => showAuthPanel(tab.dataset.tab)));

// ---------- email verification panel ----------

let pendingVerifyEmail = null;
let resendCooldownTimer = null;

function showVerifyPanel(email) {
  pendingVerifyEmail = email;
  verifyEmailDisplay.textContent = email;
  verifyCodeInput.value = "";
  showAuthPanel("verify");
}

$("verify-back-btn").addEventListener("click", () => showAuthPanel("login"));

formVerify.addEventListener("submit", async (e) => {
  e.preventDefault();
  verifyError.textContent = "";
  const code = verifyCodeInput.value.trim();
  if (!/^\d{4,10}$/.test(code)) {
    verifyError.textContent = "Enter the numeric code from the email.";
    return;
  }
  const btn = formVerify.querySelector("button[type=submit]");
  await withBusy(btn, "Verifying…", async () => {
    const { error } = await supabaseClient.auth.verifyOtp({ email: pendingVerifyEmail, token: code, type: "signup" });
    if (error) {
      verifyError.textContent = friendlyError(error);
      return;
    }
    await afterAuthSuccess();
  });
});

function startCooldown(btn, label, seconds) {
  let secondsLeft = seconds;
  btn.disabled = true;
  btn.textContent = `${label} (${secondsLeft}s)`;
  const timer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      clearInterval(timer);
      btn.disabled = false;
      btn.textContent = label;
    } else {
      btn.textContent = `${label} (${secondsLeft}s)`;
    }
  }, 1000);
  return timer;
}

resendCodeBtn.addEventListener("click", async () => {
  resendCodeBtn.disabled = true;
  verifyError.textContent = "";
  const { error } = await supabaseClient.auth.resend({ type: "signup", email: pendingVerifyEmail });
  if (error) {
    verifyError.textContent = friendlyError(error);
    resendCodeBtn.disabled = false;
    return;
  }
  clearInterval(resendCooldownTimer);
  resendCooldownTimer = startCooldown(resendCodeBtn, "Resend code", 60);
});

// ---------- account type toggle ----------

const regGradeRow = $("reg-grade-row");
const regGradeSelect = $("reg-grade");
const regClassSelect = $("reg-class");

const accountTypeButtons = document.querySelectorAll(".account-type-btn[data-account-type]");
accountTypeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    accountTypeButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedAccountType = btn.dataset.accountType;
    regGradeRow.hidden = selectedAccountType !== "student";
  });
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- register ----------

formRegister.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.textContent = "";

  const firstName = $("reg-firstname").value.trim();
  const lastName = $("reg-lastname").value.trim();
  const email = $("reg-email").value.trim().toLowerCase();
  const password = $("reg-password").value;
  const passwordConfirm = $("reg-password-confirm").value;

  if (!firstName || !lastName) {
    registerError.textContent = "Please enter your first and last name.";
    return;
  }
  if (!EMAIL_RE.test(email)) {
    registerError.textContent = "Please enter a valid email address.";
    return;
  }
  if (ENFORCE_SCHOOL_EMAIL_DOMAIN && !email.endsWith(SCHOOL_EMAIL_DOMAIN)) {
    registerError.textContent = `Email must end with ${SCHOOL_EMAIL_DOMAIN}`;
    return;
  }
  const pwProblem = validatePassword(password);
  if (pwProblem) {
    registerError.textContent = pwProblem;
    return;
  }
  if (password !== passwordConfirm) {
    registerError.textContent = "Passwords do not match.";
    return;
  }

  const isStudent = selectedAccountType === "student";
  const graduationYear = isStudent ? computeGraduationYear(Number(regGradeSelect.value)) : null;
  const classSection = isStudent ? regClassSelect.value : null;

  const btn = formRegister.querySelector("button[type=submit]");
  await withBusy(btn, "Creating account…", async () => {
    const { error } = await supabaseClient.auth.signUp({
      email,
      password,
      options: {
        data: {
          first_name: firstName,
          last_name: lastName,
          account_type: selectedAccountType,
          graduation_year: graduationYear,
          class_section: classSection,
        },
      },
    });
    if (error) {
      registerError.textContent = friendlyError(error);
      return;
    }
    showVerifyPanel(email);
  });
});

// ---------- login ----------

formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const email = $("login-email").value.trim().toLowerCase();
  const password = $("login-password").value;
  if (!EMAIL_RE.test(email) || !password) {
    loginError.textContent = "Enter your email and password.";
    return;
  }

  const btn = formLogin.querySelector("button[type=submit]");
  await withBusy(btn, "Logging in…", async () => {
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) {
      if (/confirm/i.test(error.message)) {
        showVerifyPanel(email);
      } else if (/banned/i.test(error.message)) {
        loginError.textContent = "This account is suspended. Please contact a school administrator.";
      } else {
        loginError.textContent = friendlyError(error);
      }
      return;
    }
    await afterAuthSuccess({ fromLogin: true });
  });
});

// ---------- forgot password ----------
// Uses Supabase Auth's built-in recovery: it generates a single-use token,
// emails it (as a link and, if the email template includes {{ .Token }}, a
// code), expires it (Auth > Providers > Email > "Email OTP expiration"),
// rate-limits requests, and stores the new password hashed with bcrypt.

let recoveryEmail = null;
let forgotCooldownTimer = null;

$("forgot-password-btn").addEventListener("click", () => {
  $("forgot-email").value = $("login-email").value.trim();
  $("forgot-success").hidden = true;
  $("form-recovery-code").hidden = true;
  showAuthPanel("forgot");
});

$("forgot-back-btn").addEventListener("click", () => showAuthPanel("login"));

$("form-forgot").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("forgot-error");
  const successEl = $("forgot-success");
  errorEl.textContent = "";
  const email = $("forgot-email").value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    errorEl.textContent = "Please enter a valid email address.";
    return;
  }

  const btn = $("forgot-submit-btn");
  btn.disabled = true;
  const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
    redirectTo: `${window.location.origin}/index.html`,
  });

  // Same message whether or not the account exists, so this form can't be
  // used to discover who has an account. Only rate limiting is surfaced.
  if (error && (error.status === 429 || /rate limit|too many/i.test(error.message))) {
    errorEl.textContent = "Too many reset requests. Please wait a few minutes and try again.";
    btn.disabled = false;
    return;
  }
  if (error && /Failed to fetch/i.test(error.message)) {
    errorEl.textContent = friendlyError(error);
    btn.disabled = false;
    return;
  }

  recoveryEmail = email;
  successEl.textContent = "If an account exists for that email, we've sent password reset instructions. Check your inbox (and spam folder).";
  successEl.hidden = false;
  $("form-recovery-code").hidden = false;
  clearInterval(forgotCooldownTimer);
  forgotCooldownTimer = startCooldown(btn, "Send again", 60);
});

$("form-recovery-code").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("recovery-code-error");
  errorEl.textContent = "";
  const code = $("recovery-code").value.trim();
  if (!/^\d{4,10}$/.test(code)) {
    errorEl.textContent = "Enter the numeric code from the email.";
    return;
  }
  const btn = e.target.querySelector("button[type=submit]");
  await withBusy(btn, "Checking…", async () => {
    const { error } = await supabaseClient.auth.verifyOtp({ email: recoveryEmail, token: code, type: "recovery" });
    if (error) {
      errorEl.textContent = "That code is invalid or has expired. Request a new one.";
      return;
    }
    recoveryMode = true;
    showAuthPanel("reset");
  });
});

$("form-reset-password").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("reset-error");
  errorEl.textContent = "";
  const password = $("reset-password").value;
  const confirmValue = $("reset-password-confirm").value;
  const problem = validatePassword(password);
  if (problem) { errorEl.textContent = problem; return; }
  if (password !== confirmValue) { errorEl.textContent = "Passwords do not match."; return; }

  await withBusy($("reset-submit-btn"), "Updating…", async () => {
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) {
      errorEl.textContent = /session/i.test(error.message)
        ? "Your reset link has expired. Please request a new one."
        : friendlyError(error);
      return;
    }
    // sign out every other device that might still use the old password
    await supabaseClient.auth.signOut({ scope: "others" });
    recoveryMode = false;
    $("form-reset-password").reset();
    history.replaceState(null, "", window.location.pathname + "#/home");
    showToast("Your password has been updated.", "success");
    await afterAuthSuccess();
  });
});

supabaseClient.auth.onAuthStateChange((event) => {
  if (event === "PASSWORD_RECOVERY") {
    recoveryMode = true;
    showAuthView();
    showAuthPanel("reset");
  }
});

// ---------- app entry / profile ----------

async function loadCurrentUser() {
  const { data: { user } } = await supabaseClient.auth.getUser();
  if (!user) return null;

  const { data: profile, error } = await supabaseClient.from("profiles").select("*").eq("id", user.id).single();
  if (error || !profile) return null;

  const { data: leads } = await supabaseClient
    .from("club_leaders")
    .select("id, club_id, position, started_at, club:clubs(id, name, status, category, logo_url)")
    .eq("user_id", user.id)
    .is("ended_at", null);

  const isAdmin = profile.role === "admin";
  return {
    id: profile.id,
    profile,
    email: profile.email,
    isAdmin,
    isTeacher: profile.account_type === "teacher" && !isAdmin,
    isStudent: profile.account_type === "student" && !isAdmin,
    leaderships: (leads || []).filter(l => l.club),
  };
}

async function afterAuthSuccess({ fromLogin = false } = {}) {
  const user = await loadCurrentUser();
  if (!user) {
    loginError.textContent = "Could not load your profile. Try logging in again.";
    await supabaseClient.auth.signOut();
    showAuthView();
    showAuthPanel("login");
    return;
  }
  if (user.profile.status === "suspended") {
    await supabaseClient.auth.signOut();
    showAuthView();
    showAuthPanel("login");
    loginError.textContent = "This account is suspended. Please contact a school administrator.";
    return;
  }

  currentUser = user;

  // admins land on their dashboard after logging in; they can still open
  // the community site from there
  if (currentUser.isAdmin && fromLogin) {
    window.location.href = "/admin.html";
    return;
  }
  enterApp();
}

function isLeaderOf(clubId) {
  return !!currentUser && currentUser.leaderships.some(l => l.club_id === clubId);
}

async function refreshLeaderships() {
  const fresh = await loadCurrentUser();
  if (fresh) currentUser = fresh;
  applyRoleVisibility();
}

function applyRoleVisibility() {
  const u = currentUser;
  $("nav-my-clubs").hidden = !u.isStudent;
  $("nav-lead").hidden = u.leaderships.length === 0;
  $("nav-admin").hidden = !u.isAdmin;
  $("nav-manage-group").hidden = u.leaderships.length === 0 && !u.isAdmin;
  $("create-club-btn").hidden = !u.isStudent;

  const roleLabel = u.isAdmin ? "Administrator"
    : u.isTeacher ? "Teacher"
    : u.leaderships.length ? "Student · Club leader"
    : "Student";
  $("sidebar-user").innerHTML = `
    <span class="profile-avatar">${escapeHtml(initials(u.profile))}</span>
    <span class="sidebar-user-text">
      <strong>${escapeHtml(fullName(u.profile))}</strong>
      <span>${escapeHtml(roleLabel)}</span>
    </span>`;
}

function enterApp() {
  if (!currentUser) return;
  viewAuth.style.display = "none";
  viewApp.style.display = "block";
  showAuthPanel("register");
  applyRoleVisibility();
  loadCategories();
  startNotificationPolling();
  if (!location.hash.startsWith("#/")) {
    history.replaceState(null, "", window.location.pathname + "#/home");
  }
  route();
}

async function logout() {
  stopNotificationPolling();
  await supabaseClient.auth.signOut();
  currentUser = null;
  showAuthView();
  formLogin.reset();
  formRegister.reset();
  passwordToggles.forEach(btn => setPasswordVisible(btn, false));
  showAuthPanel("login");
  history.replaceState(null, "", window.location.pathname);
}

$("logout-btn").addEventListener("click", logout);
$("profile-logout-btn").addEventListener("click", logout);

// ============================================================
// ROUTING (#/page/param/...)
// ============================================================
// Hash routes make every page linkable (notifications link straight to the
// relevant club / tab) and make the browser back button work.

const VIEW_IDS = [
  "view-home", "view-my-clubs", "view-announcements", "view-students", "view-student-profile",
  "view-club-detail", "view-lead", "view-notifications", "view-not-found",
];

let navDepth = 0;

function parseRoute() {
  const h = window.location.hash;
  if (!h.startsWith("#/")) return { name: "home", params: [] };
  const parts = h.slice(2).split("/").filter(Boolean).map(decodeURIComponent);
  return { name: parts[0] || "home", params: parts.slice(1) };
}

function navigate(hash) {
  if (window.location.hash === hash) route();
  else window.location.hash = hash;
}

function goBack() {
  if (navDepth > 1) history.back();
  else navigate("#/home");
}

function showPanel(viewId, navName) {
  VIEW_IDS.forEach(id => $(id).classList.toggle("active", id === viewId));
  document.querySelectorAll(".sidebar-nav-item[data-nav]").forEach(item => {
    item.classList.toggle("active", item.dataset.nav === navName);
  });
  closeSidebar();
  window.scrollTo({ top: 0 });
}

function showNotFound(message) {
  $("not-found-message").textContent = message || "This page doesn't exist, or you don't have access to it.";
  showPanel("view-not-found", null);
}

async function route() {
  if (!currentUser) return;
  const { name, params } = parseRoute();

  switch (name) {
    case "home":
      showPanel("view-home", "home");
      renderHome();
      break;
    case "my-clubs":
      if (!currentUser.isStudent) return showNotFound("My Clubs is for student accounts.");
      showPanel("view-my-clubs", "my-clubs");
      renderMyClubs();
      break;
    case "announcements":
      showPanel("view-announcements", "announcements");
      setFeedFilter(params[0] || "all");
      loadFeed();
      break;
    case "students":
      showPanel("view-students", "students");
      renderStudents();
      break;
    case "profile":
      showPanel("view-student-profile", "profile");
      showStudentProfile(currentUser.id, true);
      break;
    case "student":
      if (!params[0]) return showNotFound();
      if (params[0] === currentUser.id) return navigate("#/profile");
      showPanel("view-student-profile", "students");
      showStudentProfile(params[0], false);
      break;
    case "club":
      if (!params[0]) return showNotFound();
      showPanel("view-club-detail", "home");
      showClubDetail(params[0], params[1] || "overview");
      break;
    case "lead":
      // leadership may have been granted since login (e.g. a club was just approved)
      if (currentUser.leaderships.length === 0 || (params[0] && !isLeaderOf(params[0]))) {
        await refreshLeaderships();
        if (currentUser.leaderships.length === 0) return showNotFound("The Leader Dashboard is only available to club leaders.");
      }
      showPanel("view-lead", "lead");
      showLeaderDashboard(params[0], params[1] || "overview");
      break;
    case "notifications":
      showPanel("view-notifications", "notifications");
      renderNotifications();
      break;
    default:
      showNotFound();
  }
}

window.addEventListener("hashchange", () => {
  navDepth += 1;
  route();
});

// ---------- sidebar (mobile) ----------

const appSidebar = $("app-sidebar");
const sidebarOverlay = $("sidebar-overlay");

function openSidebar() {
  appSidebar.classList.add("open");
  sidebarOverlay.classList.add("open");
}

function closeSidebar() {
  appSidebar.classList.remove("open");
  sidebarOverlay.classList.remove("open");
}

$("hamburger-btn").addEventListener("click", openSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

// ---------- modals (generic close wiring) ----------

function openModal(id) { $(id).classList.add("open"); }
function closeModalById(id) { $(id).classList.remove("open"); }

document.querySelectorAll("[data-close-modal]").forEach(btn => {
  btn.addEventListener("click", () => closeModalById(btn.dataset.closeModal));
});
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => { if (e.target === overlay) overlay.classList.remove("open"); });
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const open = [...document.querySelectorAll(".modal-overlay.open:not(.dialog-overlay)")].pop();
  if (open) open.classList.remove("open");
});

// ============================================================
// CATEGORIES
// ============================================================

let activeCategoryFilter = "All";

async function loadCategories() {
  const { data, error } = await supabaseClient
    .from("club_categories")
    .select("name, sort_order")
    .order("sort_order")
    .order("name");
  categoriesCache = error || !data || data.length === 0
    ? ["Academic", "Arts", "Sports", "Technology", "Volunteer", "Other"]
    : data.map(c => c.name);

  const filters = $("category-filters");
  filters.innerHTML = ["All", ...categoriesCache].map(c => `
    <button class="category-filter-btn${c === activeCategoryFilter ? " active" : ""}" data-category-filter="${escapeHtml(c)}">${escapeHtml(c)}</button>
  `).join("");
  filters.querySelectorAll("[data-category-filter]").forEach(btn => {
    btn.addEventListener("click", () => {
      activeCategoryFilter = btn.dataset.categoryFilter;
      filters.querySelectorAll("[data-category-filter]").forEach(b => b.classList.toggle("active", b === btn));
      applyClubSearch();
    });
  });

  $("club-category").innerHTML = categoriesCache.map(c => `<option>${escapeHtml(c)}</option>`).join("");
}

// ============================================================
// HOME
// ============================================================

let homeClubs = [];
let homeLeaders = {};      // club_id -> [{ position, profile }]
let homeMemberCounts = {};
const clubSearchInput = $("club-search");
const recruitmentFilter = $("recruitment-filter");

async function renderHome() {
  renderClubs();
  renderLeaderboard();
  renderHomeUpcoming();
  loadSchoolAnnouncements();
}

// Approved-member counts for a set of clubs (membership rows are readable by
// any signed-in user).
async function fetchMemberCounts(clubIds) {
  const counts = {};
  if (clubIds.length === 0) return counts;
  const { data, error } = await supabaseClient
    .from("club_members")
    .select("club_id")
    .eq("status", "approved")
    .in("club_id", clubIds);
  if (error) {
    console.error(error);
    return counts;
  }
  data.forEach(r => { counts[r.club_id] = (counts[r.club_id] || 0) + 1; });
  return counts;
}

async function fetchActiveLeaders(clubIds) {
  const map = {};
  if (clubIds.length === 0) return map;
  const { data, error } = await supabaseClient
    .from("club_leaders")
    .select("id, club_id, user_id, position, started_at, profile:profiles!club_leaders_user_id_fkey(id, first_name, last_name)")
    .in("club_id", clubIds)
    .is("ended_at", null);
  if (error) {
    console.error(error);
    return map;
  }
  data.forEach(l => {
    (map[l.club_id] = map[l.club_id] || []).push(l);
  });
  Object.values(map).forEach(list => list.sort((a, b) => (a.position === "leader" ? -1 : 1) - (b.position === "leader" ? -1 : 1)));
  return map;
}

function mainLeaderName(leaders) {
  if (!leaders || leaders.length === 0) return "";
  const main = leaders.find(l => l.position === "leader") || leaders[0];
  return fullName(main.profile);
}

async function renderClubs() {
  const grid = $("club-grid");
  if (homeClubs.length === 0) grid.innerHTML = loadingHtml("Loading clubs…");

  const { data: clubs, error } = await supabaseClient
    .from("clubs")
    .select("*")
    .eq("status", "approved")
    .order("name", { ascending: true });

  if (error) {
    grid.innerHTML = errorStateHtml("Couldn't load clubs. Please refresh the page.");
    return;
  }

  homeClubs = clubs;
  const ids = clubs.map(c => c.id);
  [homeMemberCounts, homeLeaders] = await Promise.all([fetchMemberCounts(ids), fetchActiveLeaders(ids)]);
  applyClubSearch();
}

function applyClubSearch() {
  const term = clubSearchInput.value.trim().toLowerCase();
  const recruit = recruitmentFilter.value;
  const filtered = homeClubs.filter(c => {
    if (activeCategoryFilter !== "All" && c.category !== activeCategoryFilter) return false;
    if (recruit === "open" && !c.recruitment_open) return false;
    if (recruit === "closed" && c.recruitment_open) return false;
    if (!term) return true;
    const leaderNames = (homeLeaders[c.id] || []).map(l => fullName(l.profile)).join(" ");
    return `${c.name} ${c.category} ${leaderNames} ${c.description}`.toLowerCase().includes(term);
  });

  const grid = $("club-grid");
  grid.innerHTML = "";
  $("club-empty").hidden = filtered.length !== 0;
  $("club-empty").querySelector("p").textContent = homeClubs.length === 0
    ? "No clubs yet. Students can request one!"
    : "No clubs match your search.";

  filtered.forEach(club => {
    const card = buildClubCard(club, {
      memberCount: homeMemberCounts[club.id] || 0,
      leaderName: mainLeaderName(homeLeaders[club.id]),
      tag: club.recruitment_open ? '<span class="club-card-ownertag is-recruiting">Recruiting</span>' : "",
    });
    grid.appendChild(card);
  });
}

clubSearchInput.addEventListener("input", applyClubSearch);
recruitmentFilter.addEventListener("change", applyClubSearch);

function buildClubCard(club, { memberCount = 0, leaderName = "", tag = "", note = null } = {}) {
  const card = document.createElement("a");
  card.className = "club-card";
  card.href = `#/club/${club.id}`;
  card.dataset.category = club.category;
  card.innerHTML = `
    <span class="club-card-banner" aria-hidden="true"></span>
    <span class="club-card-head">
      <span class="club-card-icon${club.logo_url ? " has-logo" : ""}">${clubLogoHtml(club)}</span>
      <span class="club-card-title">
        <span class="club-card-tags">
          <span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span>
          ${tag}
        </span>
        <h3>${escapeHtml(club.name)}</h3>
        ${leaderName ? `<span class="club-card-leader">${icon("user")}Led by <strong>${escapeHtml(leaderName)}</strong></span>` : ""}
      </span>
    </span>
    <p class="club-card-desc">${escapeHtml(club.description)}</p>
    <span class="club-card-bottom">
      <span class="club-card-members">${note ? escapeHtml(note) : `${icon("users")}${memberCount} member${memberCount === 1 ? "" : "s"}`}</span>
      <span class="club-card-arrow">${icon("arrowRight")}</span>
    </span>
  `;
  return card;
}

// ---------- leaderboard ----------

let leaderboardPeriod = "all";
const leaderboardPeriodButtons = document.querySelectorAll("#leaderboard-periods [data-period]");

leaderboardPeriodButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    leaderboardPeriod = btn.dataset.period;
    leaderboardPeriodButtons.forEach(b => b.classList.toggle("active", b === btn));
    renderLeaderboard();
  });
});

async function renderLeaderboard() {
  const el = $("leaderboard");
  el.innerHTML = loadingHtml("Loading rankings…");
  const { data, error } = await supabaseClient.rpc("club_leaderboard", { p_period: leaderboardPeriod });
  if (error) {
    el.innerHTML = errorStateHtml("Couldn't load the leaderboard.");
    return;
  }
  const ranked = data.filter(r => r.score > 0).slice(0, 10);
  if (ranked.length === 0) {
    el.innerHTML = `<p class="empty-state">No club activity in this period yet.</p>`;
    return;
  }
  const top = ranked[0].score || 1;
  el.innerHTML = ranked.map((r, i) => `
    <a class="lb-row${i < 3 ? ` is-top is-top-${i + 1}` : ""}" href="#/club/${r.club_id}">
      <span class="lb-rank">${i + 1}</span>
      <span class="lb-logo" data-category="${escapeHtml(r.category)}">${clubLogoHtml(r)}</span>
      <span class="lb-main">
        <span class="lb-name">${escapeHtml(r.name)}</span>
        <span class="lb-bar"><span style="width:${Math.max(6, Math.round((r.score / top) * 100))}%"></span></span>
        <span class="lb-breakdown">${r.events_count} event${r.events_count === 1 ? "" : "s"} · ${r.posts_count} update${r.posts_count === 1 ? "" : "s"} · ${r.achievements_count} achievement${r.achievements_count === 1 ? "" : "s"}</span>
      </span>
      <span class="lb-score"><strong>${r.score}</strong><span>pts</span></span>
    </a>
  `).join("");
}

// ---------- upcoming events (home) ----------

const POST_SELECT = "*, club:clubs(id, name, category, logo_url, status), photos:club_post_photos(url, position)";

async function renderHomeUpcoming() {
  const el = $("home-upcoming");
  el.innerHTML = loadingHtml("Loading events…");
  const { data, error } = await supabaseClient
    .from("club_posts")
    .select(POST_SELECT)
    .eq("kind", "event")
    .eq("status", "approved")
    .gte("event_date", todayDateStr())
    .order("event_date", { ascending: true })
    .order("start_time", { ascending: true, nullsFirst: true })
    .limit(6);
  if (error) {
    el.innerHTML = errorStateHtml("Couldn't load events.");
    return;
  }
  const events = data.filter(p => p.club && p.club.status === "approved");
  if (events.length === 0) {
    el.innerHTML = `<p class="empty-state">No upcoming events right now.</p>`;
    return;
  }
  el.innerHTML = events.map(ev => {
    const d = parseDateOnly(ev.event_date);
    return `
      <a class="upcoming-card" href="#/club/${ev.club.id}/upcoming">
        <span class="upcoming-poster">
          ${ev.cover_url
            ? `<img src="${escapeHtml(ev.cover_url)}" alt="" loading="lazy">`
            : `<span class="upcoming-date-block"><strong>${d.getDate()}</strong>${d.toLocaleDateString("en-GB", { month: "short" })}</span>`}
        </span>
        <span class="upcoming-info">
          <span class="upcoming-club">${escapeHtml(ev.club.name)}</span>
          <span class="upcoming-title">${escapeHtml(ev.title)}</span>
          <span class="upcoming-meta">${icon("calendar")}${escapeHtml(formatEventDay(ev.event_date))}${ev.start_time ? ` · ${escapeHtml(formatTimeRange(ev.start_time, ev.end_time))}` : ""}</span>
        </span>
      </a>`;
  }).join("");
}

// ---------- school announcements (home, compact) ----------

async function loadSchoolAnnouncements() {
  const { data: announcements, error } = await supabaseClient
    .from("announcements")
    .select("*")
    .order("event_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    console.error(error);
    return;
  }

  const now = new Date();
  const upcoming = announcements.filter(a => !a.event_date || new Date(a.event_date) >= now).slice(0, 6);

  $("announcements-section").hidden = upcoming.length === 0;
  const list = $("announcements-list");
  list.innerHTML = "";
  upcoming.forEach(a => list.appendChild(renderSchoolAnnouncementCard(a, false, true)));
}

function renderSchoolAnnouncementCard(a, isPast, compact = false) {
  const card = document.createElement("article");
  card.className = "announcement-card" + (isPast ? " is-past" : "") + (compact ? " is-compact" : "");

  let tagText = "School news";
  let tagClass = "is-news";
  if (a.event_date) {
    tagText = isPast ? "Past Event" : "Upcoming Event";
    tagClass = isPast ? "is-past" : "is-upcoming";
  }

  let eventBlock = "";
  if (a.event_date) {
    const d = new Date(a.event_date);
    const dateText = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
    const timeText = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    eventBlock = compact
      ? `<p class="announcement-card-date">${icon("calendar")}${dateText} · ${timeText}</p>`
      : a.image_url ? `<p class="announcement-card-date">${icon("calendar")}${dateText} · ${timeText}</p>` : `
        <div class="announcement-poster">
          <span class="announcement-poster-kicker">SHZB Announcement</span>
          <span class="announcement-poster-title">${escapeHtml(a.title)}</span>
          <span class="announcement-poster-row">${icon("calendar")}${dateText}</span>
          <span class="announcement-poster-row">${icon("clock")}${timeText}</span>
        </div>`;
  }

  card.innerHTML = `
    <header class="announcement-card-head">
      <img class="announcement-card-crest" src="crest.png" alt="">
      <span class="announcement-card-source">
        <strong>Shine Zuun Bileg</strong>
        <span>Posted on ${formatShortDate(a.created_at)}</span>
      </span>
      <span class="announcement-tag ${tagClass}">${tagText}</span>
    </header>
    ${a.image_url && !compact ? `<img class="feed-cover" src="${escapeHtml(a.image_url)}" alt="" loading="lazy">` : ""}
    <h4>${escapeHtml(a.title)}</h4>
    <p class="announcement-card-description">${escapeHtml(a.description || "")}</p>
    ${eventBlock}
  `;
  return card;
}

// ============================================================
// MY CLUBS
// ============================================================

async function renderMyClubs() {
  const grid = $("my-clubs-grid");
  grid.innerHTML = loadingHtml("Loading your clubs…");

  const [{ data: rows, error }, { data: requests }] = await Promise.all([
    supabaseClient
      .from("club_members")
      .select("*, club:clubs(*)")
      .eq("user_id", currentUser.id)
      .eq("status", "approved")
      .order("joined_at", { ascending: false }),
    supabaseClient
      .from("clubs")
      .select("*")
      .eq("created_by", currentUser.id)
      .in("status", ["pending", "changes_requested", "rejected"])
      .order("submitted_at", { ascending: false }),
  ]);

  grid.innerHTML = "";
  if (error) {
    grid.innerHTML = errorStateHtml();
    return;
  }

  const memberships = (rows || []).filter(r => r.club);
  $("my-clubs-empty").hidden = memberships.length !== 0;

  const ids = memberships.map(r => r.club.id);
  const [counts, leaders] = await Promise.all([fetchMemberCounts(ids), fetchActiveLeaders(ids)]);

  memberships.forEach(row => {
    const club = row.club;
    const leading = isLeaderOf(club.id);
    const tag = leading
      ? '<span class="club-card-ownertag">Leader</span>'
      : row.leave_requested_at
        ? '<span class="club-card-ownertag is-pending">Leave requested</span>'
        : '<span class="club-card-ownertag is-member">Member</span>';
    grid.appendChild(buildClubCard(club, {
      memberCount: counts[club.id] || 0,
      leaderName: mainLeaderName(leaders[club.id]),
      tag,
      note: club.status !== "approved" ? `Club ${STATUS_LABELS[club.status] || club.status}` : null,
    }));
  });

  renderMyClubRequests(requests || []);
}

function renderMyClubRequests(requests) {
  const section = $("my-requests-section");
  const list = $("my-requests-list");
  section.hidden = requests.length === 0;
  list.innerHTML = "";

  requests.forEach(club => {
    const row = document.createElement("div");
    row.className = "request-row";
    const canEdit = club.status === "pending" || club.status === "changes_requested";
    row.innerHTML = `
      <span class="request-logo" data-category="${escapeHtml(club.category)}">${clubLogoHtml(club)}</span>
      <div class="request-main">
        <div class="request-title"><strong>${escapeHtml(club.name)}</strong> ${statusBadge(club.status)}</div>
        <div class="request-meta">${escapeHtml(club.category)} · submitted ${formatShortDate(club.submitted_at)}</div>
        ${club.review_note ? `<p class="review-note"><strong>Administrator:</strong> ${escapeHtml(club.review_note)}</p>` : ""}
      </div>
      <div class="request-actions">
        ${canEdit ? `<button class="btn btn-secondary btn-sm" data-edit>${club.status === "changes_requested" ? "Edit &amp; resubmit" : "Edit"}</button>` : ""}
        <button class="btn-danger" data-withdraw>${club.status === "rejected" ? "Dismiss" : "Withdraw"}</button>
      </div>`;
    const editBtn = row.querySelector("[data-edit]");
    if (editBtn) editBtn.addEventListener("click", () => openClubRequestModal(club));
    row.querySelector("[data-withdraw]").addEventListener("click", async (e) => {
      const ok = await confirmDialog(
        club.status === "rejected" ? `Remove the rejected request "${club.name}" from your list?` : `Withdraw your request for "${club.name}"?`,
        { title: club.status === "rejected" ? "Dismiss request" : "Withdraw request", confirmText: club.status === "rejected" ? "Dismiss" : "Withdraw", danger: true }
      );
      if (!ok) return;
      await withBusy(e.currentTarget, "…", async () => {
        const { error } = await supabaseClient.rpc("withdraw_submission", { p_kind: "club", p_id: club.id });
        if (error) return showToast(friendlyError(error), "error");
        showToast("Request removed.", "success");
        renderMyClubs();
      });
    });
    list.appendChild(row);
  });
}

// ---------- club request modal (create / edit + resubmit) ----------

const formCreateClub = $("form-create-club");
const createClubError = $("create-club-error");
let editingClubRequestId = null;
let studentOptionsCache = null;

const clubLogoPicker = setupImagePicker({
  input: $("club-logo-input"),
  preview: $("club-logo-preview"),
  removeBtn: $("club-logo-remove"),
  folder: "logos",
  errorEl: createClubError,
});

async function loadStudentOptions() {
  if (studentOptionsCache) return studentOptionsCache;
  const { data } = await supabaseClient
    .from("profiles")
    .select("id, first_name, last_name, graduation_year, class_section")
    .eq("account_type", "student")
    .eq("status", "active")
    .neq("role", "admin")
    .order("first_name");
  studentOptionsCache = data || [];
  return studentOptionsCache;
}

async function openClubRequestModal(club = null) {
  editingClubRequestId = club ? club.id : null;
  $("modal-title").textContent = club ? "Edit club request" : "Request a new club";
  $("modal-submit-btn").textContent = club ? "Resubmit request" : "Submit request";
  createClubError.textContent = "";
  formCreateClub.reset();
  if (categoriesCache.length === 0) await loadCategories();

  const students = await loadStudentOptions();
  $("club-leader").innerHTML = `<option value="${currentUser.id}">Me (${escapeHtml(fullName(currentUser.profile))})</option>` +
    students.filter(s => s.id !== currentUser.id).map(s => `
      <option value="${s.id}">${escapeHtml(fullName(s))}${s.graduation_year ? ` — ${escapeHtml(formatGradeLabel(s.graduation_year, s.class_section))}` : ""}</option>
    `).join("");

  if (club) {
    $("club-name").value = club.name;
    $("club-category").value = club.category;
    $("club-description").value = club.description;
    $("club-leader").value = club.proposed_leader_id || currentUser.id;
  }
  clubLogoPicker.setUrl(club ? club.logo_url : null);
  openModal("modal-overlay");
  $("club-name").focus();
}

$("create-club-btn").addEventListener("click", () => openClubRequestModal());
$("my-clubs-create-btn").addEventListener("click", () => openClubRequestModal());
$("modal-close-btn").addEventListener("click", () => closeModalById("modal-overlay"));
$("modal-cancel-btn").addEventListener("click", () => closeModalById("modal-overlay"));

formCreateClub.addEventListener("submit", async (e) => {
  e.preventDefault();
  createClubError.textContent = "";

  const name = $("club-name").value.trim();
  const category = $("club-category").value;
  const description = $("club-description").value.trim();
  if (name.length < 2) { createClubError.textContent = "Club name must be at least 2 characters."; return; }
  if (description.length < 10) { createClubError.textContent = "Please write a description of at least 10 characters."; return; }

  await withBusy($("modal-submit-btn"), "Submitting…", async () => {
    let logoUrl;
    try {
      logoUrl = await clubLogoPicker.getUrl();
    } catch (err) {
      createClubError.textContent = friendlyError(err);
      return;
    }
    const { error } = await supabaseClient.rpc("submit_club_request", {
      p_name: name,
      p_category: category,
      p_description: description,
      p_logo_url: logoUrl,
      p_proposed_leader: $("club-leader").value || null,
      p_club_id: editingClubRequestId,
    });
    if (error) {
      createClubError.textContent = friendlyError(error);
      return;
    }
    closeModalById("modal-overlay");
    showToast("Request submitted! An administrator will review it before the club appears publicly.", "success");
    navigate("#/my-clubs");
  });
});

// ============================================================
// ANNOUNCEMENTS FEED
// ============================================================

let feedItems = [];
let feedFilter = "all";
let feedShown = 20;
const FEED_PAGE = 20;
const feedFilterButtons = document.querySelectorAll("[data-feed-filter]");

function setFeedFilter(filter) {
  feedFilter = ["all", "school", "club", "events", "updates", "past"].includes(filter) ? filter : "all";
  feedFilterButtons.forEach(b => b.classList.toggle("active", b.dataset.feedFilter === feedFilter));
  feedShown = FEED_PAGE;
}

feedFilterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    setFeedFilter(btn.dataset.feedFilter);
    history.replaceState(null, "", `#/announcements${feedFilter === "all" ? "" : "/" + feedFilter}`);
    renderFeed();
  });
});

$("feed-more-btn").addEventListener("click", () => {
  feedShown += FEED_PAGE;
  renderFeed();
});

async function loadFeed() {
  const list = $("feed-list");
  list.innerHTML = loadingHtml("Loading announcements…");
  $("feed-empty").hidden = true;

  const [{ data: school, error: e1 }, { data: posts, error: e2 }] = await Promise.all([
    supabaseClient.from("announcements").select("*").order("created_at", { ascending: false }).limit(300),
    supabaseClient.from("club_posts").select(POST_SELECT).eq("status", "approved").order("published_at", { ascending: false }).limit(500),
  ]);
  if (e1 || e2) {
    list.innerHTML = errorStateHtml("Couldn't load announcements. Please refresh.");
    return;
  }

  const today = todayDateStr();
  const now = new Date();
  feedItems = [
    ...school.map(a => ({
      source: "school",
      kind: a.event_date ? "event" : "announcement",
      isPast: !!a.event_date && new Date(a.event_date) < now,
      sortDate: a.created_at,
      eventSort: a.event_date,
      data: a,
    })),
    ...posts.filter(p => p.club && p.club.status !== "suspended").map(p => ({
      source: "club",
      kind: p.kind,
      isPast: p.kind === "event" && p.event_date < today,
      sortDate: p.published_at || p.created_at,
      eventSort: p.event_date ? `${p.event_date}T${p.start_time || "00:00"}` : null,
      data: p,
    })),
  ];
  renderFeed();
}

function filteredFeed() {
  let items;
  switch (feedFilter) {
    case "school":
      items = feedItems.filter(i => i.source === "school" && !i.isPast);
      break;
    case "club":
      items = feedItems.filter(i => i.source === "club" && i.kind === "announcement");
      break;
    case "events":
      return feedItems.filter(i => i.kind === "event" && !i.isPast)
        .sort((a, b) => String(a.eventSort).localeCompare(String(b.eventSort)));
    case "updates":
      items = feedItems.filter(i => i.kind === "event_result");
      break;
    case "past":
      return feedItems.filter(i => i.kind === "event" && i.isPast)
        .sort((a, b) => String(b.eventSort).localeCompare(String(a.eventSort)));
    default:
      // past events are archived into each club's event history
      items = feedItems.filter(i => !i.isPast);
  }
  return items.sort((a, b) => new Date(b.sortDate) - new Date(a.sortDate));
}

function renderFeed() {
  const list = $("feed-list");
  const items = filteredFeed();
  list.innerHTML = "";
  $("feed-empty").hidden = items.length !== 0;
  items.slice(0, feedShown).forEach(item => {
    list.appendChild(item.source === "school"
      ? renderSchoolAnnouncementCard(item.data, item.isPast)
      : renderClubPostCard(item.data, { showClub: true }));
  });
  $("feed-more-btn").hidden = items.length <= feedShown;
}

const POST_KIND_TAGS = {
  announcement: ["Club announcement", "is-news"],
  event: ["Upcoming event", "is-upcoming"],
  event_result: ["Event update", "is-result"],
};

function photoGridHtml(photos) {
  const sorted = (photos || []).slice().sort((a, b) => a.position - b.position).slice(0, 3);
  if (sorted.length === 0) return "";
  return `<div class="photo-grid photos-${sorted.length}">${sorted.map(p => `
    <a href="${escapeHtml(p.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(p.url)}" alt="Event photo" loading="lazy"></a>
  `).join("")}</div>`;
}

function eventDetailsHtml(post) {
  if (post.kind !== "event") return "";
  return `
    <div class="event-details">
      <span>${icon("calendar")}${escapeHtml(formatEventDay(post.event_date))}</span>
      ${post.start_time ? `<span>${icon("clock")}${escapeHtml(formatTimeRange(post.start_time, post.end_time))}</span>` : ""}
      ${post.location ? `<span>${icon("mapPin")}${escapeHtml(post.location)}</span>` : ""}
    </div>`;
}

// One card for any approved club post. The club is shown as the author.
function renderClubPostCard(post, { showClub = true, parentTitle = null } = {}) {
  const card = document.createElement("article");
  const isPastEvent = post.kind === "event" && post.event_date < todayDateStr();
  card.className = "announcement-card feed-card" + (isPastEvent ? " is-past" : "");
  let [tagText, tagClass] = POST_KIND_TAGS[post.kind] || ["Post", "is-news"];
  if (isPastEvent) { tagText = "Completed event"; tagClass = "is-past"; }
  const club = post.club || {};

  card.innerHTML = `
    <header class="announcement-card-head">
      ${showClub ? `
        <a class="feed-club-logo" href="#/club/${club.id}" data-category="${escapeHtml(club.category || "Other")}">${clubLogoHtml(club)}</a>
        <span class="announcement-card-source">
          <a href="#/club/${club.id}"><strong>${escapeHtml(club.name || "Club")}</strong></a>
          <span>Posted on ${formatShortDate(post.published_at || post.created_at)}</span>
        </span>` : `
        <span class="announcement-card-source">
          <span>Posted on ${formatShortDate(post.published_at || post.created_at)}</span>
        </span>`}
      <span class="announcement-tag ${tagClass}">${tagText}</span>
    </header>
    ${post.cover_url ? `<img class="feed-cover" src="${escapeHtml(post.cover_url)}" alt="" loading="lazy">` : ""}
    <h4>${escapeHtml(post.title)}</h4>
    ${eventDetailsHtml(post)}
    ${post.kind === "event_result" && parentTitle ? `<p class="feed-parent">Results of: <strong>${escapeHtml(parentTitle)}</strong></p>` : ""}
    ${post.body ? `<p class="announcement-card-description preserve-lines">${escapeHtml(post.body)}</p>` : ""}
    ${photoGridHtml(post.photos)}
  `;
  return card;
}

// ============================================================
// STUDENTS DIRECTORY
// ============================================================

let allPeopleCache = [];
let currentClubsByUser = {};
let activePeopleFilter = "all";
let studentsShown = 36;
const STUDENTS_PAGE = 36;
const studentsSearchInput = $("students-search");

const peopleFilterButtons = document.querySelectorAll("[data-people-filter]");
peopleFilterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    peopleFilterButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activePeopleFilter = btn.dataset.peopleFilter;
    studentsShown = STUDENTS_PAGE;
    applyStudentSearch();
  });
});

["students-grade", "students-class"].forEach(id => $(id).addEventListener("change", () => {
  studentsShown = STUDENTS_PAGE;
  applyStudentSearch();
}));
studentsSearchInput.addEventListener("input", () => {
  studentsShown = STUDENTS_PAGE;
  applyStudentSearch();
});
$("students-more-btn").addEventListener("click", () => {
  studentsShown += STUDENTS_PAGE;
  applyStudentSearch();
});

function profileSubtitle(profile) {
  if (profile.account_type === "teacher") return "Teacher";
  return formatGradeLabel(profile.graduation_year, profile.class_section) || "Student";
}

async function renderStudents() {
  const grid = $("students-grid");
  if (allPeopleCache.length === 0) grid.innerHTML = loadingHtml("Loading people…");

  const [{ data: people, error }, { data: memberships }] = await Promise.all([
    supabaseClient
      .from("profiles")
      .select("id, first_name, last_name, account_type, graduation_year, class_section, role, status")
      .in("account_type", ["student", "teacher"])
      .neq("role", "admin")
      .order("first_name", { ascending: true }),
    supabaseClient
      .from("club_members")
      .select("user_id, club:clubs(id, name, status)")
      .eq("status", "approved"),
  ]);

  if (error) {
    grid.innerHTML = errorStateHtml("Couldn't load the directory.");
    return;
  }

  currentClubsByUser = {};
  (memberships || []).forEach(m => {
    if (!m.club || m.club.status !== "approved") return;
    (currentClubsByUser[m.user_id] = currentClubsByUser[m.user_id] || []).push(m.club);
  });

  allPeopleCache = people.filter(p => p.status !== "suspended");
  applyStudentSearch();
}

function applyStudentSearch() {
  let term = studentsSearchInput.value.trim().toLowerCase();
  let gradeFilter = $("students-grade").value;
  let classFilter = $("students-class").value;

  // "10B", "10 b" or "grade 10" in the search box work as grade/class filters
  const gradeMatch = term.match(/^(?:grade\s*)?(\d{1,2})\s*([abc])?$/i);
  if (gradeMatch) {
    gradeFilter = gradeMatch[1];
    if (gradeMatch[2]) classFilter = gradeMatch[2].toUpperCase();
    term = "";
  }

  const filtered = allPeopleCache.filter(p => {
    if (activePeopleFilter !== "all" && p.account_type !== activePeopleFilter) return false;
    if (gradeFilter || classFilter) {
      if (p.account_type !== "student" || !p.graduation_year) return false;
      if (gradeFilter && String(computeCurrentGrade(p.graduation_year)) !== gradeFilter) return false;
      if (classFilter && p.class_section !== classFilter) return false;
    }
    return !term || fullName(p).toLowerCase().includes(term);
  });

  const grid = $("students-grid");
  grid.innerHTML = "";
  $("students-empty").hidden = filtered.length !== 0;
  $("students-count").textContent = filtered.length ? `${filtered.length} ${filtered.length === 1 ? "person" : "people"}` : "";

  filtered.slice(0, studentsShown).forEach(p => {
    const isTeacher = p.account_type === "teacher";
    const clubs = currentClubsByUser[p.id] || [];
    const card = document.createElement("a");
    card.className = "person-card";
    card.href = `#/student/${p.id}`;
    card.innerHTML = `
      <span class="person-avatar">${escapeHtml(initials(p))}</span>
      <span class="person-info">
        <span class="person-name">${escapeHtml(fullName(p))}</span>
        <span class="person-meta">${icon(isTeacher ? "book" : "gradCap")}${escapeHtml(profileSubtitle(p))}</span>
        ${!isTeacher && clubs.length ? `<span class="person-clubs">${clubs.slice(0, 2).map(c => `<span class="mini-chip">${escapeHtml(c.name)}</span>`).join("")}${clubs.length > 2 ? `<span class="mini-chip is-more">+${clubs.length - 2}</span>` : ""}</span>` : ""}
      </span>
      <span class="person-chevron">${icon("chevronRight")}</span>
    `;
    grid.appendChild(card);
  });
  $("students-more-btn").hidden = filtered.length <= studentsShown;
}

// ============================================================
// STUDENT PROFILE / MY PROFILE
// ============================================================

let profileShownId = null;
$("student-profile-back-btn").addEventListener("click", goBack);

async function showStudentProfile(userId, isOwn) {
  profileShownId = userId;
  $("student-profile-back-btn").hidden = isOwn;
  $("student-profile-name").textContent = "Loading…";
  $("student-profile-meta").textContent = "";
  $("student-profile-avatar").textContent = "";
  $("student-profile-bio").textContent = "";
  ["student-profile-current", "student-profile-history", "student-profile-leadership"].forEach(id => { $(id).innerHTML = ""; });
  $("my-applications-card").hidden = true;
  $("my-account-card").hidden = true;

  const [{ data: profile, error }, { data: history }, { data: leaderships }] = await Promise.all([
    supabaseClient.from("profiles").select("*").eq("id", userId).single(),
    supabaseClient
      .from("club_members")
      .select("*, club:clubs(id, name, category, logo_url, status)")
      .eq("user_id", userId)
      .order("joined_at", { ascending: false }),
    supabaseClient
      .from("club_leaders")
      .select("*, club:clubs(id, name, category, logo_url, status)")
      .eq("user_id", userId)
      .order("started_at", { ascending: false }),
  ]);

  if (profileShownId !== userId) return; // user navigated away meanwhile
  if (error || !profile) {
    showNotFound("This profile doesn't exist.");
    return;
  }

  const isTeacher = profile.account_type === "teacher";
  $("student-profile-avatar").textContent = initials(profile);
  $("student-profile-name").textContent = fullName(profile);
  $("student-profile-meta").textContent = profile.role === "admin" ? "Administrator" : profileSubtitle(profile);
  $("student-profile-bio").textContent = profile.bio || "No bio yet.";
  $("student-profile-bio").classList.toggle("is-empty", !profile.bio);
  $("student-profile-edit-btn").hidden = !isOwn;
  $("student-profile-edit-btn").onclick = () => openEditProfileModal(profile);
  $("student-profile-club-sections").hidden = isTeacher || profile.role === "admin";

  const rows = (history || []).filter(h => h.club);
  const leads = (leaderships || []).filter(l => l.club);
  const activeLeadByClub = {};
  leads.filter(l => !l.ended_at).forEach(l => { activeLeadByClub[l.club_id] = l.position; });

  const current = rows.filter(h => h.status === "approved");
  const previous = rows.filter(h => h.status === "left").sort((a, b) => new Date(b.left_at) - new Date(a.left_at));

  renderMembershipList($("student-profile-current"), current, { activeLeadByClub, isOwn });
  $("student-profile-current-empty").hidden = current.length !== 0;
  renderMembershipList($("student-profile-history"), previous, { activeLeadByClub: {}, isOwn });
  $("student-profile-history-empty").hidden = previous.length !== 0;

  $("student-profile-leadership-card").hidden = leads.length === 0;
  $("student-profile-leadership").innerHTML = leads.map(l => `
    <a class="leadership-row" href="#/club/${l.club.id}">
      <span class="history-icon" data-category="${escapeHtml(l.club.category)}">${clubLogoHtml(l.club)}</span>
      <span class="leadership-main">
        <strong>${escapeHtml(l.club.name)}</strong>
        <span>${l.position === "leader" ? "Leader" : "Co-leader"}</span>
      </span>
      <span class="leadership-dates">${formatLongDate(l.started_at)} – ${l.ended_at ? formatLongDate(l.ended_at) : "Present"}</span>
    </a>`).join("");

  if (isOwn) {
    $("my-account-card").hidden = false;
    $("my-account-email").innerHTML = `Signed in as <strong>${escapeHtml(currentUser.email)}</strong>`;
    if (currentUser.isStudent) {
      $("my-applications-card").hidden = false;
      loadMyApplications();
    }
  }
}

function renderMembershipList(container, rows, { activeLeadByClub, isOwn }) {
  container.innerHTML = "";
  rows.forEach(h => {
    const isCurrent = h.status === "approved";
    const club = h.club;
    const position = activeLeadByClub[club.id];
    const role = position === "leader" ? "Leader" : position === "co_leader" ? "Co-leader" : "Member";
    const item = document.createElement("div");
    item.className = "history-item" + (isCurrent ? " is-current" : "");
    item.innerHTML = `
      <span class="history-dot" aria-hidden="true"></span>
      <a class="history-card" href="#/club/${club.id}">
        <span class="history-icon${club.logo_url ? " has-logo" : ""}" data-category="${escapeHtml(club.category)}">${clubLogoHtml(club)}</span>
        <div class="history-body">
          <h4>${escapeHtml(club.name)}${club.status === "archived" ? ' <span class="muted-tag">Archived</span>' : ""}</h4>
          <span class="history-status">${isCurrent ? "Current Member" : h.end_reason === "removed" ? "Membership ended" : "Past Member"}</span>
          <div class="history-meta">
            <div class="history-meta-item">
              ${icon("user")}
              <div><span class="history-meta-label">Role</span><span class="history-meta-value">${role}</span></div>
            </div>
            <div class="history-meta-item">
              ${icon("calendar")}
              <div><span class="history-meta-label">${isCurrent ? "Member since" : "Membership"}</span>
              <span class="history-meta-value">${formatLongDate(h.joined_at)} – ${isCurrent ? "Present" : formatLongDate(h.left_at)}</span></div>
            </div>
          </div>
          ${isCurrent && isOwn && h.leave_requested_at ? `<span class="pill pill-pending pill-inline">Leave requested ${formatShortDate(h.leave_requested_at)}</span>` : ""}
        </div>
      </a>`;
    container.appendChild(item);
  });
}

// ---------- my applications ----------

let myApplicationsCache = [];
let myApplicationsFilter = "all";
const appFilterButtons = document.querySelectorAll("[data-app-filter]");
appFilterButtons.forEach(btn => btn.addEventListener("click", () => {
  myApplicationsFilter = btn.dataset.appFilter;
  appFilterButtons.forEach(b => b.classList.toggle("active", b === btn));
  renderMyApplications();
}));

async function loadMyApplications() {
  const list = $("my-applications-list");
  list.innerHTML = loadingHtml();
  const { data, error } = await supabaseClient
    .from("applications")
    .select("*, club:clubs(id, name, category, logo_url)")
    .eq("user_id", currentUser.id)
    .order("submitted_at", { ascending: false });
  if (error) {
    list.innerHTML = errorStateHtml();
    return;
  }
  myApplicationsCache = data;
  renderMyApplications();
}

function renderMyApplications() {
  const rows = myApplicationsCache.filter(a => myApplicationsFilter === "all" || a.status === myApplicationsFilter);
  const list = $("my-applications-list");
  list.innerHTML = "";
  $("my-applications-empty").hidden = rows.length !== 0;

  rows.forEach(a => {
    const club = a.club || { name: "Removed club", category: "Other" };
    const row = document.createElement("div");
    row.className = "request-row";
    row.innerHTML = `
      <span class="request-logo" data-category="${escapeHtml(club.category)}">${clubLogoHtml(club)}</span>
      <div class="request-main">
        <div class="request-title">${a.club ? `<a href="#/club/${club.id}"><strong>${escapeHtml(club.name)}</strong></a>` : `<strong>${escapeHtml(club.name)}</strong>`} ${statusBadge(a.status)}</div>
        <div class="request-meta">Applied ${formatShortDate(a.submitted_at)}${a.decided_at && a.status !== "pending" ? ` · ${STATUS_LABELS[a.status]} ${formatShortDate(a.decided_at)}` : ""}</div>
      </div>
      <div class="request-actions">
        ${a.status === "pending" ? `<button class="btn btn-secondary btn-sm" data-withdraw>Withdraw</button>` : ""}
      </div>`;
    const btn = row.querySelector("[data-withdraw]");
    if (btn) btn.addEventListener("click", () => withdrawApplication(a.id, club.name, btn, loadMyApplications));
    list.appendChild(row);
  });
}

async function withdrawApplication(applicationId, clubName, btn, after) {
  const ok = await confirmDialog(`Withdraw your application to ${clubName}?`, { title: "Withdraw application", confirmText: "Withdraw", danger: true });
  if (!ok) return;
  await withBusy(btn, "…", async () => {
    const { error } = await supabaseClient.rpc("withdraw_application", { p_application: applicationId });
    if (error) return showToast(friendlyError(error), "error");
    showToast("Application withdrawn.", "success");
    if (after) after();
  });
}

// ---------- change password ----------

$("form-change-password").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = $("cp-error");
  errorEl.textContent = "";
  const current = $("cp-current").value;
  const next = $("cp-new").value;
  const confirmValue = $("cp-confirm").value;
  if (!current) { errorEl.textContent = "Enter your current password."; return; }
  const problem = validatePassword(next);
  if (problem) { errorEl.textContent = problem; return; }
  if (next !== confirmValue) { errorEl.textContent = "New passwords do not match."; return; }
  if (next === current) { errorEl.textContent = "The new password must be different from the current one."; return; }

  await withBusy($("cp-submit-btn"), "Updating…", async () => {
    // re-check the current password before allowing the change
    const { error: checkErr } = await supabaseClient.auth.signInWithPassword({ email: currentUser.email, password: current });
    if (checkErr) {
      errorEl.textContent = /rate|too many/i.test(checkErr.message) ? "Too many attempts. Please wait a minute." : "Your current password is incorrect.";
      return;
    }
    const { error } = await supabaseClient.auth.updateUser({ password: next });
    if (error) {
      errorEl.textContent = friendlyError(error);
      return;
    }
    await supabaseClient.auth.signOut({ scope: "others" });
    e.target.reset();
    showToast("Password changed. Other devices have been signed out.", "success");
  });
});

// ---------- edit profile modal ----------

const formEditProfile = $("form-edit-profile");
const editProfileError = $("edit-profile-error");

function openEditProfileModal(profile) {
  editProfileError.textContent = "";
  $("edit-profile-bio").value = profile.bio || "";
  openModal("edit-profile-modal-overlay");
}

$("edit-profile-modal-close-btn").addEventListener("click", () => closeModalById("edit-profile-modal-overlay"));
$("edit-profile-modal-cancel-btn").addEventListener("click", () => closeModalById("edit-profile-modal-overlay"));

formEditProfile.addEventListener("submit", async (e) => {
  e.preventDefault();
  editProfileError.textContent = "";
  const bio = $("edit-profile-bio").value.trim();
  if (bio.length > 1000) { editProfileError.textContent = "Bio must be at most 1000 characters."; return; }

  await withBusy(formEditProfile.querySelector("button[type=submit]"), "Saving…", async () => {
    const { error } = await supabaseClient.from("profiles").update({ bio }).eq("id", currentUser.id);
    if (error) {
      editProfileError.textContent = friendlyError(error);
      return;
    }
    currentUser.profile.bio = bio;
    closeModalById("edit-profile-modal-overlay");
    showToast("Profile updated.", "success");
    showStudentProfile(currentUser.id, true);
  });
});

// ============================================================
// CLUB DETAIL
// ============================================================

let currentClubDetail = null;   // { club, leaders, members, posts, achievements, ... }
const detailTabs = document.querySelectorAll(".detail-tab[data-detail-tab]");
const DETAIL_PANELS = ["overview", "members", "announcements", "upcoming", "history", "achievements"];

$("detail-back-btn").addEventListener("click", goBack);

function selectDetailTab(tab) {
  if (!DETAIL_PANELS.includes(tab)) tab = "overview";
  detailTabs.forEach(t => t.classList.toggle("active", t.dataset.detailTab === tab));
  DETAIL_PANELS.forEach(p => $(`detail-panel-${p}`).classList.toggle("active", p === tab));
}

detailTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    selectDetailTab(tab.dataset.detailTab);
    if (currentClubDetail) history.replaceState(null, "", `#/club/${currentClubDetail.club.id}/${tab.dataset.detailTab}`);
  });
});

async function showClubDetail(clubId, tab = "overview") {
  selectDetailTab(tab);
  const card = $("club-detail-card");
  card.classList.add("is-loading");
  $("detail-name").textContent = "Loading…";
  ["detail-meta", "detail-leaders", "detail-description", "detail-recruitment", "detail-status", "detail-category"].forEach(id => { $(id).textContent = ""; });
  $("detail-actions").innerHTML = "";
  $("detail-admin-controls").hidden = true;
  $("detail-facts").innerHTML = "";

  const { data: club, error } = await supabaseClient.from("clubs").select("*").eq("id", clubId).maybeSingle();
  if (error || !club) {
    card.classList.remove("is-loading");
    showNotFound("This club doesn't exist, or it isn't public yet.");
    return;
  }

  const queries = [
    supabaseClient
      .from("club_leaders")
      .select("id, user_id, position, started_at, profile:profiles!club_leaders_user_id_fkey(id, first_name, last_name)")
      .eq("club_id", clubId)
      .is("ended_at", null),
    supabaseClient
      .from("club_members")
      .select("*, profile:profiles(id, first_name, last_name, graduation_year, class_section)")
      .eq("club_id", clubId)
      .eq("status", "approved")
      .order("joined_at", { ascending: true }),
    supabaseClient
      .from("club_posts")
      .select(POST_SELECT)
      .eq("club_id", clubId)
      .eq("status", "approved")
      .order("published_at", { ascending: false }),
    supabaseClient
      .from("club_achievements")
      .select("*")
      .eq("club_id", clubId)
      .eq("status", "approved")
      .order("achieved_on", { ascending: false }),
    supabaseClient
      .from("questionnaires")
      .select("id")
      .eq("club_id", clubId)
      .eq("status", "approved")
      .maybeSingle(),
    currentUser.isStudent
      ? supabaseClient.from("applications").select("id, status").eq("club_id", clubId).eq("user_id", currentUser.id).eq("status", "pending").maybeSingle()
      : Promise.resolve({ data: null }),
  ];
  const [leadersRes, membersRes, postsRes, achRes, formRes, appRes] = await Promise.all(queries);

  if (parseRoute().params[0] !== clubId) return; // navigated away

  const leaders = (leadersRes.data || []).sort((a, b) => (a.position === "leader" ? -1 : 1) - (b.position === "leader" ? -1 : 1));
  const members = membersRes.data || [];
  const posts = postsRes.data || [];
  currentClubDetail = {
    club,
    leaders,
    members,
    posts,
    achievements: achRes.data || [],
    hasLiveForm: !!formRes.data,
    myMembership: members.find(m => m.user_id === currentUser.id) || null,
    myPendingApplication: appRes.data || null,
  };

  card.classList.remove("is-loading");
  renderClubHeader(currentClubDetail);
  renderClubOverview(currentClubDetail);
  renderClubMembers(currentClubDetail);
  renderClubPosts(currentClubDetail);
  renderClubAchievements(currentClubDetail);
  renderAdminControls(currentClubDetail);
}

function renderClubHeader(d) {
  const { club, leaders, members } = d;
  $("detail-banner").dataset.category = club.category;
  $("detail-logo").innerHTML = clubLogoHtml(club);
  $("detail-logo").classList.toggle("has-logo", !!club.logo_url);
  $("detail-category").textContent = club.category;
  $("detail-category").dataset.category = club.category;
  $("detail-name").textContent = club.name;

  $("detail-recruitment").innerHTML = club.status === "approved"
    ? (club.recruitment_open ? '<span class="status-badge is-open">Recruiting</span>' : '<span class="status-badge is-closed">Recruitment closed</span>')
    : "";
  $("detail-status").innerHTML = club.status !== "approved" ? statusBadge(club.status) : "";

  $("detail-meta").textContent = `Founded ${formatDateOnly(club.created_at)} · ${members.length} member${members.length === 1 ? "" : "s"}`;

  const main = leaders.filter(l => l.position === "leader");
  const co = leaders.filter(l => l.position === "co_leader");
  const link = l => `<a href="#/student/${l.user_id}">${escapeHtml(fullName(l.profile))}</a>`;
  $("detail-leaders").innerHTML = [
    main.length ? `${icon("star")}Led by ${main.map(link).join(", ")}` : "",
    co.length ? `Co-leader${co.length > 1 ? "s" : ""}: ${co.map(link).join(", ")}` : "",
  ].filter(Boolean).join('<span class="dot-sep">·</span>') || '<span class="muted">No leader assigned yet</span>';

  renderDetailActions(d);
}

function renderDetailActions(d) {
  const { club, myMembership, myPendingApplication, hasLiveForm } = d;
  const actions = $("detail-actions");
  actions.innerHTML = "";
  const add = html => actions.insertAdjacentHTML("beforeend", html);

  if (isLeaderOf(club.id)) {
    add(`<a class="btn btn-primary btn-sm btn-with-icon" href="#/lead/${club.id}">${icon("settings")}Manage club</a>`);
    return;
  }
  if (currentUser.isAdmin) {
    add(`<span class="pill pill-member">Administrator view</span>`);
    return;
  }
  if (currentUser.isTeacher) {
    add(`<span class="pill pill-muted" title="Teacher accounts can view clubs but not join them">${icon("eye")}View only</span>`);
    return;
  }
  if (club.status !== "approved") return;

  if (myMembership) {
    if (myMembership.leave_requested_at) {
      add(`<span class="pill pill-pending">Leave requested</span>`);
      add(`<button class="btn btn-secondary btn-sm" id="cancel-leave-btn">Cancel request</button>`);
      $("cancel-leave-btn").addEventListener("click", async (e) => {
        await withBusy(e.currentTarget, "…", async () => {
          const { error } = await supabaseClient.rpc("cancel_leave_request", { p_club: club.id });
          if (error) return showToast(friendlyError(error), "error");
          showToast("Leave request cancelled.", "success");
          showClubDetail(club.id, currentDetailTab());
        });
      });
    } else {
      add(`<span class="pill pill-member">Member</span>`);
      add(`<button class="btn btn-secondary btn-sm" id="leave-club-btn">Request to leave</button>`);
      $("leave-club-btn").addEventListener("click", async (e) => {
        const ok = await confirmDialog(`Ask the leaders of ${club.name} to end your membership? Your membership stays on your club history.`, { title: "Leave club", confirmText: "Send request", danger: true });
        if (!ok) return;
        await withBusy(e.currentTarget, "…", async () => {
          const { error } = await supabaseClient.rpc("request_leave", { p_club: club.id });
          if (error) return showToast(friendlyError(error), "error");
          showToast("Leave request sent to the club leaders.", "success");
          showClubDetail(club.id, currentDetailTab());
        });
      });
    }
    return;
  }

  if (myPendingApplication) {
    add(`<span class="pill pill-pending">Application pending</span>`);
    add(`<button class="btn btn-secondary btn-sm" id="withdraw-app-btn">Withdraw</button>`);
    const btn = $("withdraw-app-btn");
    btn.addEventListener("click", () => withdrawApplication(myPendingApplication.id, club.name, btn, () => showClubDetail(club.id, currentDetailTab())));
    return;
  }

  if (club.recruitment_open && hasLiveForm) {
    add(`<button class="btn btn-primary btn-sm btn-with-icon" id="apply-btn">${icon("arrowRight")}Apply to Join</button>`);
    $("apply-btn").addEventListener("click", () => openApplyModal(club));
  } else {
    add(`<span class="pill pill-muted">Recruitment closed</span>`);
  }
}

function currentDetailTab() {
  const active = document.querySelector(".detail-tab[data-detail-tab].active");
  return active ? active.dataset.detailTab : "overview";
}

function renderClubOverview(d) {
  const { club, leaders, members, posts, achievements } = d;
  $("detail-description").textContent = club.description;
  const today = todayDateStr();
  const upcoming = posts.filter(p => p.kind === "event" && p.event_date >= today).length;
  const completed = posts.filter(p => p.kind === "event" && p.event_date < today).length;
  const facts = [
    ["Category", escapeHtml(club.category)],
    ["Founded", escapeHtml(formatDateOnly(club.created_at))],
    ["Members", String(members.length)],
    ["Recruitment", club.recruitment_open ? "Open" : "Closed"],
    ["Upcoming events", String(upcoming)],
    ["Completed events", String(completed)],
    ["Achievements", String(achievements.length)],
    ["Leadership", leaders.length ? leaders.map(l => `${escapeHtml(fullName(l.profile))} <span class="muted">(${l.position === "leader" ? "Leader" : "Co-leader"})</span>`).join("<br>") : '<span class="muted">Not assigned</span>'],
  ];
  $("detail-facts").innerHTML = facts.map(([k, v]) => `<div class="fact"><span class="fact-label">${k}</span><span class="fact-value">${v}</span></div>`).join("");
}

function renderClubMembers(d) {
  const { leaders, members } = d;
  const positionByUser = {};
  leaders.forEach(l => { positionByUser[l.user_id] = l.position; });
  const order = m => positionByUser[m.user_id] === "leader" ? 0 : positionByUser[m.user_id] === "co_leader" ? 1 : 2;
  const list = $("detail-members-list");
  list.innerHTML = "";
  $("detail-members-heading").textContent = `Current members (${members.length})`;
  $("detail-members-empty").hidden = members.length !== 0;

  members.slice().sort((a, b) => order(a) - order(b) || fullName(a.profile).localeCompare(fullName(b.profile))).forEach(m => {
    const pos = positionByUser[m.user_id];
    const row = document.createElement("a");
    row.className = "member-row";
    row.href = `#/student/${m.user_id}`;
    row.innerHTML = `
      <div class="member-row-name">
        <span class="member-row-avatar">${escapeHtml(initials(m.profile))}</span>
        <span>
          ${escapeHtml(fullName(m.profile))}
          <span class="member-row-sub">${escapeHtml(formatGradeLabel(m.profile.graduation_year, m.profile.class_section))}${m.profile.graduation_year ? " · " : ""}since ${formatShortDate(m.joined_at)}</span>
        </span>
      </div>
      ${pos ? `<span class="member-owner-tag">${pos === "leader" ? "Leader" : "Co-leader"}</span>` : ""}
    `;
    list.appendChild(row);
  });
}

function renderClubPosts(d) {
  const { club, posts } = d;
  const today = todayDateStr();
  const withClub = posts.map(p => ({ ...p, club }));
  const byId = {};
  withClub.forEach(p => { byId[p.id] = p; });

  // Announcements tab: club announcements, newest first
  const announcements = withClub.filter(p => p.kind === "announcement");
  const annList = $("detail-announcements-list");
  annList.innerHTML = "";
  announcements.forEach(p => annList.appendChild(renderClubPostCard(p, { showClub: false })));
  $("detail-announcements-empty").hidden = announcements.length !== 0;

  // Upcoming tab: events from today on, soonest first
  const upcoming = withClub
    .filter(p => p.kind === "event" && p.event_date >= today)
    .sort((a, b) => `${a.event_date}${a.start_time || ""}`.localeCompare(`${b.event_date}${b.start_time || ""}`));
  const upList = $("detail-upcoming-list");
  upList.innerHTML = "";
  upcoming.forEach(p => upList.appendChild(renderClubPostCard(p, { showClub: false })));
  $("detail-upcoming-empty").hidden = upcoming.length !== 0;

  // Event history: completed events (newest first), each with its results
  const resultsByEvent = {};
  withClub.filter(p => p.kind === "event_result").forEach(r => {
    (resultsByEvent[r.parent_event_id] = resultsByEvent[r.parent_event_id] || []).push(r);
  });
  const completed = withClub.filter(p => p.kind === "event" && p.event_date < today).sort((a, b) => b.event_date.localeCompare(a.event_date));
  const orphanResults = withClub.filter(p => p.kind === "event_result" && (!p.parent_event_id || !byId[p.parent_event_id]));

  const hist = $("detail-history-list");
  hist.innerHTML = "";
  completed.forEach(ev => {
    const results = (resultsByEvent[ev.id] || []).sort((a, b) => new Date(a.published_at) - new Date(b.published_at));
    const el = document.createElement("article");
    el.className = "history-event";
    el.innerHTML = `
      <div class="history-event-date">
        <strong>${parseDateOnly(ev.event_date).getDate()}</strong>
        <span>${parseDateOnly(ev.event_date).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</span>
      </div>
      <div class="history-event-body">
        <h4>${escapeHtml(ev.title)}</h4>
        ${eventDetailsHtml(ev)}
        ${ev.body ? `<p class="preserve-lines">${escapeHtml(ev.body)}</p>` : ""}
        ${results.map(r => `
          <div class="history-result">
            <span class="history-result-label">${icon("check")}Results · posted ${formatShortDate(r.published_at)}</span>
            ${r.title !== ev.title ? `<strong>${escapeHtml(r.title)}</strong>` : ""}
            ${r.body ? `<p class="preserve-lines">${escapeHtml(r.body)}</p>` : ""}
            ${photoGridHtml(r.photos)}
          </div>`).join("")}
        ${results.length === 0 && ev.cover_url ? `<img class="history-event-cover" src="${escapeHtml(ev.cover_url)}" alt="" loading="lazy">` : ""}
      </div>`;
    hist.appendChild(el);
  });
  orphanResults.forEach(r => hist.appendChild(renderClubPostCard(r, { showClub: false })));
  $("detail-history-empty").hidden = completed.length + orphanResults.length !== 0;
}

function renderClubAchievements(d) {
  const list = $("detail-achievements-list");
  list.innerHTML = d.achievements.map(a => `
    <article class="achievement-card">
      ${a.image_url ? `<img src="${escapeHtml(a.image_url)}" alt="" loading="lazy">` : `<span class="achievement-icon">${icon("trophy")}</span>`}
      <div>
        <h4>${escapeHtml(a.title)}</h4>
        <span class="achievement-date">${formatLongDate(a.achieved_on)}</span>
        ${a.description ? `<p class="preserve-lines">${escapeHtml(a.description)}</p>` : ""}
      </div>
    </article>`).join("");
  $("detail-achievements-empty").hidden = d.achievements.length !== 0;
}

// Administrators get moderation controls right on the club page.
function renderAdminControls(d) {
  const el = $("detail-admin-controls");
  if (!currentUser.isAdmin) { el.hidden = true; return; }
  const { club } = d;
  el.hidden = false;
  const managed = ["approved", "suspended", "archived"].includes(club.status);
  el.innerHTML = `
    <span class="admin-controls-label">${icon("shield")}Admin</span>
    ${managed && club.status !== "approved" ? `<button class="btn btn-secondary btn-sm" data-admin-status="approved">Reactivate</button>` : ""}
    ${club.status === "approved" ? `<button class="btn btn-secondary btn-sm" data-admin-status="suspended">Suspend</button>` : ""}
    ${managed && club.status !== "archived" ? `<button class="btn btn-secondary btn-sm" data-admin-status="archived">Archive</button>` : ""}
    <a class="btn btn-secondary btn-sm" href="/admin.html#clubs/${club.id}">Edit, leaders &amp; members</a>
  `;
  el.querySelectorAll("[data-admin-status]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const status = btn.dataset.adminStatus;
      const verb = status === "approved" ? "Reactivate" : status === "suspended" ? "Suspend" : "Archive";
      const ok = await confirmDialog(
        status === "archived" ? `Archive ${club.name}? It will be hidden from the directory, recruitment closes, and all history is kept.`
          : status === "suspended" ? `Suspend ${club.name}? It will be hidden from the directory and can't recruit or post until reactivated.`
          : `Reactivate ${club.name}?`,
        { title: `${verb} club`, confirmText: verb, danger: status !== "approved" });
      if (!ok) return;
      await withBusy(btn, "…", async () => {
        const { error } = await supabaseClient.rpc("admin_set_club_status", { p_club: club.id, p_status: status });
        if (error) return showToast(friendlyError(error), "error");
        showToast(`Club ${status === "approved" ? "reactivated" : status}.`, "success");
        showClubDetail(club.id, currentDetailTab());
      });
    });
  });
}

// ============================================================
// QUESTIONNAIRE RENDERING (apply modal + leader preview)
// ============================================================

// Renders an application form. `questions` are questionnaire_questions rows.
function renderQuestionnaireForm(container, questionnaire, questions, prefix = "q") {
  container.innerHTML = `
    ${questionnaire.intro ? `<p class="form-intro preserve-lines">${escapeHtml(questionnaire.intro)}</p>` : ""}
    ${questions.map((q, i) => {
      const id = `${prefix}-${i}`;
      const req = q.required ? '<span class="req" aria-hidden="true">*</span>' : '<span class="optional">(optional)</span>';
      const help = q.help_text ? `<span class="field-hint">${escapeHtml(q.help_text)}</span>` : "";
      let input;
      if (q.type === "short_text") {
        input = `<input type="text" id="${id}" maxlength="300" data-qid="${q.id}">`;
      } else if (q.type === "long_text") {
        input = `<textarea id="${id}" rows="4" maxlength="3000" data-qid="${q.id}"></textarea>`;
      } else {
        const type = q.type === "single_choice" ? "radio" : "checkbox";
        input = `<div class="choice-list" role="${type === "radio" ? "radiogroup" : "group"}" data-qid="${q.id}">
          ${(q.options || []).map((opt, j) => `
            <label class="choice"><input type="${type}" name="${id}" value="${escapeHtml(opt)}" id="${id}-${j}"><span>${escapeHtml(opt)}</span></label>
          `).join("")}
        </div>`;
      }
      return `<div class="field q-field" data-q-index="${i}">
        <label ${q.type.endsWith("text") ? `for="${id}"` : ""}>${i + 1}. ${escapeHtml(q.label)} ${req}</label>
        ${help}
        ${input}
        <span class="field-error" aria-live="polite"></span>
      </div>`;
    }).join("")}
  `;
}

// Returns { answers, valid } and marks missing required answers.
function collectQuestionnaireAnswers(container, questions) {
  let valid = true;
  const answers = questions.map((q, i) => {
    const field = container.querySelector(`[data-q-index="${i}"]`);
    const errorEl = field.querySelector(".field-error");
    errorEl.textContent = "";
    let value;
    if (q.type === "short_text" || q.type === "long_text") {
      value = field.querySelector("[data-qid]").value.trim();
      if (q.required && !value) { errorEl.textContent = "This question is required."; valid = false; }
    } else if (q.type === "single_choice") {
      const checked = field.querySelector("input:checked");
      value = checked ? checked.value : "";
      if (q.required && !value) { errorEl.textContent = "Please choose an option."; valid = false; }
    } else {
      value = [...field.querySelectorAll("input:checked")].map(c => c.value);
      if (q.required && value.length === 0) { errorEl.textContent = "Please choose at least one option."; valid = false; }
    }
    return { question_id: q.id, value };
  });
  return { answers, valid };
}

// ---------- apply modal ----------

let applyingClub = null;
let applyingQuestions = [];

async function openApplyModal(club) {
  applyingClub = club;
  $("apply-error").textContent = "";
  $("apply-modal-title").textContent = `Apply to ${club.name}`;
  const body = $("apply-form-body");
  body.innerHTML = loadingHtml("Loading the application form…");
  $("apply-submit-btn").disabled = true;
  openModal("apply-modal-overlay");

  const { data: form, error } = await supabaseClient
    .from("questionnaires")
    .select("*, questions:questionnaire_questions(*)")
    .eq("club_id", club.id)
    .eq("status", "approved")
    .maybeSingle();
  if (error || !form) {
    body.innerHTML = errorStateHtml("This club's application form isn't available right now.");
    return;
  }
  applyingQuestions = (form.questions || []).sort((a, b) => a.position - b.position);
  renderQuestionnaireForm(body, form, applyingQuestions, "apply");
  $("apply-submit-btn").disabled = false;
}

$("apply-modal-close-btn").addEventListener("click", () => closeModalById("apply-modal-overlay"));
$("apply-modal-cancel-btn").addEventListener("click", () => closeModalById("apply-modal-overlay"));

$("form-apply").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("apply-error").textContent = "";
  const { answers, valid } = collectQuestionnaireAnswers($("apply-form-body"), applyingQuestions);
  if (!valid) {
    $("apply-error").textContent = "Please answer all required questions.";
    return;
  }
  await withBusy($("apply-submit-btn"), "Sending…", async () => {
    const { error } = await supabaseClient.rpc("submit_application", { p_club: applyingClub.id, p_answers: answers });
    if (error) {
      $("apply-error").textContent = friendlyError(error);
      return;
    }
    closeModalById("apply-modal-overlay");
    showToast("Application sent! You'll get a notification when the leaders decide.", "success");
    refreshUnreadCount();
    showClubDetail(applyingClub.id, currentDetailTab());
  });
});

// ============================================================
// NOTIFICATIONS
// ============================================================

let notificationTimer = null;

function startNotificationPolling() {
  stopNotificationPolling();
  refreshUnreadCount();
  notificationTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshUnreadCount();
  }, 60000);
}

function stopNotificationPolling() {
  clearInterval(notificationTimer);
  notificationTimer = null;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentUser) refreshUnreadCount();
});

async function refreshUnreadCount() {
  if (!currentUser) return;
  const { count, error } = await supabaseClient
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", currentUser.id)
    .is("read_at", null);
  if (error) return;
  document.querySelectorAll("[data-unread-badge]").forEach(b => {
    b.hidden = !count;
    b.textContent = count > 99 ? "99+" : String(count || "");
  });
  if (typeof refreshLeaderBadge === "function") refreshLeaderBadge();
}

async function renderNotifications() {
  const list = $("notifications-list");
  list.innerHTML = loadingHtml("Loading notifications…");
  $("notifications-empty").hidden = true;
  const { data, error } = await supabaseClient
    .from("notifications")
    .select("*")
    .eq("user_id", currentUser.id)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    list.innerHTML = errorStateHtml("Couldn't load notifications.");
    return;
  }
  list.innerHTML = "";
  $("notifications-empty").hidden = data.length !== 0;
  $("mark-all-read-btn").hidden = !data.some(n => !n.read_at);

  data.forEach(n => {
    const item = document.createElement("button");
    item.className = "notification-item" + (n.read_at ? "" : " is-unread");
    item.innerHTML = `
      <span class="notification-dot" aria-hidden="true"></span>
      <span class="notification-main">
        <strong>${escapeHtml(n.title)}</strong>
        <span>${escapeHtml(n.body)}</span>
      </span>
      <time datetime="${n.created_at}" title="${escapeHtml(formatDateTime(n.created_at))}">${timeAgo(n.created_at)}</time>`;
    item.addEventListener("click", async () => {
      if (!n.read_at) {
        await supabaseClient.rpc("mark_notifications_read", { p_ids: [n.id] });
        refreshUnreadCount();
      }
      if (n.link && n.link.startsWith("#/")) navigate(n.link);
      else if (n.link && n.link.startsWith("/")) window.location.href = n.link;
      else renderNotifications();
    });
    list.appendChild(item);
  });
}

$("mark-all-read-btn").addEventListener("click", async (e) => {
  await withBusy(e.currentTarget, "…", async () => {
    const { error } = await supabaseClient.rpc("mark_notifications_read", { p_ids: null });
    if (error) return showToast(friendlyError(error), "error");
    refreshUnreadCount();
    renderNotifications();
  });
});

// ============================================================
// BOOT
// ============================================================

(async function boot() {
  if (authLinkError) {
    showAuthView();
    showAuthPanel("forgot");
    $("forgot-error").textContent = /expired|invalid/i.test(authLinkError)
      ? "That link is invalid or has expired. Request a new one below."
      : authLinkError;
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  const { data: { session } } = await supabaseClient.auth.getSession();

  if (recoveryMode && session) {
    showAuthView();
    showAuthPanel("reset");
    return;
  }

  if (!session) {
    showAuthView();
    return;
  }

  await afterAuthSuccess();
})();
