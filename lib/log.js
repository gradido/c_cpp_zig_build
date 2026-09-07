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

/** How often a repainting bar may redraw, and how long before it appears. */
const REFRESH_MS = 80
const INITIAL_DELAY_MS = 200
/** How many progress lines a log gets when there is no bar: one per fifth. */
const STEPS = 5

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
export const rootLog = makeLogger('c-cpp-zig-build', { colour: 'cyan' })

/**
 * Where a progress bar should be drawn, and whether it may repaint in place.
 *
 * A repainting bar needs a terminal it can *own*, and under turbo or a CI
 * runner nothing does: they write their own lines whenever they please, a bar
 * repainting between them overwrites them, and its closing erase takes whatever
 * shared the line. Zig's own progress display reaches the same conclusion and
 * switches itself off when it is not in charge of the terminal; this switches
 * to bounded log lines, which are correct whether anyone is watching live or
 * reading the log afterwards.
 *
 * @param {{ stdout?: { isTTY?: boolean }, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ repaint: boolean, silent?: boolean }}
 */
export function progressTarget(options = {}) {
  const env = options.env ?? process.env
  const stdout = options.stdout ?? process.stdout

  const forced = env.C_CPP_ZIG_BUILD_PROGRESS
  if (forced === 'off') {
    return { repaint: false, silent: true }
  }
  if (forced === 'lines' || env.NO_COLOR) {
    return { repaint: false }
  }
  // Our own stdout is a terminal, and nobody else is writing to it.
  return { repaint: Boolean(stdout.isTTY) && !env.TURBO_HASH && !env.CI }
}

/**
 * Renders a progress bar for downloads.
 *
 * On a terminal it is one line, repainted in place. Anywhere else — piped into
 * turbo, into CI, into a file — there is nothing to repaint, so a line is
 * emitted at every tenth of the download instead. A wall-clock throttle was the
 * wrong measure there: on a fast link a 90 MB download produced two lines, the
 * first of them `0%`, which reads as nothing happening.
 *
 * @param {string} label
 * @param {number} total  total bytes, 0 when unknown
 */
export function makeProgress(label, total) {
  const target = progressTarget()
  const mode = target.silent ? 'off' : target.repaint ? 'bar' : 'lines'

  let lastPrint = 0
  let lastPaint = 0
  let lastStep = -1
  let painted = false
  let done = false
  const startedAt = Date.now()

  const mb = (n) => (n / 1024 / 1024).toFixed(1)
  const render = (received) => {
    if (total <= 0) {
      return `  ${label} ${mb(received)} MiB`
    }
    const pct = Math.min(100, Math.round((received / total) * 100))
    const width = 24
    const filled = Math.round((pct / 100) * width)
    const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`
    return `  ${label} [${bar}] ${pct}% (${mb(received)}/${mb(total)} MiB)`
  }

  /** True when this update earns a line. @param {number} received */
  const worthALine = (received) => {
    if (total > 0) {
      // One line per fifth, so a log stays short whatever the file size.
      const step = Math.floor(Math.min(1, received / total) * STEPS)
      if (step <= lastStep) {
        return false
      }
      lastStep = step
      return true
    }
    // No total to measure against, so fall back to the clock.
    const now = Date.now()
    if (now - lastPrint < 3000) {
      return false
    }
    lastPrint = now
    return true
  }

  return {
    /** @param {number} received */
    update(received) {
      if (done || mode === 'off') {
        return
      }
      if (mode === 'bar') {
        const now = Date.now()
        // Silence for the first fifth of a second: a download that finishes
        // inside it should not flash a bar and wipe it again.
        if (!painted && now - startedAt < INITIAL_DELAY_MS) {
          return
        }
        // Repainting per chunk was thousands of writes for one toolchain,
        // most of them the same frame twice.
        if (now - lastPaint < REFRESH_MS) {
          return
        }
        lastPaint = now
        painted = true
        process.stdout.write(`\r${render(received)}`)
        return
      }
      if (worthALine(received)) {
        process.stdout.write(`${render(received)}\n`)
      }
    },
    /**
     * @param {number} [received] final byte count, for the closing line
     */
    finish(received) {
      if (done || mode === 'off') {
        return
      }
      done = true
      if (mode === 'bar') {
        // Only erase a line we actually drew.
        if (painted) {
          process.stdout.write('\r\x1b[2K')
        }
        return
      }
      // The last step rarely lands on a chunk boundary; without this the log
      // stops at 80% and looks truncated.
      if (received !== undefined && lastStep < STEPS) {
        process.stdout.write(`${render(received)}\n`)
      }
    },
  }
}
