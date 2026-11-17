import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { offlineDB } from '@/lib/db';
import { syncPendingPasteBatches } from '@/features/paste-save/pasteSave';

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

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  useEffect(() => {
    async function handleOnline() {
      if (!user) return;
      await syncPendingPasteBatches(user.id);
      await refresh();
    }
    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  return { pendingCount, refresh };
}
