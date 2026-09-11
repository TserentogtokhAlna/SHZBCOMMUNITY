const SCHOOL_EMAIL_DOMAIN = "@shinezuunbileg.edu.mn";
// TEMPORARY: domain restriction disabled for testing. Set back to true before
// real launch (and re-enable the matching check in the database trigger —
// see supabase/migration_003_teacher_type_and_domain_toggle.sql).
const ENFORCE_SCHOOL_EMAIL_DOMAIN = false;

let currentUser = null;
let selectedAccountType = "student";

// ---------- elements ----------

const viewAuth = document.getElementById("view-auth");
const viewApp = document.getElementById("view-app");

const authTabsEl = document.getElementById("auth-tabs");
const authTabs = document.querySelectorAll(".auth-tab");
const formRegister = document.getElementById("form-register");
const formLogin = document.getElementById("form-login");
const registerError = document.getElementById("register-error");
const loginError = document.getElementById("login-error");

const panelVerify = document.getElementById("panel-verify");
const formVerify = document.getElementById("form-verify");
const verifyError = document.getElementById("verify-error");
const verifyEmailDisplay = document.getElementById("verify-email-display");
const verifyCodeInput = document.getElementById("verify-code");
const resendCodeBtn = document.getElementById("resend-code-btn");
const verifyBackBtn = document.getElementById("verify-back-btn");

const profileBtn = document.getElementById("profile-btn");
const sidebarProfileBtn = document.getElementById("sidebar-profile-btn");
const profileMenuName = document.getElementById("profile-menu-name");
const profileMenuEmail = document.getElementById("profile-menu-email");
const logoutBtn = document.getElementById("logout-btn");
const brandHomeBtn = document.getElementById("brand-home-btn");

const hamburgerBtn = document.getElementById("hamburger-btn");
const appSidebar = document.getElementById("app-sidebar");
const sidebarOverlay = document.getElementById("sidebar-overlay");
const sidebarNavItems = document.querySelectorAll(".sidebar-nav-item");
const navHomeBtn = document.getElementById("nav-home-btn");
const navMyClubsBtn = document.getElementById("nav-my-clubs-btn");
const navAnnouncementsBtn = document.getElementById("nav-announcements-btn");
const navStudentsBtn = document.getElementById("nav-students-btn");

const clubGrid = document.getElementById("club-grid");
const clubEmpty = document.getElementById("club-empty");

const myClubsGrid = document.getElementById("my-clubs-grid");
const myClubsEmpty = document.getElementById("my-clubs-empty");

const announcementsPageUpcoming = document.getElementById("announcements-page-upcoming");
const announcementsPageUpcomingEmpty = document.getElementById("announcements-page-upcoming-empty");
const announcementsPagePast = document.getElementById("announcements-page-past");
const announcementsPagePastEmpty = document.getElementById("announcements-page-past-empty");

const viewClubList = document.getElementById("view-club-list");
const viewMyClubs = document.getElementById("view-my-clubs");
const viewAnnouncements = document.getElementById("view-announcements");
const viewStudents = document.getElementById("view-students");
const studentsSearchInput = document.getElementById("students-search");
const studentsGrid = document.getElementById("students-grid");
const studentsEmpty = document.getElementById("students-empty");

const viewStudentProfile = document.getElementById("view-student-profile");
const studentProfileBackBtn = document.getElementById("student-profile-back-btn");
const studentProfileAvatar = document.getElementById("student-profile-avatar");
const studentProfileName = document.getElementById("student-profile-name");
const studentProfileMeta = document.getElementById("student-profile-meta");
const studentProfileEditBtn = document.getElementById("student-profile-edit-btn");
const studentProfileBio = document.getElementById("student-profile-bio");
const studentProfileHistory = document.getElementById("student-profile-history");
const studentProfileHistoryEmpty = document.getElementById("student-profile-history-empty");

const viewClubDetail = document.getElementById("view-club-detail");
const detailBackBtn = document.getElementById("detail-back-btn");
const detailBanner = document.getElementById("detail-banner");
const detailLogo = document.getElementById("detail-logo");
const detailCategory = document.getElementById("detail-category");
const detailName = document.getElementById("detail-name");
const detailMeta = document.getElementById("detail-meta");
const detailActions = document.getElementById("detail-actions");
const detailTabs = document.querySelectorAll(".detail-tab");
const detailPanelOverview = document.getElementById("detail-panel-overview");
const detailPanelMembers = document.getElementById("detail-panel-members");
const detailPanelEvents = document.getElementById("detail-panel-events");
const detailPanelManage = document.getElementById("detail-panel-manage");
const manageTabBtn = document.getElementById("manage-tab-btn");
const detailDescription = document.getElementById("detail-description");
const detailFounded = document.getElementById("detail-founded");
const detailMembersList = document.getElementById("detail-members-list");
const detailMembersEmpty = document.getElementById("detail-members-empty");
const detailEventsList = document.getElementById("detail-events-list");
const detailEventsEmpty = document.getElementById("detail-events-empty");

const manageEditClubBtn = document.getElementById("manage-edit-club-btn");
const manageRequestsList = document.getElementById("manage-requests-list");
const manageRequestsEmpty = document.getElementById("manage-requests-empty");
const manageAddEventBtn = document.getElementById("manage-add-event-btn");
const manageEventsList = document.getElementById("manage-events-list");

const announcementsSection = document.getElementById("announcements-section");
const announcementsList = document.getElementById("announcements-list");

const eventModalOverlay = document.getElementById("event-modal-overlay");
const eventModalTitle = document.getElementById("event-modal-title");
const eventModalCloseBtn = document.getElementById("event-modal-close-btn");
const eventModalCancelBtn = document.getElementById("event-modal-cancel-btn");
const eventModalSubmitBtn = document.getElementById("event-modal-submit-btn");
const formEvent = document.getElementById("form-event");
const eventError = document.getElementById("event-error");

const toast = document.getElementById("toast");
const fabCreateClub = document.getElementById("fab-create-club");
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalSubmitBtn = document.getElementById("modal-submit-btn");
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

// ---------- email verification panel ----------

let pendingVerifyEmail = null;
let resendCooldownTimer = null;

function showVerifyPanel(email) {
  pendingVerifyEmail = email;
  verifyEmailDisplay.textContent = email;
  verifyError.textContent = "";
  verifyCodeInput.value = "";

  authTabsEl.hidden = true;
  formRegister.classList.remove("active");
  formLogin.classList.remove("active");
  panelVerify.classList.add("active");
}

function hideVerifyPanel(targetTab) {
  panelVerify.classList.remove("active");
  authTabsEl.hidden = false;
  authTabs.forEach(t => t.classList.toggle("active", t.dataset.tab === targetTab));
  formRegister.classList.toggle("active", targetTab === "register");
  formLogin.classList.toggle("active", targetTab === "login");
}

verifyBackBtn.addEventListener("click", () => hideVerifyPanel("login"));

formVerify.addEventListener("submit", async (e) => {
  e.preventDefault();
  verifyError.textContent = "";

  const code = verifyCodeInput.value.trim();

  const { error } = await supabaseClient.auth.verifyOtp({
    email: pendingVerifyEmail,
    token: code,
    type: "signup",
  });
  if (error) {
    verifyError.textContent = error.message;
    return;
  }
  await afterAuthSuccess();
});

resendCodeBtn.addEventListener("click", async () => {
  resendCodeBtn.disabled = true;
  verifyError.textContent = "";

  const { error } = await supabaseClient.auth.resend({
    type: "signup",
    email: pendingVerifyEmail,
  });

  if (error) {
    verifyError.textContent = error.message;
    resendCodeBtn.disabled = false;
    return;
  }

  let secondsLeft = 60;
  resendCodeBtn.textContent = `Resend code (${secondsLeft}s)`;
  clearInterval(resendCooldownTimer);
  resendCooldownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      clearInterval(resendCooldownTimer);
      resendCodeBtn.disabled = false;
      resendCodeBtn.textContent = "Resend code";
    } else {
      resendCodeBtn.textContent = `Resend code (${secondsLeft}s)`;
    }
  }, 1000);
});

// ---------- grade / class helpers ----------
// The school year rolls over Sept 1. Rather than storing a grade that would
// need manually bumping every year, we store the calendar year a student is
// expected to finish grade 12 (graduation_year) and compute their current
// grade from today's date whenever it's needed.

function getSchoolYear(date) {
  const d = date || new Date();
  return d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1;
}

function computeGraduationYear(selectedGrade, atDate) {
  const sy = getSchoolYear(atDate);
  return sy + (12 - selectedGrade) + 1;
}

function computeCurrentGrade(graduationYear, atDate) {
  const sy = getSchoolYear(atDate);
  return 12 - (graduationYear - sy - 1);
}

function formatGradeLabel(graduationYear, classSection) {
  if (!graduationYear) return "";
  const grade = computeCurrentGrade(graduationYear);
  const gradeText = grade > 12 ? "Graduated" : `Grade ${grade}`;
  return classSection ? `${gradeText}${grade <= 12 ? classSection : ""}` : gradeText;
}

// ---------- account type toggle ----------

const regGradeRow = document.getElementById("reg-grade-row");
const regGradeSelect = document.getElementById("reg-grade");
const regClassSelect = document.getElementById("reg-class");

const accountTypeButtons = document.querySelectorAll(".account-type-btn");
accountTypeButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    accountTypeButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedAccountType = btn.dataset.accountType;
    regGradeRow.hidden = selectedAccountType !== "student";
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

  if (ENFORCE_SCHOOL_EMAIL_DOMAIN && !email.endsWith(SCHOOL_EMAIL_DOMAIN)) {
    registerError.textContent = `Email must end with ${SCHOOL_EMAIL_DOMAIN}`;
    return;
  }
  if (password !== passwordConfirm) {
    registerError.textContent = "Passwords do not match.";
    return;
  }

  const isStudent = selectedAccountType === "student";
  const graduationYear = isStudent ? computeGraduationYear(Number(regGradeSelect.value)) : null;
  const classSection = isStudent ? regClassSelect.value : null;

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
    registerError.textContent = error.message;
    return;
  }
  showVerifyPanel(email);
});

// ---------- login ----------

formLogin.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";

  const email = document.getElementById("login-email").value.trim().toLowerCase();
  const password = document.getElementById("login-password").value;

  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.message.toLowerCase().includes("confirm")) {
      showVerifyPanel(email);
    } else {
      loginError.textContent = error.message;
    }
    return;
  }
  await afterAuthSuccess();
});

// ---------- app entry / profile ----------

async function afterAuthSuccess() {
  const {
    data: { user },
  } = await supabaseClient.auth.getUser();
  if (!user) return;

  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  if (error || !profile) {
    loginError.textContent = "Could not load your profile. Try logging in again.";
    return;
  }

  currentUser = {
    id: profile.id,
    firstName: profile.first_name,
    lastName: profile.last_name,
    email: profile.email,
    role: profile.role,
    accountType: profile.account_type,
    graduationYear: profile.graduation_year,
    classSection: profile.class_section,
    bio: profile.bio,
  };

  if (currentUser.role === "admin") {
    window.location.href = "/admin.html";
    return;
  }
  enterApp();
}

function enterApp() {
  if (!currentUser) return;

  viewAuth.style.display = "none";
  viewApp.style.display = "block";
  hideVerifyPanel("register");

  const initials = (currentUser.firstName[0] || "") + (currentUser.lastName[0] || "");
  profileBtn.textContent = initials.toUpperCase();
  profileMenuName.textContent = `${currentUser.firstName} ${currentUser.lastName}`;
  profileMenuEmail.textContent = currentUser.email;

  showView("home");
}

logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentUser = null;
  viewApp.style.display = "none";
  viewAuth.style.display = "flex";
  formLogin.reset();
  formRegister.reset();
  hideVerifyPanel("register");
});

// ---------- sidebar navigation ----------

const viewPanelsMap = {
  home: viewClubList,
  "my-clubs": viewMyClubs,
  announcements: viewAnnouncements,
  students: viewStudents,
};

let lastListView = "home";

function hideAllMainViews() {
  Object.values(viewPanelsMap).forEach(v => v.classList.remove("active"));
  viewClubDetail.classList.remove("active");
  viewStudentProfile.classList.remove("active");
}

function showView(name) {
  hideAllMainViews();
  viewPanelsMap[name].classList.add("active");
  sidebarNavItems.forEach(item => item.classList.toggle("active", item.dataset.nav === name));
  closeSidebar();

  if (name === "home") {
    lastListView = "home";
    renderClubs();
    loadAnnouncements();
  } else if (name === "my-clubs") {
    lastListView = "my-clubs";
    renderMyClubs();
  } else if (name === "announcements") {
    loadAnnouncementsPage();
  } else if (name === "students") {
    lastListView = "students";
    studentsSearchInput.value = "";
    renderStudents();
  }
}

navHomeBtn.addEventListener("click", () => showView("home"));
navMyClubsBtn.addEventListener("click", () => showView("my-clubs"));
navAnnouncementsBtn.addEventListener("click", () => showView("announcements"));
navStudentsBtn.addEventListener("click", () => showView("students"));
brandHomeBtn.addEventListener("click", () => showView("home"));

// ---------- students directory ----------

let allStudentsCache = [];

async function renderStudents() {
  const { data: students, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("account_type", "student")
    .order("first_name", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  allStudentsCache = students;
  applyStudentSearch();
}

function applyStudentSearch() {
  const term = studentsSearchInput.value.trim().toLowerCase();
  const filtered = term
    ? allStudentsCache.filter(s => `${s.first_name} ${s.last_name}`.toLowerCase().includes(term))
    : allStudentsCache;

  studentsGrid.innerHTML = "";
  studentsEmpty.hidden = filtered.length !== 0;

  filtered.forEach(s => {
    const initials = (s.first_name[0] || "") + (s.last_name[0] || "");
    const card = document.createElement("button");
    card.className = "club-card";
    card.innerHTML = `
      <span class="member-row-avatar" style="margin-bottom:10px;">${escapeHtml(initials.toUpperCase())}</span>
      <h3>${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}</h3>
      <p>${escapeHtml(formatGradeLabel(s.graduation_year, s.class_section) || "")}</p>
    `;
    card.addEventListener("click", () => showStudentProfile(s));
    studentsGrid.appendChild(card);
  });
}

studentsSearchInput.addEventListener("input", applyStudentSearch);

async function viewStudentProfileById(userId) {
  const { data: profile, error } = await supabaseClient
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error || !profile) {
    showToast("Could not load that profile.");
    return;
  }
  showStudentProfile(profile);
}

async function showStudentProfile(profile) {
  hideAllMainViews();
  viewStudentProfile.classList.add("active");

  const initials = (profile.first_name[0] || "") + (profile.last_name[0] || "");
  studentProfileAvatar.textContent = initials.toUpperCase();
  studentProfileName.textContent = `${profile.first_name} ${profile.last_name}`;
  studentProfileMeta.textContent = formatGradeLabel(profile.graduation_year, profile.class_section) || "";
  studentProfileBio.textContent = profile.bio || "No bio yet.";
  studentProfileEditBtn.hidden = profile.id !== currentUser.id;
  studentProfileEditBtn.onclick = () => openEditProfileModal(profile);

  studentProfileHistory.innerHTML = "";
  const { data: history, error } = await supabaseClient
    .from("club_members")
    .select("*, club:clubs(name)")
    .eq("user_id", profile.id)
    .in("status", ["approved", "left"])
    .order("applied_at", { ascending: false });

  if (error || !history || history.length === 0) {
    studentProfileHistoryEmpty.hidden = false;
    return;
  }
  studentProfileHistoryEmpty.hidden = true;

  history.forEach(h => {
    const row = document.createElement("div");
    row.className = "member-row";
    const joined = formatDateOnly(h.applied_at);
    const statusText = h.status === "left" && h.left_at
      ? `Joined ${joined} · Left ${formatDateOnly(h.left_at)}`
      : `Joined ${joined} · Current member`;
    row.innerHTML = `
      <div class="member-row-name">${escapeHtml(h.club ? h.club.name : "Deleted club")}</div>
      <span class="club-card-footer">${statusText}</span>
    `;
    studentProfileHistory.appendChild(row);
  });
}

studentProfileBackBtn.addEventListener("click", () => showView(lastListView === "students" ? "students" : "home"));

// ---------- edit profile modal ----------

const editProfileModalOverlay = document.getElementById("edit-profile-modal-overlay");
const editProfileModalCloseBtn = document.getElementById("edit-profile-modal-close-btn");
const editProfileModalCancelBtn = document.getElementById("edit-profile-modal-cancel-btn");
const formEditProfile = document.getElementById("form-edit-profile");
const editProfileError = document.getElementById("edit-profile-error");
const editProfileBioInput = document.getElementById("edit-profile-bio");

function openEditProfileModal(profile) {
  editProfileError.textContent = "";
  editProfileBioInput.value = profile.bio || "";
  editProfileModalOverlay.classList.add("open");
}

function closeEditProfileModal() {
  editProfileModalOverlay.classList.remove("open");
}

editProfileModalCloseBtn.addEventListener("click", closeEditProfileModal);
editProfileModalCancelBtn.addEventListener("click", closeEditProfileModal);
editProfileModalOverlay.addEventListener("click", (e) => {
  if (e.target === editProfileModalOverlay) closeEditProfileModal();
});

formEditProfile.addEventListener("submit", async (e) => {
  e.preventDefault();
  editProfileError.textContent = "";

  const bio = editProfileBioInput.value.trim();
  const { error } = await supabaseClient
    .from("profiles")
    .update({ bio })
    .eq("id", currentUser.id);

  if (error) {
    editProfileError.textContent = error.message;
    return;
  }

  currentUser.bio = bio;
  closeEditProfileModal();
  showToast("Profile updated.");
  await viewStudentProfileById(currentUser.id);
});

sidebarProfileBtn.addEventListener("click", () => viewStudentProfileById(currentUser.id));

function openSidebar() {
  appSidebar.classList.add("open");
  sidebarOverlay.classList.add("open");
}

function closeSidebar() {
  appSidebar.classList.remove("open");
  sidebarOverlay.classList.remove("open");
}

hamburgerBtn.addEventListener("click", openSidebar);
sidebarOverlay.addEventListener("click", closeSidebar);

// ---------- club list / detail navigation ----------

async function renderMyClubs() {
  const { data: rows, error } = await supabaseClient
    .from("club_members")
    .select("*, club:clubs(*, creator:profiles(first_name, last_name))")
    .eq("user_id", currentUser.id)
    .eq("status", "approved")
    .order("applied_at", { ascending: false });

  myClubsGrid.innerHTML = "";

  if (error || !rows || rows.length === 0) {
    myClubsEmpty.hidden = false;
    return;
  }
  myClubsEmpty.hidden = true;

  rows.forEach(row => {
    const club = row.club;
    const createdByName = `${club.creator.first_name} ${club.creator.last_name}`;
    const isOwner = club.created_by === currentUser.id;
    const card = document.createElement("button");
    card.className = "club-card";
    card.innerHTML = `
      <span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span>
      <h3>${escapeHtml(club.name)}${isOwner ? '<span class="club-card-ownertag">Owner</span>' : '<span class="club-card-ownertag" style="color:var(--success);background:var(--success-bg);">Member</span>'}</h3>
      <p>${escapeHtml(club.description)}</p>
      <div class="club-card-footer">${club.status === "pending" ? "Awaiting admin approval" : "by " + escapeHtml(createdByName)}</div>
    `;
    card.addEventListener("click", () => showClubDetail({ ...club, createdByName }));
    myClubsGrid.appendChild(card);
  });
}

let currentClubDetail = null;
let currentClubIsOwner = false;

async function showClubDetail(club) {
  currentClubDetail = club;
  Object.values(viewPanelsMap).forEach(v => v.classList.remove("active"));
  viewClubDetail.classList.add("active");

  detailTabs.forEach(t => t.classList.toggle("active", t.dataset.detailTab === "overview"));
  detailPanelOverview.classList.add("active");
  detailPanelMembers.classList.remove("active");
  detailPanelEvents.classList.remove("active");
  detailPanelManage.classList.remove("active");

  detailBanner.dataset.category = club.category;
  detailLogo.textContent = club.name.slice(0, 2).toUpperCase();
  detailCategory.textContent = club.category;
  detailCategory.dataset.category = club.category;
  detailName.textContent = club.name;
  detailMeta.textContent = `Created by ${club.createdByName}`;
  detailDescription.textContent = club.description;
  detailFounded.textContent = formatDateOnly(club.created_at);

  detailActions.innerHTML = "";
  detailMembersList.innerHTML = "";
  detailEventsList.innerHTML = "";
  manageRequestsList.innerHTML = "";
  manageEventsList.innerHTML = "";
  manageTabBtn.hidden = true;

  await loadClubMembership(club);
  await loadClubEvents(club);
}

detailBackBtn.addEventListener("click", () => showView(lastListView));

detailTabs.forEach(tab => {
  tab.addEventListener("click", () => {
    detailTabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const target = tab.dataset.detailTab;
    detailPanelOverview.classList.toggle("active", target === "overview");
    detailPanelMembers.classList.toggle("active", target === "members");
    detailPanelEvents.classList.toggle("active", target === "events");
    detailPanelManage.classList.toggle("active", target === "manage");
  });
});

// ---------- club membership ----------

async function loadClubMembership(club) {
  const isOwner = currentUser.id === club.created_by;
  currentClubIsOwner = isOwner;
  manageTabBtn.hidden = !isOwner;

  const { data: memberRows, error } = await supabaseClient
    .from("club_members")
    .select("*, profile:profiles(first_name, last_name)")
    .eq("club_id", club.id);

  if (error) {
    console.error(error);
    return;
  }

  const approved = memberRows.filter(m => m.status === "approved");
  const myRow = memberRows.find(m => m.user_id === currentUser.id);

  detailMeta.textContent = `Created by ${club.createdByName} · ${approved.length} member${approved.length === 1 ? "" : "s"}`;

  renderDetailActions(club, isOwner, myRow);
  renderMembersList(approved, club.created_by);
  detailMembersEmpty.hidden = approved.length !== 0;

  if (isOwner) {
    const pending = memberRows.filter(m => m.status === "pending");
    renderRequestsList(pending, club);
  }
}

function renderDetailActions(club, isOwner, myRow) {
  detailActions.innerHTML = "";

  if (isOwner) {
    const pill = document.createElement("span");
    pill.className = "pill pill-member";
    pill.textContent = "Your Club";
    detailActions.appendChild(pill);
    return;
  }

  if (!myRow || myRow.status === "left") {
    const applyBtn = document.createElement("button");
    applyBtn.className = "btn btn-primary btn-sm";
    applyBtn.textContent = "Apply to Join";
    applyBtn.addEventListener("click", () => applyToClub(club));
    detailActions.appendChild(applyBtn);
    return;
  }

  if (myRow.status === "pending") {
    const pill = document.createElement("span");
    pill.className = "pill pill-pending";
    pill.textContent = "Application Pending";
    detailActions.appendChild(pill);

    const withdrawBtn = document.createElement("button");
    withdrawBtn.className = "btn btn-secondary btn-sm";
    withdrawBtn.textContent = "Withdraw";
    withdrawBtn.addEventListener("click", () => withdrawApplication(myRow.id, club));
    detailActions.appendChild(withdrawBtn);
    return;
  }

  const pill = document.createElement("span");
  pill.className = "pill pill-member";
  pill.textContent = "Member";
  detailActions.appendChild(pill);

  const leaveBtn = document.createElement("button");
  leaveBtn.className = "btn btn-secondary btn-sm";
  leaveBtn.textContent = "Leave";
  leaveBtn.addEventListener("click", () => leaveClub(myRow.id, club));
  detailActions.appendChild(leaveBtn);
}

function renderMembersList(approved, ownerId) {
  detailMembersList.innerHTML = "";
  approved
    .slice()
    .sort((a, b) => (a.user_id === ownerId ? -1 : b.user_id === ownerId ? 1 : 0))
    .forEach(m => {
      const name = `${m.profile.first_name} ${m.profile.last_name}`;
      const initials = (m.profile.first_name[0] || "") + (m.profile.last_name[0] || "");
      const row = document.createElement("button");
      row.className = "member-row";
      row.style.width = "100%";
      row.style.cursor = "pointer";
      row.innerHTML = `
        <div class="member-row-name">
          <span class="member-row-avatar">${escapeHtml(initials.toUpperCase())}</span>
          ${escapeHtml(name)}
        </div>
        ${m.user_id === ownerId ? '<span class="member-owner-tag">Owner</span>' : ""}
      `;
      row.addEventListener("click", () => viewStudentProfileById(m.user_id));
      detailMembersList.appendChild(row);
    });
}

function renderRequestsList(pending, club) {
  manageRequestsList.innerHTML = "";
  manageRequestsEmpty.hidden = pending.length !== 0;

  pending.forEach(m => {
    const name = `${m.profile.first_name} ${m.profile.last_name}`;
    const row = document.createElement("div");
    row.className = "member-row" + (m.message ? " has-message" : "");
    row.innerHTML = `
      <div class="member-row-top">
        <div class="member-row-name">${escapeHtml(name)}</div>
        <div class="member-row-actions">
          <button class="btn-approve" data-approve-member-id="${m.id}">Approve</button>
          <button class="btn-danger" data-reject-member-id="${m.id}">Reject</button>
        </div>
      </div>
      ${m.message ? `<p class="member-row-message">"${escapeHtml(m.message)}"</p>` : ""}
    `;
    manageRequestsList.appendChild(row);
  });

  manageRequestsList.querySelectorAll("[data-approve-member-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await supabaseClient
        .from("club_members")
        .update({ status: "approved", decided_at: new Date().toISOString() })
        .eq("id", btn.dataset.approveMemberId);
      if (error) { showToast(error.message); btn.disabled = false; return; }
      await loadClubMembership(club);
    });
  });

  manageRequestsList.querySelectorAll("[data-reject-member-id]").forEach(btn => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      const { error } = await supabaseClient.from("club_members").delete().eq("id", btn.dataset.rejectMemberId);
      if (error) { showToast(error.message); btn.disabled = false; return; }
      await loadClubMembership(club);
    });
  });
}

manageEditClubBtn.addEventListener("click", () => openEditClubModal(currentClubDetail));

// ---------- apply to club (with optional message) ----------

const applyModalOverlay = document.getElementById("apply-modal-overlay");
const applyModalCloseBtn = document.getElementById("apply-modal-close-btn");
const applyModalCancelBtn = document.getElementById("apply-modal-cancel-btn");
const formApply = document.getElementById("form-apply");
const applyError = document.getElementById("apply-error");
const applyMessageInput = document.getElementById("apply-message");

let applyingToClub = null;

function applyToClub(club) {
  applyingToClub = club;
  applyError.textContent = "";
  formApply.reset();
  applyModalOverlay.classList.add("open");
}

function closeApplyModal() {
  applyModalOverlay.classList.remove("open");
  applyingToClub = null;
}

applyModalCloseBtn.addEventListener("click", closeApplyModal);
applyModalCancelBtn.addEventListener("click", closeApplyModal);
applyModalOverlay.addEventListener("click", (e) => {
  if (e.target === applyModalOverlay) closeApplyModal();
});

formApply.addEventListener("submit", async (e) => {
  e.preventDefault();
  applyError.textContent = "";

  const club = applyingToClub;
  const message = applyMessageInput.value.trim();

  const { error } = await supabaseClient.from("club_members").upsert(
    {
      club_id: club.id,
      user_id: currentUser.id,
      status: "pending",
      message,
      left_at: null,
      decided_at: null,
    },
    { onConflict: "club_id,user_id" }
  );
  if (error) {
    applyError.textContent = error.message;
    return;
  }
  closeApplyModal();
  showToast("Application sent! The club owner will review it.");
  await loadClubMembership(club);
});

async function withdrawApplication(rowId, club) {
  const { error } = await supabaseClient.from("club_members").delete().eq("id", rowId);
  if (error) { showToast(error.message); return; }
  await loadClubMembership(club);
}

async function leaveClub(rowId, club) {
  if (!confirm(`Leave ${club.name}?`)) return;
  const { error } = await supabaseClient
    .from("club_members")
    .update({ status: "left", left_at: new Date().toISOString() })
    .eq("id", rowId);
  if (error) { showToast(error.message); return; }
  showToast(`You left ${club.name}.`);
  await loadClubMembership(club);
}

// ---------- club events ----------

function formatEventDate(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatDateOnly(iso) {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "long", day: "numeric",
  });
}

async function loadClubEvents(club) {
  const { data: events, error } = await supabaseClient
    .from("club_events")
    .select("*")
    .eq("club_id", club.id)
    .order("event_date", { ascending: true });

  if (error) {
    console.error(error);
    return;
  }

  detailEventsList.innerHTML = "";
  detailEventsEmpty.hidden = events.length !== 0;
  events.forEach(ev => {
    const card = document.createElement("div");
    card.className = "event-card";
    card.innerHTML = `
      <div class="event-card-info">
        <h4>${escapeHtml(ev.title)}</h4>
        <p class="event-card-date">${formatEventDate(ev.event_date)}</p>
        <p class="event-card-description">${escapeHtml(ev.description || "")}</p>
      </div>
    `;
    detailEventsList.appendChild(card);
  });

  if (currentClubIsOwner) {
    manageEventsList.innerHTML = "";
    events.forEach(ev => {
      const card = document.createElement("div");
      card.className = "event-card";
      card.innerHTML = `
        <div class="event-card-info">
          <h4>${escapeHtml(ev.title)}</h4>
          <p class="event-card-date">${formatEventDate(ev.event_date)}</p>
          <p class="event-card-description">${escapeHtml(ev.description || "")}</p>
        </div>
        <div class="event-card-actions">
          <button class="btn btn-secondary btn-sm" data-edit-event-id="${ev.id}">Edit</button>
          <button class="btn-danger" data-delete-event-id="${ev.id}">Delete</button>
        </div>
      `;
      manageEventsList.appendChild(card);
    });

    manageEventsList.querySelectorAll("[data-edit-event-id]").forEach(btn => {
      btn.addEventListener("click", () => {
        const ev = events.find(e => e.id === btn.dataset.editEventId);
        openEditEventModal(club, ev);
      });
    });

    manageEventsList.querySelectorAll("[data-delete-event-id]").forEach(btn => {
      btn.addEventListener("click", async () => {
        if (!confirm("Delete this event?")) return;
        btn.disabled = true;
        const { error: delError } = await supabaseClient
          .from("club_events")
          .delete()
          .eq("id", btn.dataset.deleteEventId);
        if (delError) { showToast(delError.message); btn.disabled = false; return; }
        await loadClubEvents(club);
      });
    });
  }
}

let editingEventId = null;

function openAddEventModal() {
  editingEventId = null;
  eventModalTitle.textContent = "Add an event";
  eventModalSubmitBtn.textContent = "Add event";
  eventError.textContent = "";
  formEvent.reset();
  eventModalOverlay.classList.add("open");
}

function openEditEventModal(club, ev) {
  editingEventId = ev.id;
  eventModalTitle.textContent = "Edit event";
  eventModalSubmitBtn.textContent = "Save changes";
  eventError.textContent = "";
  document.getElementById("event-title").value = ev.title;
  document.getElementById("event-description").value = ev.description || "";
  const local = new Date(ev.event_date);
  local.setMinutes(local.getMinutes() - local.getTimezoneOffset());
  document.getElementById("event-date").value = local.toISOString().slice(0, 16);
  eventModalOverlay.classList.add("open");
}

function closeEventModal() {
  eventModalOverlay.classList.remove("open");
  editingEventId = null;
}

manageAddEventBtn.addEventListener("click", openAddEventModal);
eventModalCloseBtn.addEventListener("click", closeEventModal);
eventModalCancelBtn.addEventListener("click", closeEventModal);
eventModalOverlay.addEventListener("click", (e) => {
  if (e.target === eventModalOverlay) closeEventModal();
});

formEvent.addEventListener("submit", async (e) => {
  e.preventDefault();
  eventError.textContent = "";

  const title = document.getElementById("event-title").value.trim();
  const dateValue = document.getElementById("event-date").value;
  const description = document.getElementById("event-description").value.trim();

  if (!title || !dateValue) {
    eventError.textContent = "Please fill in the required fields.";
    return;
  }

  const eventDate = new Date(dateValue).toISOString();

  if (editingEventId) {
    const { error } = await supabaseClient
      .from("club_events")
      .update({ title, description, event_date: eventDate })
      .eq("id", editingEventId);
    if (error) { eventError.textContent = error.message; return; }
    showToast("Event updated.");
  } else {
    const { error } = await supabaseClient.from("club_events").insert({
      club_id: currentClubDetail.id,
      title,
      description,
      event_date: eventDate,
      created_by: currentUser.id,
    });
    if (error) { eventError.textContent = error.message; return; }
    showToast("Event added.");
  }

  closeEventModal();
  await loadClubEvents(currentClubDetail);
});

// ---------- announcements ----------

function renderAnnouncementCard(a, isPast) {
  const card = document.createElement("div");
  card.className = "announcement-card" + (isPast ? " is-past" : "");
  card.innerHTML = `
    <div class="announcement-card-info">
      <h4>${escapeHtml(a.title)}</h4>
      ${a.event_date ? `<p class="announcement-card-date">${formatEventDate(a.event_date)}</p>` : ""}
      <p class="announcement-card-description">${escapeHtml(a.description || "")}</p>
    </div>
  `;
  return card;
}

async function loadAnnouncements() {
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
  const upcoming = announcements.filter(a => !a.event_date || new Date(a.event_date) >= now);

  announcementsSection.hidden = upcoming.length === 0;
  announcementsList.innerHTML = "";
  upcoming.forEach(a => announcementsList.appendChild(renderAnnouncementCard(a, false)));
}

async function loadAnnouncementsPage() {
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
  const upcoming = announcements.filter(a => !a.event_date || new Date(a.event_date) >= now);
  const past = announcements
    .filter(a => a.event_date && new Date(a.event_date) < now)
    .sort((a, b) => new Date(b.event_date) - new Date(a.event_date));

  announcementsPageUpcoming.innerHTML = "";
  announcementsPageUpcomingEmpty.hidden = upcoming.length !== 0;
  upcoming.forEach(a => announcementsPageUpcoming.appendChild(renderAnnouncementCard(a, false)));

  announcementsPagePast.innerHTML = "";
  announcementsPagePastEmpty.hidden = past.length !== 0;
  past.forEach(a => announcementsPagePast.appendChild(renderAnnouncementCard(a, true)));
}

let activeCategoryFilter = "All";

const categoryFilterButtons = document.querySelectorAll(".category-filter-btn");
categoryFilterButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    categoryFilterButtons.forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeCategoryFilter = btn.dataset.categoryFilter;
    renderClubs();
  });
});

async function renderClubs() {
  let query = supabaseClient
    .from("clubs")
    .select("*, creator:profiles(first_name, last_name)")
    .eq("status", "approved")
    .order("created_at", { ascending: false });

  if (activeCategoryFilter !== "All") {
    query = query.eq("category", activeCategoryFilter);
  }

  const { data: clubs, error } = await query;

  clubGrid.innerHTML = "";

  if (error || !clubs || clubs.length === 0) {
    clubEmpty.hidden = false;
    return;
  }
  clubEmpty.hidden = true;

  clubs.forEach(club => {
    const createdByName = `${club.creator.first_name} ${club.creator.last_name}`;
    const card = document.createElement("button");
    card.className = "club-card";
    card.innerHTML = `
      <span class="club-badge" data-category="${escapeHtml(club.category)}">${escapeHtml(club.category)}</span>
      <h3>${escapeHtml(club.name)}</h3>
      <p>${escapeHtml(club.description)}</p>
      <div class="club-card-footer">by ${escapeHtml(createdByName)}</div>
    `;
    card.addEventListener("click", () => showClubDetail({ ...club, createdByName }));
    clubGrid.appendChild(card);
  });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------- create club modal ----------

let editingClubId = null;

function openCreateClubModal() {
  editingClubId = null;
  modalTitle.textContent = "Create a new club";
  modalSubmitBtn.textContent = "Create club";
  createClubError.textContent = "";
  formCreateClub.reset();
  modalOverlay.classList.add("open");
}

function openEditClubModal(club) {
  editingClubId = club.id;
  modalTitle.textContent = "Edit club";
  modalSubmitBtn.textContent = "Save changes";
  createClubError.textContent = "";
  document.getElementById("club-name").value = club.name;
  document.getElementById("club-category").value = club.category;
  document.getElementById("club-description").value = club.description;
  modalOverlay.classList.add("open");
}

function closeModal() {
  modalOverlay.classList.remove("open");
  editingClubId = null;
}

fabCreateClub.addEventListener("click", openCreateClubModal);
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

  if (!name || !description) {
    createClubError.textContent = "Please fill in the required fields.";
    return;
  }

  if (editingClubId) {
    const { error } = await supabaseClient
      .from("clubs")
      .update({ name, category, description })
      .eq("id", editingClubId);

    if (error) {
      createClubError.textContent = error.message;
      return;
    }

    const updatedClub = { ...currentClubDetail, name, category, description };
    closeModal();
    showToast("Club updated.");
    await showClubDetail(updatedClub);
    return;
  }

  const { error } = await supabaseClient.from("clubs").insert({
    name,
    category,
    description,
    created_by: currentUser.id,
    status: "pending",
  });

  if (error) {
    createClubError.textContent = error.message;
    return;
  }

  closeModal();
  showView("my-clubs");
  showToast("Club submitted! An admin will review it before it appears publicly.");
});

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

// ---------- boot ----------

(async function boot() {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();

  if (!session) {
    viewAuth.style.display = "flex";
    viewApp.style.display = "none";
    return;
  }

  await afterAuthSuccess();
})();
