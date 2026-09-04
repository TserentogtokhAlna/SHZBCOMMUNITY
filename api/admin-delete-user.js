const { createClient } = require("@supabase/supabase-js");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed." });
  }

  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "Not authenticated." });
  }

  const { userId } = req.body || {};
  if (!userId) {
    return res.status(400).json({ error: "userId is required." });
  }

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: callerAuth, error: callerAuthErr } = await admin.auth.getUser(token);
  if (callerAuthErr || !callerAuth?.user) {
    return res.status(401).json({ error: "Invalid session." });
  }

  const { data: callerProfile, error: callerProfileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", callerAuth.user.id)
    .single();
  if (callerProfileErr || callerProfile?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required." });
  }

  const { data: targetProfile } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();
  if (targetProfile?.role === "admin") {
    return res.status(400).json({ error: "Admin accounts cannot be deleted." });
  }

  const { error: deleteErr } = await admin.auth.admin.deleteUser(userId);
  if (deleteErr) {
    return res.status(500).json({ error: deleteErr.message });
  }

  res.status(204).end();
};
