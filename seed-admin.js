const { ensureAdmin } = require("./ensure-admin");

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@shzb-clubs.local";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "ChangeMe123!";
const ADMIN_FIRST_NAME = process.env.ADMIN_FIRST_NAME || "Site";
const ADMIN_LAST_NAME = process.env.ADMIN_LAST_NAME || "Admin";

const result = ensureAdmin({
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  firstName: ADMIN_FIRST_NAME,
  lastName: ADMIN_LAST_NAME,
});

console.log(
  result.created
    ? `Created admin account: ${ADMIN_EMAIL}`
    : `Updated existing admin account: ${ADMIN_EMAIL}`
);
console.log(`Login with email "${ADMIN_EMAIL}" and password "${ADMIN_PASSWORD}"`);
console.log("Set ADMIN_EMAIL / ADMIN_PASSWORD env vars before running this script to use your own credentials.");
