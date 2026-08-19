import { spawn } from 'node:child_process'

/**
 * Runs a command, streaming its output straight through to the terminal.
 *
 * Zig writes progress with carriage returns and colours; piping it through a
 * line buffer would flatten both, so stdio is inherited and the child owns the
 * terminal for the duration.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, log?: { debug(m: string): void } }} [options]
 * @returns {Promise<number>} the exit code, always 0 — a non-zero exit rejects
 */
export function run(cmd, args, options = {}) {
  const { cwd, env, log } = options
  log?.debug(`exec: ${cmd} ${args.join(' ')}`)

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ?? process.env,
      stdio: 'inherit',
      // On Windows the resolved zig.exe is a real binary, so no shell is
      // needed — and not using one keeps arguments free of quoting hazards.
      shell: false,
    })

    child.once('error', (err) => {
      reject(new Error(`failed to start '${cmd}': ${err.message}`, { cause: err }))
    })

    child.once('close', (code, signal) => {
      if (signal) {
        reject(new Error(`'${cmd}' was killed by signal ${signal}`))
      } else if (code === 0) {
        resolve(0)
      } else {
        reject(new Error(`'${cmd} ${args.join(' ')}' exited with code ${code}`))
      }
    })
  })
}

/**
 * Runs a command and captures stdout. Used for cheap probes (`zig version`,
 * `ldd --version`) where the output is the point and failure is not fatal.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function capture(cmd, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(cmd, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ code: -1, stdout: '', stderr: '' })
      return
    }
    child.stdout.on('data', (d) => {
      stdout += d
    })
    child.stderr.on('data', (d) => {
      stderr += d
    })
    child.once('error', () => resolve({ code: -1, stdout, stderr }))
    child.once('close', (code) => resolve({ code: code ?? -1, stdout, stderr }))
  })
}
