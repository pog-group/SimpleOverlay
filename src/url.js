// Turns whatever the user typed into a loadable http(s), file, data or about:blank address, or explains why it can't be one.
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const LOCAL_HOST = /^(localhost|127\.|\[|\d{1,3}(\.\d{1,3}){3})/i;

// Returns { ok: true, url } or { ok: false, error }.
function normalizeUrl(input) {
  const text = String(input || '').trim();
  if (!text) return { ok: false, error: 'Enter a URL first.' };

  // Local files: "file:/C:/x/index.html", "file:///C:/x", or a plain Windows path like C:\x\index.html.
  // Spaces are fine here; the URL parser encodes them.
  if (/^file:/i.test(text) || /^[a-z]:[\\/]/i.test(text)) {
    let url;
    try {
      url = new URL(/^file:/i.test(text) ? text : 'file:///' + text.replace(/\\/g, '/'));
    } catch (_) {
      return { ok: false, error: 'That does not look like a valid file address.' };
    }
    if (url.protocol !== 'file:') return { ok: false, error: 'That does not look like a valid file address.' };
    return { ok: true, url: url.href };
  }

  if (/^about:blank$/i.test(text)) return { ok: true, url: 'about:blank' };

  // Inline pages, e.g. "data:text/html,<h1>Hi</h1>". Spaces are fine; the URL parser encodes them.
  if (/^data:/i.test(text)) {
    try {
      const url = new URL(text);
      if (url.protocol === 'data:' && url.pathname.includes(',')) return { ok: true, url: url.href };
    } catch (_) { /* falls through */ }
    return { ok: false, error: 'A data address looks like data:text/html,<h1>Hello</h1>.' };
  }

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
    return { ok: false, error: 'Only http, https, file, data and about:blank addresses are supported.' };
  }
  const host = url.hostname;
  if (!host.includes('.') && host !== 'localhost' && !host.startsWith('[')) {
    return { ok: false, error: 'That address has no domain (like example.com).' };
  }
  return { ok: true, url: url.href };
}

module.exports = { normalizeUrl };
