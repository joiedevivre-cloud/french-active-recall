import { Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AppShell } from '@/components/layout/AppShell';
import LoginPage from '@/features/auth/LoginPage';
import HomePage from '@/features/home/HomePage';
import ClassMode from '@/features/class-mode/ClassMode';
import LibraryPage from '@/features/library/LibraryPage';
import ExpressionDetailPage from '@/features/library/ExpressionDetailPage';
import VocabularyPage from '@/features/vocabulary/VocabularyPage';
import TodayPractice from '@/features/today/TodayPractice';
import DashboardPage from '@/features/dashboard/DashboardPage';
import PasteSavePage from '@/features/paste-save/PasteSavePage';
import AiBatchAddPage from '@/features/ai-batch/AiBatchAddPage';
import SyncStatusPage from '@/features/sync-status/SyncStatusPage';
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
                <Route path="/expression/:id" element={<ExpressionDetailPage />} />
                <Route path="/vocabulary" element={<VocabularyPage />} />
                <Route path="/today" element={<TodayPractice />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/paste-save" element={<PasteSavePage />} />
                <Route path="/ai-batch" element={<AiBatchAddPage />} />
                <Route path="/sync-status" element={<SyncStatusPage />} />
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
