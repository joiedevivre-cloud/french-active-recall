import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

type QuickFilter = 'all' | 'today' | 'week' | 'favorite';

interface ExpressionRow {
  id: string;
  expression_fr: string;
  meaning_ko: string | null;
  cefr_level: string | null;
  source_type: string;
  is_favorite: boolean;
  ai_analysis_status: string;
  created_at: string;
}

function startOfTodayIso(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

function startOfWeekIso(): string {
  const d = new Date();
  const day = d.getDay() === 0 ? 6 : d.getDay() - 1; // Monday-start week
  d.setDate(d.getDate() - day);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export default function LibraryPage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [quickFilter, setQuickFilter] = useState<QuickFilter>('all');
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editMeaning, setEditMeaning] = useState('');

  const { data: expressions = [], isLoading } = useQuery({
    queryKey: ['expressions', user?.id, quickFilter, search],
    enabled: !!user,
    queryFn: async () => {
      let query = supabase
        .from('expressions')
        .select('id, expression_fr, meaning_ko, cefr_level, source_type, is_favorite, ai_analysis_status, created_at')
        .eq('user_id', user!.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false });

      if (quickFilter === 'today') query = query.gte('created_at', startOfTodayIso());
      if (quickFilter === 'week') query = query.gte('created_at', startOfWeekIso());
      if (quickFilter === 'favorite') query = query.eq('is_favorite', true);
      if (search.trim()) query = query.ilike('expression_fr', `%${search.trim()}%`);

      const { data, error } = await query.limit(200);
      if (error) throw error;
      return data as ExpressionRow[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['expressions', user?.id] });

  const toggleFavorite = useMutation({
    mutationFn: async ({ id, next }: { id: string; next: boolean }) => {
      const { error } = await supabase.from('expressions').update({ is_favorite: next }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const softDelete = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('expressions').update({ deleted_at: new Date().toISOString() }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });

  const saveMeaning = useMutation({
    mutationFn: async ({ id, meaning }: { id: string; meaning: string }) => {
      const { error } = await supabase.from('expressions').update({ meaning_ko: meaning }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      setEditingId(null);
    },
  });

  const filters: { key: QuickFilter; label: string }[] = useMemo(
    () => [
      { key: 'all', label: '전체' },
      { key: 'today', label: '오늘' },
      { key: 'week', label: '이번주' },
      { key: 'favorite', label: '즐겨찾기' },
    ],
    []
  );

  return (
    <div className="flex flex-col gap-4 p-5">
      <h1 className="text-lg font-bold">표현장</h1>

      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="표현 검색..."
        className="w-full rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700 dark:bg-slate-900"
      />

      <div className="flex gap-2 overflow-x-auto">
        {filters.map((f) => (
          <button
            key={f.key}
            onClick={() => setQuickFilter(f.key)}
            className={`whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${
              quickFilter === f.key
                ? 'bg-blue-600 text-white'
                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-sm text-slate-400">불러오는 중...</p>}
      {!isLoading && expressions.length === 0 && (
        <p className="text-sm text-slate-400">저장된 표현이 없습니다.</p>
      )}

      <ul className="flex flex-col gap-2">
        {expressions.map((expr) => (
          <li key={expr.id} className="rounded-2xl border border-slate-200 p-4 dark:border-slate-800">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="text-base font-medium">{expr.expression_fr}</p>
                {editingId === expr.id ? (
                  <div className="mt-1 flex gap-2">
                    <input
                      autoFocus
                      value={editMeaning}
                      onChange={(e) => setEditMeaning(e.target.value)}
                      className="flex-1 rounded border border-slate-300 px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900"
                    />
                    <button
                      onClick={() => saveMeaning.mutate({ id: expr.id, meaning: editMeaning })}
                      className="text-sm text-blue-600"
                    >
                      저장
                    </button>
                  </div>
                ) : (
                  <p className="mt-0.5 text-sm text-slate-500">
                    {expr.meaning_ko ?? (expr.ai_analysis_status === 'pending' ? 'AI 분석 중...' : '의미 없음')}
                  </p>
                )}
                <p className="mt-1 text-xs text-slate-400">
                  {expr.cefr_level ?? '-'} · {expr.source_type}
                </p>
              </div>
              <div className="flex flex-col items-end gap-2 text-sm">
                <button onClick={() => toggleFavorite.mutate({ id: expr.id, next: !expr.is_favorite })}>
                  {expr.is_favorite ? '⭐' : '☆'}
                </button>
                <button
                  onClick={() => {
                    setEditingId(expr.id);
                    setEditMeaning(expr.meaning_ko ?? '');
                  }}
                  className="text-slate-400"
                >
                  수정
                </button>
                <button
                  onClick={() => {
                    if (confirm('이 표현을 삭제할까요? (복습 이력은 보존되고, 복습 대상에서 제외됩니다)')) {
                      softDelete.mutate(expr.id);
                    }
                  }}
                  className="text-red-400"
                >
                  삭제
                </button>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
