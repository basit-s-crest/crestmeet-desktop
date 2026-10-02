'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Lock,
  Mail,
  Eye,
  EyeOff,
  Loader2,
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';

export function AuthView() {
  const { signIn, signUp, requestResetOtp, verifyAndResetPassword } = useAuth();

  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot_password'>('signin');

  // Basic Auth State
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Forgot Password / OTP State
  const [otp, setOtp] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [otpSent, setOtpSent] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [resendCooldown, setResendCooldown] = useState(0);

  // Status & Feedback
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // Resend cooldown timer countdown
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setInterval(() => {
      setResendCooldown((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [resendCooldown]);

  const handleSendOtp = async () => {
    setErrorMessage(null);
    setInfoMessage(null);

    if (!email.trim()) {
      setErrorMessage('Please enter your email address first.');
      return;
    }

    setSendingOtp(true);
    try {
      const res = await requestResetOtp(email);
      if (!res.success) {
        setErrorMessage(res.error || 'Failed to send verification code.');
      } else {
        setOtpSent(true);
        setInfoMessage(res.message || `A 6-digit verification code was sent to ${email}`);
        setResendCooldown(45);
        toast.success('Verification code sent to your email!');
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'Failed to send verification code.');
    } finally {
      setSendingOtp(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);
    setInfoMessage(null);

    // ==========================================
    // FORGOT PASSWORD FLOW (Verify OTP & Reset)
    // ==========================================
    if (mode === 'forgot_password') {
      if (!otpSent) {
        await handleSendOtp();
        return;
      }

      if (!otp.trim()) {
        setErrorMessage('Please enter the 6-digit verification code.');
        return;
      }

      if (!newPassword) {
        setErrorMessage('Please enter a new password.');
        return;
      }

      if (newPassword.length < 6) {
        setErrorMessage('Password must be at least 6 characters long.');
        return;
      }

      if (newPassword !== confirmNewPassword) {
        setErrorMessage('Passwords do not match.');
        return;
      }

      setLoading(true);
      try {
        const res = await verifyAndResetPassword(email, otp, newPassword);
        if (!res.success) {
          setErrorMessage(res.error || 'Failed to reset password.');
        } else {
          toast.success('Password reset successfully! Please sign in with your new password.');
          setPassword('');
          setNewPassword('');
          setConfirmNewPassword('');
          setOtp('');
          setOtpSent(false);
          setMode('signin');
        }
      } catch (err: any) {
        setErrorMessage(err?.message || 'Failed to update password.');
      } finally {
        setLoading(false);
      }
      return;
    }

    // ==========================================
    // SIGN IN / SIGN UP FLOW
    // ==========================================
    if (!email.trim() || !password) {
      setErrorMessage('Please fill in all fields.');
      return;
    }

    if (mode === 'signup') {
      if (password.length < 6) {
        setErrorMessage('Password must be at least 6 characters long.');
        return;
      }
      if (password !== confirmPassword) {
        setErrorMessage('Passwords do not match.');
        return;
      }
    }

    setLoading(true);

    try {
      if (mode === 'signin') {
        const res = await signIn(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else {
          toast.success('Welcome back!');
        }
      } else {
        const res = await signUp(email, password);
        if (res.error) {
          setErrorMessage(res.error);
        } else {
          toast.success('Account created successfully!');
        }
      }
    } catch (err: any) {
      setErrorMessage(err?.message || 'An unexpected error occurred.');
    } finally {
      setLoading(false);
    }
  };

  const isAccountNotFound = errorMessage && (
    errorMessage.toLowerCase().includes('no account found') ||
    errorMessage.toLowerCase().includes('not found in our records') ||
    errorMessage.toLowerCase().includes('sign up first') ||
    errorMessage.toLowerCase().includes('create an account')
  );

  return (
    <div className="fixed inset-0 bg-gray-50 flex items-center justify-center p-4 z-50 overflow-y-auto">
      <div className="w-full max-w-md flex flex-col items-center py-6">
        {/* CrestMeet Branding */}
        <div className="text-center mb-6 space-y-2">
          <div className="inline-block px-4 py-1 rounded-full bg-blue-50 border border-blue-100 text-sm font-semibold text-gray-700 shadow-sm">
            CrestMeet
          </div>
          <h1 className="text-3xl font-semibold text-gray-900">
            {mode === 'signin' && 'Sign In'}
            {mode === 'signup' && 'Create an Account'}
            {mode === 'forgot_password' && 'Reset Password'}
          </h1>
          <p className="text-sm text-gray-600 max-w-xs mx-auto">
            {mode === 'signin' && 'Access your meetings, transcripts, and notes.'}
            {mode === 'signup' && 'Set up your account to isolate and secure your meetings.'}
            {mode === 'forgot_password' &&
              (otpSent
                ? 'Enter the 6-digit code sent to your email to set a new password.'
                : 'Enter your account email to receive a verification code.')}
          </p>
        </div>

        {/* Auth Card */}
        <div className="w-full bg-white rounded-xl border border-gray-200 shadow-sm p-6 space-y-5">
          {/* Mode Switcher Tabs (Only for signin/signup) */}
          {mode !== 'forgot_password' ? (
            <div className="flex bg-gray-100 p-1 rounded-lg">
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setErrorMessage(null);
                  setInfoMessage(null);
                }}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                  mode === 'signin'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setErrorMessage(null);
                  setInfoMessage(null);
                }}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-all ${
                  mode === 'signup'
                    ? 'bg-white text-gray-900 shadow-sm'
                    : 'text-gray-500 hover:text-gray-900'
                }`}
              >
                Create Account
              </button>
            </div>
          ) : (
            /* Forgot Password Header Back Button */
            <div className="flex items-center justify-between pb-2 border-b border-gray-100">
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setOtpSent(false);
                  setErrorMessage(null);
                  setInfoMessage(null);
                }}
                className="inline-flex items-center text-xs font-medium text-gray-600 hover:text-gray-900 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5 mr-1" />
                Back to Sign In
              </button>
              <span className="text-[11px] font-medium text-gray-400">
                Email OTP Verification
              </span>
            </div>
          )}

          {/* Info Alert */}
          {infoMessage && (
            <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 flex items-start gap-2.5 text-xs text-blue-800 animate-in fade-in">
              <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5 text-blue-600" />
              <div className="space-y-1">
                <p>{infoMessage}</p>
              </div>
            </div>
          )}


          {/* Error Alert */}
          {errorMessage && (
            <div className="p-3 rounded-lg bg-red-50 border border-red-200 flex items-start gap-2.5 text-xs text-red-700 animate-in fade-in">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
              <div className="space-y-1.5 flex-1">
                <span>{errorMessage}</span>
                {/* Instant shortcut if account is not found */}
                {isAccountNotFound && (
                  <div>
                    <button
                      type="button"
                      onClick={() => {
                        setMode('signup');
                        setErrorMessage(null);
                        setInfoMessage(null);
                      }}
                      className="inline-flex items-center font-semibold text-red-800 underline hover:text-red-950 transition-colors"
                    >
                      Click here to create an account →
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Form */}
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* =================================================== */}
            {/* FORGOT PASSWORD FORM (Email + OTP + New Password) */}
            {/* =================================================== */}
            {mode === 'forgot_password' ? (
              <div className="space-y-4">
                {/* Email Input */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-medium text-gray-700">
                      Account Email
                    </label>
                    {otpSent && (
                      <button
                        type="button"
                        onClick={() => {
                          setOtpSent(false);
                          setOtp('');
                          setErrorMessage(null);
                          setInfoMessage(null);
                        }}
                        className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
                      >
                        Change email
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      type="email"
                      required
                      disabled={otpSent}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      className={`pl-9 h-10 border-gray-300 focus-visible:ring-gray-900 ${
                        otpSent ? 'bg-gray-50 text-gray-600' : ''
                      }`}
                    />
                  </div>
                </div>

                {!otpSent ? (
                  /* Step 1: Send OTP Button */
                  <Button
                    type="submit"
                    disabled={sendingOtp}
                    className="w-full h-10 bg-gray-900 hover:bg-gray-800 text-white font-medium rounded-lg shadow-sm"
                  >
                    {sendingOtp ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                        <span>Sending code...</span>
                      </>
                    ) : (
                      <span>Send Verification Code</span>
                    )}
                  </Button>
                ) : (
                  /* Step 2: OTP Code & New Password */
                  <div className="space-y-4 animate-in fade-in">
                    {/* OTP Input */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <label className="block text-xs font-medium text-gray-700">
                          6-Digit Verification Code
                        </label>
                        <button
                          type="button"
                          disabled={resendCooldown > 0 || sendingOtp}
                          onClick={handleSendOtp}
                          className="text-xs text-blue-600 hover:text-blue-800 hover:underline disabled:text-gray-400 disabled:no-underline inline-flex items-center"
                        >
                          <RefreshCw className={`w-3 h-3 mr-1 ${sendingOtp ? 'animate-spin' : ''}`} />
                          {resendCooldown > 0 ? `Resend code in ${resendCooldown}s` : 'Resend code'}
                        </button>
                      </div>
                      <div className="relative">
                        <ShieldCheck className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          type="text"
                          required
                          maxLength={6}
                          value={otp}
                          onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))}
                          placeholder="123456"
                          className="pl-9 h-10 border-gray-300 tracking-widest font-mono text-base focus-visible:ring-gray-900"
                        />
                      </div>
                    </div>

                    {/* New Password */}
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-gray-700">
                        New Password
                      </label>
                      <div className="relative">
                        <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          type={showNewPassword ? 'text' : 'password'}
                          required
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          placeholder="Minimum 6 characters"
                          className="pl-9 pr-9 h-10 border-gray-300 focus-visible:ring-gray-900"
                        />
                        <button
                          type="button"
                          onClick={() => setShowNewPassword(!showNewPassword)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                        >
                          {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>

                    {/* Confirm New Password */}
                    <div className="space-y-1.5">
                      <label className="block text-xs font-medium text-gray-700">
                        Confirm New Password
                      </label>
                      <div className="relative">
                        <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <Input
                          type={showNewPassword ? 'text' : 'password'}
                          required
                          value={confirmNewPassword}
                          onChange={(e) => setConfirmNewPassword(e.target.value)}
                          placeholder="Re-enter your new password"
                          className="pl-9 h-10 border-gray-300 focus-visible:ring-gray-900"
                        />
                      </div>
                    </div>

                    <Button
                      type="submit"
                      disabled={loading}
                      className="w-full h-10 bg-gray-900 hover:bg-gray-800 text-white font-medium rounded-lg shadow-sm"
                    >
                      {loading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin mr-2" />
                          <span>Updating password...</span>
                        </>
                      ) : (
                        <span>Reset Password</span>
                      )}
                    </Button>
                  </div>
                )}
              </div>
            ) : (
              /* =================================================== */
              /* SIGN IN & SIGN UP FORM                              */
              /* =================================================== */
              <>
                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-gray-700">
                    Email Address
                  </label>
                  <div className="relative">
                    <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="name@example.com"
                      className="pl-9 h-10 border-gray-300 focus-visible:ring-gray-900"
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label className="block text-xs font-medium text-gray-700">
                      Password
                    </label>
                    {mode === 'signin' && (
                      <button
                        type="button"
                        onClick={() => {
                          setMode('forgot_password');
                          setOtpSent(false);
                          setErrorMessage(null);
                          setInfoMessage(null);
                        }}
                        className="text-xs text-blue-600 hover:text-blue-700 hover:underline font-medium"
                      >
                        Forgot password?
                      </button>
                    )}
                  </div>
                  <div className="relative">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="••••••••"
                      className="pl-9 pr-9 h-10 border-gray-300 focus-visible:ring-gray-900"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {mode === 'signup' && (
                  <div className="space-y-1.5">
                    <label className="block text-xs font-medium text-gray-700">
                      Confirm Password
                    </label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                      <Input
                        type={showPassword ? 'text' : 'password'}
                        required
                        value={confirmPassword}
                        onChange={(e) => setConfirmPassword(e.target.value)}
                        placeholder="••••••••"
                        className="pl-9 h-10 border-gray-300 focus-visible:ring-gray-900"
                      />
                    </div>
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full h-10 bg-gray-900 hover:bg-gray-800 text-white font-medium rounded-lg shadow-sm"
                >
                  {loading ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      <span>{mode === 'signin' ? 'Signing in...' : 'Creating account...'}</span>
                    </>
                  ) : (
                    <span>{mode === 'signin' ? 'Sign In' : 'Create Account'}</span>
                  )}
                </Button>
              </>
            )}
          </form>

          {/* Footer note for Sign In / Sign Up */}
          {mode !== 'forgot_password' && (
            <div className="text-center pt-2 text-xs text-gray-500">
              {mode === 'signin' ? (
                <p>
                  Don't have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signup');
                      setErrorMessage(null);
                      setInfoMessage(null);
                    }}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    Create one
                  </button>
                </p>
              ) : (
                <p>
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={() => {
                      setMode('signin');
                      setErrorMessage(null);
                      setInfoMessage(null);
                    }}
                    className="font-medium text-gray-900 hover:underline"
                  >
                    Sign in
                  </button>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Security assurance */}
        <p className="mt-6 text-xs text-gray-400 text-center">
          Meetings and transcripts are securely isolated to your account.
        </p>
      </div>
    </div>
  );
}
