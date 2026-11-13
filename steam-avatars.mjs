const cacheSize = 128;
const refreshAfter = 60 * 60_000;
const retryAfter = 5 * 60_000;
const defaultAvatar = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';

export function createSteamAvatarLookup() {
  const cache = new Map();

  async function fetchAvatar(id, entry) {
    try {
      const response = await fetch(`https://steamcommunity.com/profiles/${id}/?xml=1`, {
        redirect: 'error', signal: AbortSignal.timeout(6000),
      });
      if (response.ok && /\b(?:text|application)\/xml\b/i.test(response.headers.get('content-type') ?? '')) {
        const profile = await response.text();
        const hash = /<avatarFull>\s*(?:<!\[CDATA\[)?https:\/\/avatars(?:\.(?:fastly|akamai|cloudflare))?\.steamstatic\.com\/([a-f0-9]{40})_full\.jpg/i.exec(profile)?.[1]?.toLowerCase();
        entry.avatar = hash && hash !== defaultAvatar ? `https://avatars.fastly.steamstatic.com/${hash}_full.jpg` : null;
      }
    } catch {
      // The overlay keeps its initials tile or cached image while Steam is unavailable.
    } finally {
      entry.pending = false;
      entry.expires = Date.now() + (entry.avatar ? refreshAfter : retryAfter);
    }
  }

  return function steamAvatar(id) {
    if (!/^\d{17}$/.test(id) || id < '76561197960265728' || id > '76561202255233023') return null;
    let entry = cache.get(id);
    if (!entry) {
      if (cache.size >= cacheSize) {
        const oldest = [...cache].find(([, candidate]) => !candidate.pending);
        if (!oldest) return null;
        cache.delete(oldest[0]);
      }
      entry = { avatar: null, expires: 0, pending: false };
      cache.set(id, entry);
    }
    if (!entry.pending && Date.now() >= entry.expires) {
      entry.pending = true;
      void fetchAvatar(id, entry);
    }
    return entry.avatar;
  };
}
