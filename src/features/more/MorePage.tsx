import { Link } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { isAdminSession } from '@/lib/isAdmin';

// Menus that used to sit in the bottom nav (AI 대화, 설정) plus the other
// existing screens, so nothing became unreachable when 단어장 took a slot.
const ITEMS: { to: string; icon: string; label: string; desc?: string }[] = [
  { to: '/settings', icon: '⚙️', label: '설정' },
  { to: '/ai-chat', icon: '💬', label: 'AI 대화' },
  { to: '/today', icon: '✍️', label: '오늘의 학습', desc: '복습 + 작문·말하기' },
  { to: '/dashboard', icon: '📊', label: '대시보드' },
  { to: '/class-mode', icon: '🏫', label: '수업 모드' },
  { to: '/paste-save', icon: '📋', label: '붙여넣기 바로 저장' },
  { to: '/ai-batch', icon: '🤖', label: 'AI 일괄 분석으로 추가' },
  { to: '/sync-status', icon: '🔄', label: '동기화 상태' },
];

export default function MorePage() {
  const { session } = useAuth();
  const items = isAdminSession(session) ? [...ITEMS, { to: '/admin/prompts', icon: '🛠', label: '관리자: AI 프롬프트 관리' }] : ITEMS;
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-bold">더보기</h1>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <li key={item.to}>
            <Link to={item.to} className="flex items-center gap-3 rounded-2xl border border-slate-200 p-3 dark:border-slate-800">
              <span className="text-xl">{item.icon}</span>
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                {item.desc && <span className="block text-xs text-slate-400">{item.desc}</span>}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
