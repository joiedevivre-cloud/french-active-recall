import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { offlineDB } from '@/lib/db';
import { syncPendingPasteBatches } from '@/features/paste-save/pasteSave';

/** Same fix as useOfflineSync: sync on mount + interval, not only on the
 * browser's 'online' transition event (which may never fire again once a
 * batch is stuck). */
export function usePasteOfflineSync() {
  const { user } = useAuth();
  const [pendingCount, setPendingCount] = useState(0);

  async function refresh() {
    if (!user) return;
    const count = await offlineDB.pendingPasteBatches
      .where({ userId: user.id })
      .filter((b) => b.syncStatus !== 'synced')
      .count();
    setPendingCount(count);
  }

  async function trySync() {
    if (!user || !navigator.onLine) return;
    await syncPendingPasteBatches(user.id);
    await refresh();
  }

  useEffect(() => {
    void refresh();
    void trySync();
    const interval = setInterval(() => void trySync(), 30_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    function handleOnline() {
      void trySync();
    }
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { pendingCount, refresh, retrySync: trySync };
}
