const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");

const SECRET_PATH = path.join(__dirname, ".jwt-secret");

function loadOrCreateSecret() {
  if (fs.existsSync(SECRET_PATH)) {
    return fs.readFileSync(SECRET_PATH, "utf8").trim();
  }
  const secret = crypto.randomBytes(48).toString("hex");
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}

const JWT_SECRET = loadOrCreateSecret();

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated." });
  }
  try {
    req.auth = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

function requireAdmin(req, res, next) {
  if (req.auth.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }
  next();
}

module.exports = { signToken, requireAuth, requireAdmin };
