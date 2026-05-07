/**
 * adminAuth — convenience middleware array combining auth + rbac('admin').
 *
 * Usage (in a route file):
 *   const adminAuth = require('../middleware/adminAuth');
 *   router.use(adminAuth);
 */
const auth = require('./auth');
const rbac = require('./rbac');

module.exports = [auth, rbac('admin')];
