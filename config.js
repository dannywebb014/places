// Public keys only. Both are meant to be visible in a web page:
// - the Supabase anon key is limited by each table's row-level security,
//   so it can only ever reach the signed-in user's own rows;
// - the Google key is restricted in Google Cloud to this site's address and
//   to the Maps JavaScript and Places APIs; the Map ID only works with it.
export const SUPABASE_URL = "https://tvpmeysctvlhjyhotfyk.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR2cG1leXNjdHZsaGp5aG90ZnlrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ3MjkxMjcsImV4cCI6MjA5MDMwNTEyN30.FyerEiT3XA6uAXH_JlFhi_v2Job4GKLWuTFmbGVIjMg";
export const GOOGLE_MAPS_KEY = "AIzaSyC0nH5edZiwlJPKq3GesLqol9s2GaBti8s";
export const GOOGLE_MAP_ID = "da2868accb0f0f44fce7bc0d";
