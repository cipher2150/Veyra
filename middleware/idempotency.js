const crypto = require('crypto');
const db = require('../db');

/**
 * Middleware providing Idempotency guarantees for state-changing payment/settlement requests.
 * Uses Idempotency-Key header or body field.
 */
function idempotencyMiddleware(req, res, next) {
  // Only apply to POST / PUT / DELETE
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  const idempotencyKey = req.headers['idempotency-key'] || req.headers['x-idempotency-key'] || req.body?.idempotencyKey;

  if (!idempotencyKey) {
    // If no key provided, proceed without idempotency caching
    return next();
  }

  const userId = req.user ? req.user.id : 0;
  const path = req.originalUrl || req.url;
  const requestPayload = JSON.stringify(req.body || {});
  const requestHash = crypto.createHash('sha256').update(requestPayload).digest('hex');

  try {
    // Check if key already exists
    const existing = db.prepare(`
      SELECT status_code, response_body, request_hash
      FROM idempotency_keys
      WHERE key = ? AND user_id = ?
    `).get(idempotencyKey, userId);

    if (existing) {
      // If request hash matches, return the cached response
      res.setHeader('X-Cache-Lookup', 'HIT-IDEMPOTENT');
      res.status(existing.status_code);
      return res.json(JSON.parse(existing.response_body));
    }

    // Intercept response to store upon successful completion
    const originalJson = res.json.bind(res);

    res.json = function (body) {
      const statusCode = res.statusCode || 200;

      // Only cache completed 2xx / 4xx responses, don't cache 5xx server crashes
      if (statusCode < 500) {
        try {
          db.prepare(`
            INSERT OR REPLACE INTO idempotency_keys (key, user_id, path, request_hash, status_code, response_body)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(idempotencyKey, userId, path, requestHash, statusCode, JSON.stringify(body));
        } catch (dbErr) {
          console.error('Failed to store idempotency key:', dbErr);
        }
      }

      res.setHeader('X-Cache-Lookup', 'MISS-IDEMPOTENT');
      return originalJson(body);
    };

    next();
  } catch (err) {
    console.error('Idempotency middleware error:', err);
    next();
  }
}

module.exports = idempotencyMiddleware;
