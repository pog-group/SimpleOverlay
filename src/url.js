// Turns whatever the user typed into a loadable http(s) address, or explains why it can't be one.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST = /^(localhost|127\.|\[|\d{1,3}(\.\d{1,3}){3})/i;

// Returns { ok: true, url } or { ok: false, error }.
function normalizeUrl(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, error: 'Enter a URL first.' };
  if (/\s/.test(text)) return { ok: false, error: 'A URL cannot contain spaces.' };

  let candidate = text;
  if (!SCHEME.test(candidate)) {
    // "example.com" -> https, "localhost:3000" / "192.168.1.5" -> http
    const host = candidate.split(/[/?#]/)[0];
    candidate = (LOCAL_HOST.test(host) ? 'http://' : 'https://') + candidate;
  }

  let url;
  try {
    url = new URL(candidate);
  } catch (_) {
    return { ok: false, error: 'That does not look like a valid URL.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http and https addresses are supported.' };
  }
  const host = url.hostname;
  if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) {
    return { ok: false, error: 'That address has no domain (like example.com).' };
  }
  return { ok: true, url: url.href };
}

module.exports = { normalizeUrl };
