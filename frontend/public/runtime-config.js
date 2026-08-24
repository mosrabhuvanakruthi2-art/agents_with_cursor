// Runtime configuration -- read when the page loads, NOT compiled into the bundle. Files in
// public/ are copied verbatim by Vite, so this stays editable on the server after a build: no
// rebuild, no toolchain, no Node.js required.
window.__APP_CONFIG__ = {
  // Hotjar Site ID (digits only). Not a secret: it ships inside client-side JavaScript that any
  // visitor can read. Blank = Hotjar fully off, no script requested, no session recorded.
  hotjarSiteId: "6766428",
};
