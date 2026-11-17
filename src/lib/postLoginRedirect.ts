// Google OAuth does a full-page redirect away and back, so any in-memory
// react-router state (e.g. <Navigate state={{ from }} />) is lost. This
// persists the intended destination across that round trip.
const KEY = 'fr_redirect_after_login';

export function rememberPathBeforeLogin(pathname: string) {
  if (pathname && pathname !== '/login') {
    localStorage.setItem(KEY, pathname);
  }
}

export function consumeRememberedPath(): string | null {
  const path = localStorage.getItem(KEY);
  if (path) localStorage.removeItem(KEY);
  return path;
}
