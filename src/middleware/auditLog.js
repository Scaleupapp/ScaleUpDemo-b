/**
 * Audit logging middleware.
 *
 * Attach to sensitive routes to automatically log actions.
 * Usage: router.put('/me', auditLog('profile_update', 'profile'), ctrl.updateProfile);
 */

const gdprService = require('../services/gdprService');

function auditLog(action, category = 'data') {
  return (req, res, next) => {
    // Capture the original res.json to log after response
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      // Log asynchronously — don't block the response
      const userId = req.user?.userId || 'anonymous';
      gdprService.logAction({
        userId,
        action,
        category,
        details: {
          method: req.method,
          path: req.originalUrl,
          statusCode: res.statusCode,
          body: req.method !== 'GET' ? sanitizeBody(req.body) : undefined,
        },
        ip: req.ip || req.connection?.remoteAddress,
        userAgent: req.get('user-agent'),
      }).catch(() => {}); // Never crash on audit failure

      return originalJson(body);
    };
    next();
  };
}

// Remove sensitive fields from request body before logging
function sanitizeBody(body) {
  if (!body) return undefined;
  const sanitized = { ...body };
  const sensitiveFields = ['password', 'newPassword', 'otp', 'accessToken', 'refreshToken', 'idToken', 'googleIdToken'];
  for (const field of sensitiveFields) {
    if (sanitized[field]) sanitized[field] = '[REDACTED]';
  }
  return sanitized;
}

module.exports = auditLog;
