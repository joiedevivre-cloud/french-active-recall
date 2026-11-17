import { NavLink } from 'react-router-dom';

const ITEMS = [
  { to: '/', label: '홈', icon: '🏠' },
  { to: '/library', label: '표현장', icon: '📚' },
  { to: '/review', label: '복습', icon: '🔁' },
  { to: '/ai-chat', label: 'AI 대화', icon: '💬' },
  { to: '/settings', label: '설정', icon: '⚙️' },
];

export function BottomNav() {
  return (
    <nav className="grid grid-cols-5 border-t border-slate-200 bg-white pb-[env(safe-area-inset-bottom)] dark:border-slate-800 dark:bg-slate-950">
      {ITEMS.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.to === '/'}
          className={({ isActive }) =>
            `flex flex-col items-center gap-1 py-2 text-xs ${
              isActive ? 'text-blue-600 dark:text-blue-400' : 'text-slate-500 dark:text-slate-400'
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
