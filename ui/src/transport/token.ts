/**
 * The `serve` token arrives in the URL fragment (`#token=…`), which browsers
 * never send to a server. Read it once, keep it for this tab only
 * (sessionStorage), and remove it from the address bar and history.
 */

const KEY = "assentor.token";

export function takeToken(win: Window = window): string | undefined {
  const match = /(?:^#|&)token=([0-9a-f]{16,128})(?:&|$)/i.exec(win.location.hash);
  if (match) {
    const token = match[1]!;
    try {
      win.sessionStorage.setItem(KEY, token);
    } catch {
      // Private mode etc.: the token still works for this page load.
    }
    win.history.replaceState(null, "", win.location.pathname + win.location.search);
    return token;
  }
  try {
    return win.sessionStorage.getItem(KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function forgetToken(win: Window = window): void {
  try {
    win.sessionStorage.removeItem(KEY);
  } catch {
    // nothing stored
  }
}
