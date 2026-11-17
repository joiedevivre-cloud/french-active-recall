import { QuickAddForm } from '@/features/capture/QuickAddForm';

interface QuickAddSheetProps {
  open: boolean;
  onClose: () => void;
}

export function QuickAddSheet({ open, onClose }: QuickAddSheetProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end bg-black/40" onClick={onClose}>
      <div
        className="w-full rounded-t-3xl bg-white p-5 pb-8 dark:bg-slate-950"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-bold">표현 추가</h2>
          <button onClick={onClose} className="text-2xl leading-none text-slate-400">
            &times;
          </button>
        </div>
        <QuickAddForm sourceType="manual" onSaved={() => undefined} />
      </div>
    </div>
  );
}
