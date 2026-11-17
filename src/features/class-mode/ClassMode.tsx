import { useNavigate } from 'react-router-dom';
import { QuickAddForm } from '@/features/capture/QuickAddForm';
import { useOfflineSync } from '@/features/capture/useOfflineSync';

export default function ClassMode() {
  const navigate = useNavigate();
  const { pendingCount, isOnline } = useOfflineSync();

  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-bold">수업 모드</h1>
        <span className="text-xs text-slate-400">
          {isOnline ? '연결됨' : `오프라인 저장중 (${pendingCount})`}
        </span>
      </div>

      <QuickAddForm sourceType="school" silent />

      <button
        onClick={() => navigate('/review?scope=today')}
        className="mt-2 rounded-full border border-blue-600 py-3 text-sm font-semibold text-blue-600 dark:text-blue-400"
      >
        오늘 배운 표현 복습하기 (5분)
      </button>
    </div>
  );
}
