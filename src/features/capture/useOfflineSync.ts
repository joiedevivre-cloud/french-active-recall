import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { pendingSyncCount } from '@/lib/db';
import { syncPendingExpressions } from '@/features/capture/addExpression';

/** Drives the "오프라인 저장 대기중" badge and auto-syncs on reconnect. */
export function useOfflineSync() {
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const refreshPendingCount = async () => {
    if (!user) return;
    setPendingCount(await pendingSyncCount(user.id));
  };

  useEffect(() => {
    void refreshPendingCount();
    const interval = setInterval(refreshPendingCount, 15_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    async function handleOnline() {
      setIsOnline(true);
      if (user) {
        await syncPendingExpressions(user.id);
        await refreshPendingCount();
      }
    }
    function handleOffline() {
      setIsOnline(false);
    }

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { pendingCount, isOnline };
}
