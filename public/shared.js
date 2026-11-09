// Helpers shared by the community site (script.js, leader.js) and the admin
// dashboard (admin.js). Loaded after supabase-config.js.

const MEDIA_BUCKET = "club-media";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// ---------- text ----------

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function fullName(p) {
  return p ? `${p.first_name || ""} ${p.last_name || ""}`.trim() : "Unknown";
}

function initials(p) {
  if (!p) return "?";
  return ((p.first_name || "")[0] || "").concat((p.last_name || "")[0] || "").toUpperCase() || "?";
}

function friendlyError(error) {
  if (!error) return "Something went wrong.";
  const msg = error.message || String(error);
  if (/Failed to fetch|NetworkError/i.test(msg)) return "Network error — check your connection and try again.";
  if (/JWT|session/i.test(msg) && /expired|invalid/i.test(msg)) return "Your session expired. Please log in again.";
  if (/row-level security|permission denied/i.test(msg)) return "You don't have permission to do that.";
  if (/duplicate key/i.test(msg)) return "That already exists.";
  return msg;
}

// ---------- icons ----------
// Inline SVG paths (24x24, stroked) so icons inherit the text colour and
// need no extra requests or icon font.

const ICON_PATHS = {
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17" cy="9" r="2.5"/><path d="M16.5 14a5 5 0 0 1 5 5"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  gradCap: '<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5"/><path d="M22 9v6"/>',
  book: '<path d="M2 5.5C4.5 4 8 4 12 6c4-2 7.5-2 10-.5V19c-2.5-1.5-6-1.5-10 .5-4-2-7.5-2-10-.5z"/><path d="M12 6v13.5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18"/><path d="M10.6 5.1A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7a9.7 9.7 0 0 0 4.4-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  atom: '<circle cx="12" cy="12" r="1.6"/><ellipse cx="12" cy="12" rx="10" ry="4"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(120 12 12)"/>',
  palette: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-2 0-.6-.3-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1.1.9-2 2-2H17a4 4 0 0 0 4-4c0-4.3-4-7.3-9-7.3z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
  ball: '<circle cx="12" cy="12" r="9.5"/><path d="M2.5 12h19M12 2.5v19"/><path d="M5.3 5.3a9.5 9.5 0 0 1 0 13.4M18.7 5.3a9.5 9.5 0 0 0 0 13.4"/>',
  code: '<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>',
  heart: '<path d="M12 20s-7.5-4.6-9.2-9.3C1.7 7.4 3.8 4.5 7 4.5c2 0 3.3 1.1 5 3 1.7-1.9 3-3 5-3 3.2 0 5.3 2.9 4.2 6.2C19.5 15.4 12 20 12 20z"/>',
  leaf: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19c3-4 6-6.5 9.5-8.5"/>',
  bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4"/><path d="M12 13v4M8.5 20.5h7M10 17h4v3.5h-4z"/>',
  mapPin: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="9.5" r="1.8"/><path d="m21 16-5-5-9 9"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  megaphone: '<path d="M3 10v4a1 1 0 0 0 1 1h3l7 4.5v-15L7 9H4a1 1 0 0 0-1 1z"/><path d="M18 9a4 4 0 0 1 0 6"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  arrowUp: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  arrowDown: '<path d="M12 5v14M6 13l6 6 6-6"/>',
};

const CATEGORY_ICONS = {
  Academic: "atom",
  Arts: "palette",
  Sports: "ball",
  Technology: "code",
  Volunteer: "heart",
  Other: "leaf",
};

function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

function categoryIcon(category) {
  return icon(CATEGORY_ICONS[category] || "leaf");
}

// Logo image if the club has one, otherwise its category icon.
function clubLogoHtml(club) {
  if (club && club.logo_url) {
    return `<img class="club-logo-img" src="${escapeHtml(club.logo_url)}" alt="" loading="lazy">`;
  }
  return categoryIcon(club ? club.category : "Other");
}

// ---------- dates ----------
// Event dates are stored as plain dates (YYYY-MM-DD). `new Date("2026-11-20")`
// would parse that as UTC midnight, which shows the previous day in some
// time zones, so date-only strings are parsed as local dates instead.

function parseDateOnly(str) {
  if (!str) return null;
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function todayDateStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatShortDate(iso) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function formatDateOnly(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// "October 19, 2024" — used for membership periods
function formatLongDate(value) {
  const d = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? parseDateOnly(value) : new Date(value);
  return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function formatEventDay(dateStr) {
  return parseDateOnly(dateStr).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "long", year: "numeric" });
}

function formatTime(t) {
  return t ? t.slice(0, 5) : "";
}

function formatTimeRange(start, end) {
  if (!start) return "";
  return end ? `${formatTime(start)} – ${formatTime(end)}` : formatTime(start);
}

function timeAgo(iso) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return formatShortDate(iso);
}

// ---------- grade / class ----------
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

// ---------- passwords ----------

function validatePassword(pw) {
  if (pw.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return "Password must contain at least one letter and one number.";
  if (pw.length > 72) return "Password must be at most 72 characters.";
  return "";
}

// ---------- status labels ----------

const STATUS_LABELS = {
  pending: "Pending",
  approved: "Approved",
  rejected: "Rejected",
  changes_requested: "Changes requested",
  accepted: "Accepted",
  withdrawn: "Withdrawn",
  draft: "Draft",
  superseded: "Replaced",
  suspended: "Suspended",
  archived: "Archived",
  active: "Active",
};

function statusBadge(status) {
  return `<span class="status-badge is-${escapeHtml(status)}">${escapeHtml(STATUS_LABELS[status] || status)}</span>`;
}

// ---------- toast ----------

let toastTimer = null;

function showToast(message, kind = "info") {
  let el = document.getElementById("toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    el.className = "toast";
    el.hidden = true;
    document.body.appendChild(el);
  }
  clearTimeout(toastTimer);
  el.textContent = message;
  el.dataset.kind = kind;
  el.setAttribute("role", kind === "error" ? "alert" : "status");
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("show"));
  toastTimer = setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => { el.hidden = true; }, 300);
  }, 4500);
}

// ---------- dialogs ----------
// Promise-based replacements for confirm()/prompt() that match the site design.

function openDialog({ title, message, confirmText = "Confirm", danger = false, input = null }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open dialog-overlay";
    overlay.innerHTML = `
      <div class="modal dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
        <div class="modal-header">
          <h2 id="dialog-title">${escapeHtml(title)}</h2>
        </div>
        ${message ? `<p class="dialog-message">${escapeHtml(message)}</p>` : ""}
        ${input ? `
          <div class="field">
            ${input.label ? `<label for="dialog-input">${escapeHtml(input.label)}</label>` : ""}
            <textarea id="dialog-input" rows="3" maxlength="${input.maxLength || 2000}" placeholder="${escapeHtml(input.placeholder || "")}">${escapeHtml(input.value || "")}</textarea>
          </div>
          <p class="form-error" id="dialog-error"></p>` : ""}
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary" data-dialog-cancel>Cancel</button>
          <button type="button" class="btn ${danger ? "btn-danger-solid" : "btn-primary"}" data-dialog-ok>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const textarea = overlay.querySelector("#dialog-input");
    const okBtn = overlay.querySelector("[data-dialog-ok]");
    (textarea || okBtn).focus();

    function close(result) {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(result);
    }
    function onKey(e) {
      if (e.key === "Escape") close(input ? null : false);
    }
    document.addEventListener("keydown", onKey);

    overlay.querySelector("[data-dialog-cancel]").addEventListener("click", () => close(input ? null : false));
    overlay.addEventListener("click", e => { if (e.target === overlay) close(input ? null : false); });
    okBtn.addEventListener("click", () => {
      if (input) {
        const value = textarea.value.trim();
        if (input.required && !value) {
          overlay.querySelector("#dialog-error").textContent = input.requiredMessage || "This field is required.";
          return;
        }
        close(value);
      } else {
        close(true);
      }
    });
  });
}

function confirmDialog(message, { title = "Are you sure?", confirmText = "Confirm", danger = false } = {}) {
  return openDialog({ title, message, confirmText, danger });
}

function promptDialog({ title, message = "", label = "", placeholder = "", value = "", required = false, requiredMessage, confirmText = "Save", danger = false }) {
  return openDialog({ title, message, confirmText, danger, input: { label, placeholder, value, required, requiredMessage } });
}

// ---------- busy buttons / loading ----------

// Disables a button while `fn` runs so double-clicks can't submit twice.
async function withBusy(btn, busyText, fn) {
  if (!btn) return fn();
  if (btn.dataset.busy === "1") return;
  const original = btn.innerHTML;
  btn.dataset.busy = "1";
  btn.disabled = true;
  if (busyText) btn.textContent = busyText;
  try {
    return await fn();
  } finally {
    btn.dataset.busy = "";
    btn.disabled = false;
    btn.innerHTML = original;
  }
}

function loadingHtml(text = "Loading…") {
  return `<div class="loading-state" role="status"><span class="spinner" aria-hidden="true"></span>${escapeHtml(text)}</div>`;
}

function errorStateHtml(text = "Couldn't load this. Please try again.") {
  return `<div class="error-state" role="alert">${escapeHtml(text)}</div>`;
}

// ---------- uploads ----------

function validateImageFile(file) {
  if (!file) return "Choose an image.";
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) return "Images must be PNG, JPG, WEBP or GIF.";
  if (file.size > MAX_UPLOAD_BYTES) return "Images must be 5 MB or smaller.";
  return "";
}

// Uploads into the user's own folder (the storage policy requires that) and
// returns the public URL.
async function uploadImage(file, folder) {
  const problem = validateImageFile(file);
  if (problem) throw new Error(problem);

  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) throw new Error("Your session expired. Please log in again.");

  const ext = (file.name.split(".").pop() || "img").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5) || "img";
  const random = Math.random().toString(36).slice(2, 10);
  const path = `${session.user.id}/${folder}/${Date.now()}-${random}.${ext}`;

  const { error } = await supabaseClient.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: "31536000",
    contentType: file.type,
    upsert: false,
  });
  if (error) throw new Error(/bucket/i.test(error.message) ? "Image storage isn't set up yet (run migration 006)." : error.message);

  return supabaseClient.storage.from(MEDIA_BUCKET).getPublicUrl(path).data.publicUrl;
}

// Wires an <input type=file> + preview element. Returns { getUrl(), setUrl(url) }:
// getUrl() uploads the newly chosen file (if any) and resolves to the URL to save.
function setupImagePicker({ input, preview, removeBtn, folder, errorEl }) {
  let currentUrl = null;
  let pendingFile = null;

  function render(url) {
    preview.innerHTML = url ? `<img src="${escapeHtml(url)}" alt="Selected image">` : `<span class="image-picker-empty">${icon("image")}No image</span>`;
    if (removeBtn) removeBtn.hidden = !url;
  }

  input.addEventListener("change", () => {
    const file = input.files[0];
    if (!file) return;
    const problem = validateImageFile(file);
    if (problem) {
      if (errorEl) errorEl.textContent = problem;
      input.value = "";
      return;
    }
    if (errorEl) errorEl.textContent = "";
    pendingFile = file;
    render(URL.createObjectURL(file));
  });

  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      pendingFile = null;
      currentUrl = null;
      input.value = "";
      render(null);
    });
  }

  return {
    setUrl(url) {
      currentUrl = url || null;
      pendingFile = null;
      input.value = "";
      render(currentUrl);
    },
    async getUrl() {
      if (pendingFile) {
        currentUrl = await uploadImage(pendingFile, folder);
        pendingFile = null;
      }
      return currentUrl;
    },
  };
}
