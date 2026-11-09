const { createClient } = require("@supabase/supabase-js");

// Suspends or reactivates an account. Suspension is enforced in two places:
//  1. Supabase Auth bans the login (existing sessions can't refresh, new
//     logins are refused), which needs the service-role key — hence a server
//     function rather than a browser call.
//  2. profiles.status = 'suspended', which every database workflow function
//     checks, so a still-valid access token can't be used to do anything.
module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  const { userId, status } = req.body || {};
  if (!userId || !["active", "suspended"].includes(status)) {
    return res.status(400).json({ error: "userId and a valid status are required." });
  }

  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: callerAuth, error: callerAuthErr } = await admin.auth.getUser(token);
  if (callerAuthErr || !callerAuth?.user) {
    return res.status(401).json({ error: "Invalid session." });
  }

  const { data: callerProfile, error: callerProfileErr } = await admin
    .from("profiles")
    .select("role, status")
    .eq("id", callerAuth.user.id)
    .single();
  if (callerProfileErr || callerProfile?.role !== "admin" || callerProfile?.status !== "active") {
    return res.status(403).json({ error: "Admin access required." });
  }

  if (userId === callerAuth.user.id) {
    return res.status(400).json({ error: "You can't suspend your own account." });
  }

  const { data: targetProfile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (!targetProfile) {
    return res.status(404).json({ error: "Account not found." });
  }
  if (targetProfile.role === "admin") {
    return res.status(400).json({ error: "Admin accounts cannot be suspended." });
  }

  const { error: banErr } = await admin.auth.admin.updateUserById(userId, {
    ban_duration: status === "suspended" ? "876000h" : "none",
  });
  if (banErr) {
    return res.status(500).json({ error: banErr.message });
  }

  const { error: profileErr } = await admin.from("profiles").update({ status }).eq("id", userId);
  if (profileErr) {
    return res.status(500).json({ error: profileErr.message });
  }

  res.status(204).end();
};
