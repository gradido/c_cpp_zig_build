/**
 * A very small logger.
 *
 * Hand-rolled rather than pulled in: this package's dependencies are limited
 * to the two header packages that a build genuinely cannot do without, and
 * colouring some text is not in that class.
 */

const COLOUR_ENABLED =
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  (Boolean(process.stdout.isTTY) || process.env.FORCE_COLOR === '1')

const CODES = {
  reset: 0,
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  grey: 90,
}

const ESC = '\x1b['

/** @param {keyof typeof CODES} name */
function wrap(name) {
  /** @param {string} s */
  return (s) => (COLOUR_ENABLED ? `${ESC}${CODES[name]}m${s}${ESC}0m` : s)
}

export const c = {
  bold: wrap('bold'),
  dim: wrap('dim'),
  red: wrap('red'),
  green: wrap('green'),
  yellow: wrap('yellow'),
  blue: wrap('blue'),
  magenta: wrap('magenta'),
  cyan: wrap('cyan'),
  grey: wrap('grey'),
}

const PREFIX_COLOURS = ['cyan', 'magenta', 'blue', 'yellow', 'green', 'red']
let rotation = 0

/**
 * Creates a logger that tags every line with a coloured prefix, so that the
 * output of several targets building in parallel stays readable.
 *
 * @param {string} prefix
 * @param {{ verbose?: boolean, colour?: keyof typeof CODES }} [options]
 */
export function makeLogger(prefix, options = {}) {
  const colour = options.colour ?? PREFIX_COLOURS[rotation++ % PREFIX_COLOURS.length]
  const tag = `${c.bold('[')}${c[colour](prefix)}${c.bold(']')}`

  const write = (stream, message) => {
    for (const line of String(message).split(/\r?\n/)) {
      if (line.trim().length > 0) {
        stream.write(`${tag} ${line}\n`)
      }
    }
  }

  const log = (message) => write(process.stdout, message)
  log.info = log
  log.raw = (message) => process.stdout.write(`${message}\n`)
  log.step = (message) => write(process.stdout, c.bold(message))
  log.warn = (message) => write(process.stderr, `${c.yellow('warning')} ${message}`)
  log.error = (message) => write(process.stderr, `${c.red('error')} ${message}`)
  log.debug = (message) => {
    if (options.verbose) {
      write(process.stdout, c.grey(message))
    }
  }
  log.verbose = Boolean(options.verbose)
  return log
}

/** The logger used before any target-specific one exists. */
export const rootLog = makeLogger('zig-native-build', { colour: 'cyan' })

/**
 * Renders a single-line progress bar for downloads. Falls back to periodic
 * lines when stdout is not a TTY, so CI logs stay bounded.
 *
 * @param {string} label
 * @param {number} total  total bytes, 0 when unknown
 */
export function makeProgress(label, total) {
  const tty = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR
  let lastPrint = 0
  let done = false

  return {
    /** @param {number} received */
    update(received) {
      if (done) {
        return
      }
      const now = Date.now()
      if (!tty && now - lastPrint < 3000) {
        return
      }
      lastPrint = now
      const mb = (n) => (n / 1024 / 1024).toFixed(1)
      if (total > 0) {
        const pct = Math.min(100, Math.round((received / total) * 100))
        const width = 24
        const filled = Math.round((pct / 100) * width)
        const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`
        const line = `  ${label} [${bar}] ${pct}% (${mb(received)}/${mb(total)} MiB)`
        process.stderr.write(tty ? `\r${line}` : `${line}\n`)
      } else {
        const line = `  ${label} ${mb(received)} MiB`
        process.stderr.write(tty ? `\r${line}` : `${line}\n`)
      }
    },
    finish() {
      if (done) {
        return
      }
      done = true
      if (tty) {
        process.stderr.write('\r\x1b[2K')
      }
    },
  }
}
