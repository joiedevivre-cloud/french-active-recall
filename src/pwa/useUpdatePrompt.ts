import { useState } from 'react';
import { registerSW } from 'virtual:pwa-register';

/**
 * registerType: 'prompt' (see vite.config.ts) means the new service worker
 * installs in the background but does NOT take over immediately -- we ask
 * the user first, so a review session mid-flight is never interrupted by a
 * silent reload.
 */
export function useUpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateSW] = useState(() =>
    registerSW({
      onNeedRefresh() {
        setNeedRefresh(true);
      },
    })
  );

  async function applyUpdate() {
    await updateSW(true);
    setNeedRefresh(false);
  }

  return { needRefresh, applyUpdate };
}
