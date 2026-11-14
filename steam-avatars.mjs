const cacheSize = 128;
const refreshAfter = 60 * 60_000;
const retryAfter = 5 * 60_000;
const defaultAvatar = 'fef49e7fa7e1997310d705b2a6158ff8dc1cdfeb';

function fullAvatarUrl(value) {
  if (!value) return undefined;
  const modern = /^https:\/\/(avatars(?:\.(?:fastly|akamai|cloudflare))?\.steamstatic\.com)\/([a-f0-9]{40})(?:_full|_medium)?\.jpg$/i.exec(value);
  const legacy = /^https:\/\/steamcdn-a\.akamaihd\.net\/steamcommunity\/public\/images\/avatars\/[a-f0-9]{2}\/([a-f0-9]{40})(?:_full|_medium)?\.jpg$/i.exec(value);
  const hash = (modern?.[2] ?? legacy?.[1])?.toLowerCase();
  if (!hash) return undefined;
  return hash === defaultAvatar ? null : `https://${modern?.[1].toLowerCase() ?? 'avatars.fastly.steamstatic.com'}/${hash}_full.jpg`;
}

async function readProfile(url, contentType) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const type = response.headers.get('content-type') ?? '';
    if (response.ok && contentType.test(type)) return await response.text();
  } catch {
    // Keep the previous image while the Steam profile is temporarily unavailable.
  }
  return '';
}

export function createSteamAvatarLookup() {
  const cache = new Map();

  async function fetchAvatar(id, entry) {
    const url = `https://steamcommunity.com/profiles/${id}/`;
    const xml = await readProfile(`${url}?xml=1`, /\b(?:text|application)\/xml\b/i);
    let avatar;
    for (const size of ['Full', 'Medium', 'Icon']) {
      const match = new RegExp(`<avatar${size}>\\s*(?:<!\\[CDATA\\[)?([^\\s<\\]]+)`, 'i').exec(xml);
      avatar = fullAvatarUrl(match?.[1]);
      if (avatar !== undefined) break;
    }
    if (avatar === undefined) {
      const page = await readProfile(url, /\btext\/html\b/i);
      const image = /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["']/i.exec(page)?.[1];
      avatar = fullAvatarUrl(image);
    }
    if (avatar !== undefined) entry.avatar = avatar;
    entry.pending = false;
    entry.expires = Date.now() + (avatar ? refreshAfter : retryAfter);
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
