// Seed-time hyperlink normalizer.
//
// Test-data emails historically used the reserved documentation domain example.com (and
// subdomains like docs.example.com) in their hyperlinks. Those hosts render the blank
// "Example Domain" page — or, for made-up subdomains, DNS_PROBE_FINISHED_NXDOMAIN — which
// looks broken to a QA reviewer clicking the links.
//
// This rewrites the HOST of any http(s)/mailto link on example.com (or *.example.com) to a
// real, reachable host, while preserving the scheme, path, query string and unicode — so the
// link-variety the deep-validation checks (http vs https, query/unicode encoding, mailto with
// subject) is kept intact. Applied centrally where every email body is built, so it covers
// hardcoded seeds, JSON (custom-test-cases.json) and the binary .xlsx test-case sources across
// all combinations. Bare email-address text (e.g. "Email: test@example.com" in a body) is left
// untouched — only actual hyperlinks are rewritten.

const REAL_LINK_HOST = 'www.cloudfuze.com';
const REAL_MAIL_DOMAIN = 'cloudfuze.com';

/**
 * @param {string} text HTML or plain-text email body
 * @returns {string} body with example.com hyperlink hosts rewritten to a reachable host
 */
function realizePlaceholderLinks(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    // http(s)://[sub.]example.com  →  https-scheme kept, host → real (path/query preserved)
    .replace(/(https?:\/\/)(?:[a-z0-9-]+\.)*example\.com/gi, `$1${REAL_LINK_HOST}`)
    // mailto:local@[sub.]example.com  →  local part + params kept, domain → real
    .replace(/(mailto:[^\s"'<>@]+@)(?:[a-z0-9-]+\.)*example\.com/gi, `$1${REAL_MAIL_DOMAIN}`);
}

module.exports = { realizePlaceholderLinks, REAL_LINK_HOST, REAL_MAIL_DOMAIN };
