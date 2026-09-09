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

  // Restore user session on app launch
  const restoreSession = useCallback(async () => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: AuthUser = JSON.parse(stored);
        if (parsed?.id) {
          const restored = await invoke<AuthUser | null>('auth_restore_session', {
            userId: parsed.id,
          });

          if (restored) {
            setUser(restored);
            localStorage.setItem(STORAGE_KEY, JSON.stringify(restored));
          } else {
            // Session no longer valid in database
            localStorage.removeItem(STORAGE_KEY);
            setUser(null);
          }
        }
      }
    } catch (err) {
      console.error('[Auth] Failed to restore session:', err);
    } finally {
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
