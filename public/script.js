const SCHOOL_EMAIL_DOMAIN = "@shinezuunbileg.edu.mn";

let currentUser = null;

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

  const { error } = await supabaseClient.auth.signUp({
    email,
    password,
    options: { data: { first_name: firstName, last_name: lastName } },
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

  showClubList();
}

profileBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  profileMenu.classList.toggle("open");
});

document.addEventListener("click", () => {
  profileMenu.classList.remove("open");
});

logoutBtn.addEventListener("click", async () => {
  await supabaseClient.auth.signOut();
  currentUser = null;
  viewApp.style.display = "none";
  viewAuth.style.display = "flex";
  formLogin.reset();
  formRegister.reset();
  hideVerifyPanel("register");
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
  const { data: clubs, error } = await supabaseClient
    .from("clubs")
    .select("*, creator:profiles(first_name, last_name)")
    .eq("status", "approved")
    .order("created_at", { ascending: false });

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

  const {
    data: { user },
  } = await supabaseClient.auth.getUser();

  const { error } = await supabaseClient.from("clubs").insert({
    name,
    category,
    description,
    meeting,
    created_by: user.id,
    status: "pending",
  });

  if (error) {
    createClubError.textContent = error.message;
    return;
  }

  closeModal();
  showClubList();
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
