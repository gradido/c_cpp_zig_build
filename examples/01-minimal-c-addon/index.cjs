/**
 * Loading the addon by a path relative to this file keeps the caller's
 * working directory out of it.
 */
module.exports = require('./build/minimal_addon.node')
