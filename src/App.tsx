import { AppRoutes } from '@/routes';
import { useUpdatePrompt } from '@/pwa/useUpdatePrompt';

export default function App() {
  const { needRefresh, applyUpdate } = useUpdatePrompt();

  return (
    <>
      <AppRoutes />
      {needRefresh && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex items-center justify-between gap-3 bg-slate-900 p-4 text-sm text-white">
          <span>새 버전이 있습니다.</span>
          <button onClick={() => void applyUpdate()} className="rounded-full bg-blue-600 px-4 py-1.5 font-semibold">
            새로고침
          </button>
        </div>
      )}
    </>
  );
}
