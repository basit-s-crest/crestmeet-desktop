'use client';

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';

export interface AuthUser {
  id: string;
  email: string;
}

interface AuthResponse {
  success: boolean;
  user: AuthUser | null;
  error: string | null;
}

interface AuthContextType {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error?: string }>;
  signUp: (email: string, password: string) => Promise<{ error?: string }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const STORAGE_KEY = 'crestmeet_user_session';

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore and verify user session with backend
  const restoreSession = useCallback(async () => {
    console.log('[Auth] Restoring session...');
    try {
      if (typeof window === 'undefined') {
        setLoading(false);
        return;
      }
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        let parsed: AuthUser | null = null;
        try {
          parsed = JSON.parse(stored);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }

        if (parsed?.id) {
          console.log('[Auth] Validating session in backend for user ID:', parsed.id);
          // Optimistically ensure user is set
          setUser(prev => prev || parsed);
          setLoading(false);

          try {
            // Verify with backend Supabase without premature timeout
            const restored = await invoke<AuthUser | null>('auth_restore_session', {
              userId: parsed.id,
              user_id: parsed.id,
            });

            if (restored) {
              console.log('[Auth] Session verified with backend:', restored.email);
              setUser(restored);
              localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
            } else {
              console.log('[Auth] User account no longer exists in database, logging out');
              localStorage.removeItem(STORAGE_KEY);
              setUser(null);
            }
          } catch (err) {
            // If backend call fails due to temporary network/pool latency, keep optimistic session
            console.warn('[Auth] Backend session check encountered an error, retaining cached session:', err);
          }
        } else {
          localStorage.removeItem(STORAGE_KEY);
          setUser(null);
        }
      } else {
        console.log('[Auth] No stored session found, showing login view');
        setUser(null);
      }
    } catch (err) {
      console.error('[Auth] Failed to restore session:', err);
      setUser(null);
    } finally {
      console.log('[Auth] restoreSession complete, setting loading to false');
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restoreSession();
  }, [restoreSession]);

  const signIn = async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const res = await invoke<AuthResponse>('auth_login', {
        email: email.trim(),
        password,
      });

      if (!res.success || !res.user) {
        return { error: res.error || 'Invalid email or password' };
      }

      setUser(res.user);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(res.user));
      return {};
    } catch (err: any) {
      console.error('[Auth] Login error:', err);
      return { error: err?.toString() || 'Login failed' };
    }
  };

  const signUp = async (email: string, password: string): Promise<{ error?: string }> => {
    try {
      const res = await invoke<AuthResponse>('auth_signup', {
        email: email.trim(),
        password,
      });

      if (!res.success || !res.user) {
        return { error: res.error || 'Failed to create account' };
      }

      setUser(res.user);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(res.user));
      return {};
    } catch (err: any) {
      console.error('[Auth] Signup error:', err);
      return { error: err?.toString() || 'Registration failed' };
    }
  };

  const signOut = async () => {
    try {
      await invoke('auth_logout');
    } catch (err) {
      console.error('[Auth] Logout error:', err);
    }
    localStorage.removeItem(STORAGE_KEY);
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        signIn,
        signUp,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
