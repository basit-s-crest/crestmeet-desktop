import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Default Supabase configuration derived from application backend settings
export const DEFAULT_SUPABASE_URL = 'https://yjqcxafjooyqfolnylwp.supabase.co';

export function getSupabaseUrl(): string {
  if (typeof window !== 'undefined') {
    const storedUrl = localStorage.getItem('meetily_supabase_url');
    if (storedUrl && storedUrl.trim().length > 0) return storedUrl.trim();
  }
  return process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL;
}

export function getSupabaseAnonKey(): string {
  if (typeof window !== 'undefined') {
    const storedKey = localStorage.getItem('meetily_supabase_anon_key');
    if (storedKey && storedKey.trim().length > 0) return storedKey.trim();
  }
  return process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
}

export function setSupabaseConfig(url: string, anonKey: string) {
  if (typeof window !== 'undefined') {
    localStorage.setItem('meetily_supabase_url', url.trim());
    localStorage.setItem('meetily_supabase_anon_key', anonKey.trim());
    _supabaseInstance = null; // Reset singleton
  }
}

let _supabaseInstance: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient | null {
  const url = getSupabaseUrl();
  const anonKey = getSupabaseAnonKey();

  if (!url || !anonKey) {
    return null;
  }

  if (!_supabaseInstance) {
    _supabaseInstance = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
  }

  return _supabaseInstance;
}
