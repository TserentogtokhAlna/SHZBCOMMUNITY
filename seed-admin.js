const bcrypt = require("bcryptjs");
const db = require("./db");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@shzb-clubs.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || "Site";
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || "Admin";

const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(ADMIN_EMAIL);

if (existing) {
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(
    passwordHash,
    existing.id
  );
  console.log(`Updated existing admin account: ${ADMIN_EMAIL}`);
} else {
  const passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
  db.prepare(
    "INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')"
  ).run(ADMIN_FIRST_NAME, ADMIN_LAST_NAME, ADMIN_EMAIL, passwordHash);
  console.log(`Created admin account: ${ADMIN_EMAIL}`);
}

console.log(`Login with email "${ADMIN_EMAIL}" and password "${ADMIN_PASSWORD}"`);
console.log("Set ADMIN_EMAIL / ADMIN_PASSWORD env vars before running this script to use your own credentials.");
