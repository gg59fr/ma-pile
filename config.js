// Supabase project settings (Project Settings › API in the Supabase dashboard).
// The anon key is meant to be public: row-level security in supabase/schema.sql
// is what keeps each person's records private.
export const SUPABASE_URL = 'https://gxeaueokgolhgulaqodk.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imd4ZWF1ZW9rZ29saGd1bGFxb2RrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ1NTcxODEsImV4cCI6MjExMDEzMzE4MX0.igqn5Cld_cMJWgd8-e1rRGwh5N1xb08w8syKqTwpb-M';

// Optional: a free Google Books API key (console.cloud.google.com) makes the
// cover search more reliable for French books. Leave empty to use Open Library only
// plus Google Books without a key (often over its shared daily quota).
export const GOOGLE_BOOKS_KEY = '';
