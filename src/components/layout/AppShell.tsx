import type { ReactNode } from 'react';
import { BottomNav } from '@/components/layout/BottomNav';

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <main className="flex-1 overflow-y-auto">{children}</main>
      <BottomNav />
    </div>
  );
}
