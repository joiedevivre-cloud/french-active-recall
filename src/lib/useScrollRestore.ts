import { useEffect, useLayoutEffect } from 'react';

// AppShell scrolls inside <main>, not the window, so the browser's own
// scroll restoration doesn't help when coming back to a list. Saves
// main.scrollTop per key on leave, restores it once the list is rendered.
function mainEl(): HTMLElement | null {
  return typeof document === 'undefined' ? null : document.querySelector('main');
}

export function useScrollRestore(key: string, ready: boolean) {
  useLayoutEffect(() => {
    if (!ready) return;
    try {
      const saved = sessionStorage.getItem(`scroll:${key}`);
      const el = mainEl();
      if (saved && el) el.scrollTop = Number(saved);
    } catch {
      // storage unavailable (private mode) -- just start at the top
    }
  }, [key, ready]);

  useEffect(() => {
    return () => {
      try {
        const el = mainEl();
        if (el) sessionStorage.setItem(`scroll:${key}`, String(el.scrollTop));
      } catch {
        // ignore
      }
    };
  }, [key]);
}
