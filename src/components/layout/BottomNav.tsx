import { NavLink, useLocation } from 'react-router-dom';

// 홈 / 표현장 / 단어장 / 복습 / 더보기. AI 대화와 설정은 더보기(/more)로 옮김.
const ITEMS = [
  { to: '/', label: '홈', icon: '🏠', match: [] as string[] },
  { to: '/library', label: '표현장', icon: '📚', match: ['/expression'] },
  { to: '/vocabulary', label: '단어장', icon: '🔤', match: [] as string[] },
  { to: '/review', label: '복습', icon: '🔁', match: [] as string[] },
  { to: '/more', label: '더보기', icon: '☰', match: ['/settings', '/ai-chat', '/today', '/dashboard', '/class-mode', '/paste-save', '/ai-batch', '/sync-status', '/admin'] },
];

export function BottomNav() {
  const { pathname } = useLocation();
  return (
    <nav className="grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-950">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `flex flex-col items-center gap-1 py-2 text-xs ${
              isActive || item.match.some((m) => pathname.startsWith(m)) ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
            }`
          }
        >
          <span className="text-lg leading-none">{item.icon}</span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}
