const path = require("node:path");
const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("./db");
const { signToken, requireAuth, requireAdmin } = require("./auth");
const { ensureAdmin } = require("./ensure-admin");

const SCHOOL_EMAIL_DOMAIN = "@shinezuunbileg.edu.mn";
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

function publicUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    role: row.role,
    createdAt: row.created_at,
  };
}

function publicClub(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    meeting: row.meeting,
    createdBy: row.created_by,
    createdByName: row.creator_first_name + " " + row.creator_last_name,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ---------- auth routes ----------

app.post("/api/auth/register", (req, res) => {
  const { firstName, lastName, email, password } = req.body || {};

  if (!firstName || !lastName || !email || !password) {
    return res.status(400).json({ error: "All fields are required." });
  }
  const normalizedEmail = String(email).trim().toLowerCase();
  if (!normalizedEmail.endsWith(SCHOOL_EMAIL_DOMAIN)) {
    return res.status(400).json({ error: `Email must end with ${SCHOOL_EMAIL_DOMAIN}` });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (existing) {
    return res.status(409).json({ error: "An account with this email already exists." });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const result = db
    .prepare(
      "INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'student')"
    )
    .run(firstName.trim(), lastName.trim(), normalizedEmail, passwordHash);

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const normalizedEmail = String(email).trim().toLowerCase();
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(normalizedEmail);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.auth.sub);
  if (!user) return res.status(404).json({ error: "User not found." });
  res.json({ user: publicUser(user) });
});

// ---------- club routes ----------

const CLUB_SELECT = `
  SELECT clubs.*, users.first_name AS creator_first_name, users.last_name AS creator_last_name
  FROM clubs JOIN users ON users.id = clubs.created_by
`;

app.get("/api/clubs", requireAuth, (req, res) => {
  const rows = db
    .prepare(`${CLUB_SELECT} WHERE clubs.status = 'approved' ORDER BY clubs.created_at DESC`)
    .all();
  res.json({ clubs: rows.map(publicClub) });
});

app.get("/api/clubs/:id", requireAuth, (req, res) => {
  const row = db
    .prepare(`${CLUB_SELECT} WHERE clubs.id = ? AND clubs.status = 'approved'`)
    .get(req.params.id);
  if (!row) return res.status(404).json({ error: "Club not found." });
  res.json({ club: publicClub(row) });
});

app.post("/api/clubs", requireAuth, (req, res) => {
  const { name, category, description, meeting } = req.body || {};
  if (!name || !category || !description) {
    return res.status(400).json({ error: "Name, category, and description are required." });
  }

  const result = db
    .prepare(
      "INSERT INTO clubs (name, category, description, meeting, created_by, status) VALUES (?, ?, ?, ?, ?, 'pending')"
    )
    .run(name.trim(), category, description.trim(), (meeting || "").trim(), req.auth.sub);

  const row = db.prepare(`${CLUB_SELECT} WHERE clubs.id = ?`).get(result.lastInsertRowid);
  res.status(201).json({ club: publicClub(row) });
});

app.delete("/api/clubs/:id", requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("DELETE FROM clubs WHERE id = ?").run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Club not found." });
  res.status(204).end();
});

// ---------- admin routes ----------

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  const rows = db
    .prepare(
      `SELECT users.*, (SELECT COUNT(*) FROM clubs WHERE clubs.created_by = users.id) AS club_count
       FROM users ORDER BY users.created_at DESC`
    )
    .all();
  res.json({
    users: rows.map((row) => ({ ...publicUser(row), clubCount: row.club_count })),
  });
});

app.get("/api/admin/clubs/pending", requireAuth, requireAdmin, (req, res) => {
  const rows = db
    .prepare(`${CLUB_SELECT} WHERE clubs.status = 'pending' ORDER BY clubs.created_at ASC`)
    .all();
  res.json({ clubs: rows.map(publicClub) });
});

app.post("/api/admin/clubs/:id/approve", requireAuth, requireAdmin, (req, res) => {
  const result = db
    .prepare("UPDATE clubs SET status = 'approved' WHERE id = ? AND status = 'pending'")
    .run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: "Pending club not found." });

  const row = db.prepare(`${CLUB_SELECT} WHERE clubs.id = ?`).get(req.params.id);
  res.json({ club: publicClub(row) });
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  const target = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(400).json({ error: "Admin accounts cannot be deleted." });
  }

  db.prepare("DELETE FROM clubs WHERE created_by = ?").run(target.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(target.id);
  res.status(204).end();
});

ensureAdmin({
  email: process.env.ADMIN_EMAIL || "admin@shzb-clubs.local",
  password: process.env.ADMIN_PASSWORD || "ChangeMe123!",
});

app.listen(PORT, () => {
  console.log(`Shine Zuun Bileg Clubs server running on http://localhost:${PORT}`);
});
