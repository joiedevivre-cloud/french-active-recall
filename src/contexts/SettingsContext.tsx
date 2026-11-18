import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/contexts/AuthContext';

export interface UserSettings {
  user_id: string;
  preferred_language: 'fr' | 'ko';
  card_display_mode: 'fr_first' | 'ko_first' | 'fr_only';
  daily_new_limit: number;
  daily_review_limit: number;
  speech_speed: number;
  silent_mode: boolean;
  dark_mode: boolean;
  ai_conversation_daily_minutes: number;
  b2_daily_target: number;
  b2_target_date: string | null;
  daily_writing_target: number;
  daily_speaking_target: number;
  desired_retention: number;
}

interface SettingsContextValue {
  settings: UserSettings | undefined;
  isLoading: boolean;
  updateSettings: (patch: Partial<UserSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

export function SettingsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['user_settings', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_settings')
        .select('*')
        .eq('user_id', user!.id)
        .single();
      if (error) throw error;
      return data as UserSettings;
    },
  });

  const mutation = useMutation({
    mutationFn: async (patch: Partial<UserSettings>) => {
      const { error } = await supabase.from('user_settings').update(patch).eq('user_id', user!.id);
      if (error) throw error;
    },
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: ['user_settings', user?.id] });
      queryClient.setQueryData<UserSettings | undefined>(['user_settings', user?.id], (prev) =>
        prev ? { ...prev, ...patch } : prev
      );
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['user_settings', user?.id] });
    },
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', settings?.dark_mode ?? false);
  }, [settings?.dark_mode]);

  return (
    <SettingsContext.Provider value={{ settings, isLoading, updateSettings: mutation.mutate }}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings(): SettingsContextValue {
  const ctx = useContext(SettingsContext);
  if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
  return ctx;
}
