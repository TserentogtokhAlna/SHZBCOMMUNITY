const SUPABASE_URL = "https://balgrpquudbtxwqsfwme.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJhbGdycHF1dWRidHh3cXNmd21lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg1MTE1NDAsImV4cCI6MjEwNDA4NzU0MH0.ZqebqnTmF-Zhcam0iPWrpgap3Axuw7sZ-D7x6N2Y3kQ";

const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
