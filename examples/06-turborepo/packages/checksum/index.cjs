/**
 * Loading the addon by a path relative to this file keeps the caller's working
 * directory out of it — which matters here, because turbo runs every task from
 * its own package directory but the consumer resolving this module may sit
 * anywhere in the workspace.
 */
module.exports = require('./build/crc32_addon.node')
