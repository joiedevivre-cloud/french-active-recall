import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppShell } from '@/components/layout/AppShell';
import LoginPage from '@/features/auth/LoginPage';
import HomePage from '@/features/home/HomePage';
import ClassMode from '@/features/class-mode/ClassMode';
import LibraryPage from '@/features/library/LibraryPage';
import PasteSavePage from '@/features/paste-save/PasteSavePage';
import TodayReview from '@/features/review/TodayReview';
import AiChatPlaceholder from '@/features/ai-chat/AiChatPlaceholder';
import SettingsPage from '@/features/settings/SettingsPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <AppShell>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/class-mode" element={<ClassMode />} />
                <Route path="/library" element={<LibraryPage />} />
                <Route path="/paste-save" element={<PasteSavePage />} />
                <Route path="/review" element={<TodayReview />} />
                <Route path="/ai-chat" element={<AiChatPlaceholder />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </AppShell>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}
