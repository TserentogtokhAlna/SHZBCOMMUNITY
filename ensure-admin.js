const bcrypt = require("bcryptjs");
const db = require("./db");

function ensureAdmin({ email, password, firstName = "Site", lastName = "Admin" }) {
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const passwordHash = bcrypt.hashSync(password, 10);

  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?").run(
      passwordHash,
      existing.id
    );
    return { created: false, email };
  }

  db.prepare(
    "INSERT INTO users (first_name, last_name, email, password_hash, role) VALUES (?, ?, ?, ?, 'admin')"
  ).run(firstName, lastName, email, passwordHash);
  return { created: true, email };
}

module.exports = { ensureAdmin };
