import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { pendingSyncCount } from '@/lib/db';
import { syncPendingExpressions } from '@/features/capture/addExpression';

/**
 * Drives the "동기화 대기" badge and syncs the offline queue.
 *
 * IMPORTANT: this used to sync ONLY on the browser's `online` event (the
 * transition from offline to online). If the device was already online
 * when a save silently failed (a real network blip, an RLS/schema error,
 * anything), that event never fires again and the item would be stuck in
 * the queue forever. Syncing on mount and on an interval as well closes
 * that gap -- every queued item gets retried periodically regardless of
 * whether a real offline/online transition ever happens.
 */
export function useOfflineSync() {
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  const refreshPendingCount = async () => {
    if (!user) return;
    setPendingCount(await pendingSyncCount(user.id));
  };

  const trySync = async () => {
    if (!user || !navigator.onLine) return;
    await syncPendingExpressions(user.id);
    await refreshPendingCount();
  };

  useEffect(() => {
    void refreshPendingCount();
    void trySync();
    const interval = setInterval(() => void trySync(), 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    function handleOnline() {
      setIsOnline(true);
      void trySync();
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

  return { pendingCount, isOnline, retrySync: trySync };
}
