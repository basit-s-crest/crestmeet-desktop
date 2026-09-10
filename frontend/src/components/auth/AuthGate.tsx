'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { AuthView } from './AuthView';
import { Loader2 } from 'lucide-react';

interface AuthGateProps {
  children: React.ReactNode;
}

export function AuthGate({ children }: AuthGateProps) {
  const { user, loading } = useAuth();
  const [forceReady, setForceReady] = useState(false);

  useEffect(() => {
    // Safety fallback: Never allow the loading screen to hang for more than 1.5 seconds
    const timer = setTimeout(() => {
      setForceReady(true);
    }, 1500);
    return () => clearTimeout(timer);
  }, []);

  if (loading && !forceReady) {
    return (
      <div className="fixed inset-0 bg-gray-50 flex flex-col items-center justify-center p-4 z-50">
        <div className="flex flex-col items-center gap-3">
          <div className="px-4 py-1 rounded-full bg-blue-50 border border-blue-100 text-sm font-semibold text-gray-700 shadow-sm">
            CrestMeet
          </div>
          <div className="flex items-center gap-2 text-sm text-gray-500 mt-2">
            <Loader2 className="w-4 h-4 animate-spin text-gray-700" />
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <AuthView />;
  }

  return <>{children}</>;
}
