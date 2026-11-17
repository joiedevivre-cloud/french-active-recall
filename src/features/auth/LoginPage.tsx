import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { consumeRememberedPath } from '@/lib/postLoginRedirect';

export default function LoginPage() {
  const { session, loading, signInWithGoogle } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (!loading && session) {
      const redirectTo = consumeRememberedPath();
      navigate(redirectTo ?? '/', { replace: true });
    }
  }, [loading, session, navigate]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-8 px-6 text-center">
      <div>
        <h1 className="text-2xl font-bold">French Active Recall</h1>
        <p className="mt-2 text-sm text-slate-500">
          수업 중 들은 프랑스어 표현을 10초 안에 저장하고, FSRS로 자동 복습하세요.
        </p>
      </div>
      <button
        onClick={signInWithGoogle}
        className="flex w-full max-w-xs items-center justify-center gap-3 rounded-full border border-slate-300 bg-white px-6 py-3 text-base font-medium text-slate-800 shadow-sm active:scale-95 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      >
        <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true">
          <path
            fill="#FFC107"
            d="M43.6 20.5H42V20H24v8h11.3C33.7 32.4 29.3 35 24 35c-6.1 0-11-4.9-11-11s4.9-11 11-11c2.8 0 5.3 1 7.3 2.7l5.7-5.7C33.6 6.5 29 4.5 24 4.5 13.2 4.5 4.5 13.2 4.5 24S13.2 43.5 24 43.5 43.5 34.8 43.5 24c0-1.2-.1-2.4-.3-3.5z"
          />
          <path
            fill="#FF3D00"
            d="M6.3 14.7l6.6 4.8C14.6 16 19 13 24 13c2.8 0 5.3 1 7.3 2.7l5.7-5.7C33.6 6.5 29 4.5 24 4.5c-7.7 0-14.3 4.4-17.7 10.2z"
          />
          <path
            fill="#4CAF50"
            d="M24 43.5c5 0 9.5-1.9 12.9-5.1l-6-5c-1.9 1.4-4.3 2.2-6.9 2.2-5.3 0-9.7-3.6-11.3-8.4l-6.6 5.1C9.6 39 16.2 43.5 24 43.5z"
          />
          <path
            fill="#1976D2"
            d="M43.6 20.5H42V20H24v8h11.3c-.9 2.5-2.6 4.6-4.9 6l6 5c3.5-3.2 5.7-8 5.7-13 0-1.2-.1-2.4-.3-3.5z"
          />
        </svg>
        Google로 로그인
      </button>
    </div>
  );
}
