// Supabase client initialization for Voca extension
// Loaded from CDN in popup.html

const SUPABASE_URL = 'https://ouwfkmjuckuoiwzwoopd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im91d2ZrbWp1Y2t1b2l3endvb3BkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MzE0MTAsImV4cCI6MjA5MTUwNzQxMH0.n-OPD8fl11kEbl_aD1QLMuvS4WmIHIiPOsk6DKMocsg';

// Initialize Supabase client (available globally when using CDN)
let supabaseClient = null;

function initSupabase() {
  if (typeof supabase !== 'undefined' && supabase.createClient) {
    supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return supabaseClient;
  }
  console.error('Supabase library not loaded');
  return null;
}

function getSupabase() {
  if (!supabaseClient) {
    return initSupabase();
  }
  return supabaseClient;
}

// Export for use in other scripts
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initSupabase, getSupabase, SUPABASE_URL, SUPABASE_ANON_KEY };
}
