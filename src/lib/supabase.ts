import { createClient } from '@supabase/supabase-js';

const supabaseUrl =
  import.meta.env.VITE_SUPABASE_URL || 'https://pnvnpencatzspkwxspac.supabase.co';
const supabaseAnonKey =
  import.meta.env.VITE_SUPABASE_ANON_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBudm5wZW5jYXR6c3Brd3hzcGFjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgyNzE4NjgsImV4cCI6MjEwMzg0Nzg2OH0.dgpzQb7cnDkikLHqtw2RyYE_j5RUHI3QIELcjmy4_tY';

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
