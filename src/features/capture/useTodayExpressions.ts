import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';
import { allPendingExpressions } from '@/lib/db';

export interface TodayExpressionItem {
  id: string;
  expressionFr: string;
  meaningKo: string | null;
  createdAt: string;
  synced: boolean;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/**
 * "오늘 저장한 표현" merged from the server AND the still-unsynced offline
 * queue, so a save shows up here immediately even before (or if never)
 * confirmed by Supabase -- the thing symptom #2/#3 was missing entirely.
 */
export function useTodayExpressions(refreshKey?: unknown) {
  const { user } = useAuth();
  const [items, setItems] = useState<TodayExpressionItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!user) return;
      setLoading(true);

      const [serverResult, pending] = await Promise.all([
        supabase
          .from('expressions')
          .select('id, expression_fr, meaning_ko, created_at')
          .eq('user_id', user.id)
          .is('deleted_at', null)
          .gte('created_at', startOfTodayIso())
          .order('created_at', { ascending: false }),
        allPendingExpressions(user.id),
      ]);

      if (cancelled) return;

      const serverItems: TodayExpressionItem[] = (serverResult.data ?? []).map((row) => ({
        id: row.id,
        expressionFr: row.expression_fr,
        meaningKo: row.meaning_ko,
        createdAt: row.created_at,
        synced: true,
      }));

      const todayStart = startOfTodayIso();
      const pendingItems: TodayExpressionItem[] = pending
        .filter((row) => row.createdAt >= todayStart)
        .map((row) => ({
          id: row.clientId,
          expressionFr: row.expressionFr,
          meaningKo: row.meaningKo ?? null,
          createdAt: row.createdAt,
          synced: false,
        }));

      const merged = [...pendingItems, ...serverItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      setItems(merged);
      setLoading(false);
    }

    void load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, refreshKey]);

  return { items, loading };
}
