import { useAuth } from '@/contexts/AuthContext';
import { useSettings } from '@/contexts/SettingsContext';
import { Link } from 'react-router-dom';
import { isAdminSession } from '@/lib/isAdmin';

export default function SettingsPage() {
  const { user, session, signOut } = useAuth();
  const { settings, updateSettings, isLoading } = useSettings();

  if (isLoading || !settings) {
    return <div className="p-5 text-sm text-slate-400">불러오는 중...</div>;
  }

  return (
    <div className="flex flex-col gap-6 p-5">
      <h1 className="text-lg font-bold">설정</h1>

      <div className="flex items-center justify-between">
        <span>다크 모드</span>
        <input
          type="checkbox"
          checked={settings.dark_mode}
          onChange={(e) => updateSettings({ dark_mode: e.target.checked })}
        />
      </div>

      <div className="flex items-center justify-between">
        <span>무음 모드 (수업 모드 기본값)</span>
        <input
          type="checkbox"
          checked={settings.silent_mode}
          onChange={(e) => updateSettings({ silent_mode: e.target.checked })}
        />
      </div>

      <div>
        <label className="text-sm text-slate-500">카드 표시 방식</label>
        <select
          value={settings.card_display_mode}
          onChange={(e) => updateSettings({ card_display_mode: e.target.value as typeof settings.card_display_mode })}
          className="mt-1 w-full rounded-xl border border-slate-300 p-2 dark:border-slate-700 dark:bg-slate-900"
        >
          <option value="fr_first">프랑스어 우선</option>
          <option value="ko_first">한국어 우선</option>
          <option value="fr_only">프랑스어만</option>
        </select>
      </div>

      <div>
        <label className="text-sm text-slate-500">하루 신규 표현 목표: {settings.daily_new_limit}개</label>
        <input
          type="range"
          min={1}
          max={30}
          value={settings.daily_new_limit}
          onChange={(e) => updateSettings({ daily_new_limit: Number(e.target.value) })}
          className="w-full"
        />
      </div>

      <div>
        <label className="text-sm text-slate-500">하루 복습 목표: {settings.daily_review_limit}개</label>
        <input
          type="range"
          min={5}
          max={60}
          value={settings.daily_review_limit}
          onChange={(e) => updateSettings({ daily_review_limit: Number(e.target.value) })}
          className="w-full"
        />
      </div>

      <div>
        <label className="text-sm text-slate-500">하루 작문 연습 목표: {settings.daily_writing_target}개</label>
        <input
          type="range"
          min={0}
          max={30}
          value={settings.daily_writing_target}
          onChange={(e) => updateSettings({ daily_writing_target: Number(e.target.value) })}
          className="w-full"
        />
      </div>

      <div>
        <label className="text-sm text-slate-500">하루 말하기 연습 목표: {settings.daily_speaking_target}개</label>
        <input
          type="range"
          min={0}
          max={30}
          value={settings.daily_speaking_target}
          onChange={(e) => updateSettings({ daily_speaking_target: Number(e.target.value) })}
          className="w-full"
        />
      </div>

      <div>
        <label className="text-sm text-slate-500">목표 기억 유지율: {Math.round(settings.desired_retention * 100)}%</label>
        <input
          type="range"
          min={70}
          max={97}
          value={Math.round(settings.desired_retention * 100)}
          onChange={(e) => updateSettings({ desired_retention: Number(e.target.value) / 100 })}
          className="w-full"
        />
        <p className="mt-1 text-xs text-slate-400">높을수록 복습 간격이 짧아지고 더 자주 복습합니다 (FSRS 설정값).</p>
      </div>

      {/* 메뉴 숨김은 편의 기능일 뿐 -- 실제 권한은 admin-prompts 함수가 서버에서 확인 */}
      {isAdminSession(session) && (
        <Link to="/admin/prompts" className="rounded-xl border border-slate-300 p-3 text-sm dark:border-slate-700">
          🛠 관리자: AI 프롬프트 관리
        </Link>
      )}

      <div className="mt-4 border-t border-slate-200 pt-4 dark:border-slate-800">
        <p className="text-sm text-slate-400">{user?.email}</p>
        <button onClick={() => void signOut()} className="mt-2 text-sm text-red-500">
          로그아웃
        </button>
      </div>
    </div>
  );
}
