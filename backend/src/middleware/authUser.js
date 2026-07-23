const jwt = require('jsonwebtoken');
const env = require('../config/env');

/**
 * Verify the app login JWT (issued by POST /api/auth/microsoft/exchange) from the
 * Authorization: Bearer header and attach the signed-in user to the request.
 * Sets req.userEmail (lowercased) + req.userName. Responds 401 when missing/invalid
 * so the frontend can send the user back to the sign-in screen.
 */
function requireUser(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7).trim() : '';
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  if (!env.JWT_SECRET) return res.status(500).json({ error: 'JWT_SECRET not configured on the server' });
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET);
    const email = String(decoded.email || '').toLowerCase().trim();
    if (!email) return res.status(401).json({ error: 'Invalid session token' });
    req.userEmail = email;
    req.userName = decoded.name || '';
    return next();
  } catch {
    return res.status(401).json({ error: 'Session expired — please sign in again' });
  }
}

/** True when an execution is visible to this user: their own, or a legacy (pre-login) run. */
function ownsExecution(execution, userEmail) {
  if (!execution) return false;
  if (!execution.userEmail) return true; // legacy runs created before per-user scoping
  return String(execution.userEmail).toLowerCase() === String(userEmail || '').toLowerCase();
}

module.exports = { requireUser, ownsExecution };
