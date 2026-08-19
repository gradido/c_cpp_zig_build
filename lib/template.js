import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { exists, isDirectory, syncDir } from './fsutil.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** The `zig/` directory shipped inside this package. */
export function packagedTemplateDir() {
  return path.resolve(here, '..', 'zig')
}

/** The dependency name a project uses to import the template. */
export const ZIG_PACKAGE_NAME = 'zig_native_build'

/**
 * Copies the Zig template into the project.
 *
 * It is copied rather than referenced through `node_modules` because the
 * layout there is the package manager's business: npm, yarn, pnpm and Bun all
 * place, hoist, link and deduplicate differently, and a `build.zig.zon` path
 * that is correct under one of them is wrong under the next. A copy inside the
 * project is the same path everywhere.
 *
 * The copy is refreshed on every build, so upgrading the npm package upgrades
 * the template. Files whose content is unchanged are left untouched, which
 * keeps Zig's cache warm.
 *
 * @param {string} root project directory
 * @param {string} dirName where to place it, relative to the root
 * @param {import('./log.js').Logger} log
 * @returns {Promise<string>} absolute path of the template inside the project
 */
export async function syncTemplate(root, dirName, log) {
  const source = packagedTemplateDir()
  if (!isDirectory(source)) {
    throw new Error(`the zig-native-build package is incomplete: ${source} is missing`)
  }
  const destination = path.join(root, dirName)
  const written = await syncDir(source, destination)
  if (written > 0) {
    log.debug(`refreshed the Zig template in ${dirName} (${written} file(s))`)
  }
  await writeReadme(destination)
  return destination
}

async function writeReadme(destination) {
  const readme = path.join(destination, 'DO-NOT-EDIT.md')
  const text = [
    '# Generated directory',
    '',
    'This is a copy of the Zig build template from the `zig-native-build` npm',
    'package. It is rewritten on every build, so changes made here are lost.',
    '',
    'To change how the project builds, edit `build.zig` in the project root.',
    'To change the template itself, change the package.',
    '',
    'It is safe to add this directory to `.gitignore`.',
    '',
  ].join('\n')
  try {
    if (fs.readFileSync(readme, 'utf8') === text) {
      return
    }
  } catch {
    // not there yet
  }
  fs.writeFileSync(readme, text)
}

/**
 * Checks that the project's `build.zig.zon` declares the template, and
 * explains exactly what to add when it does not.
 *
 * The check is a regular expression rather than a ZON parse on purpose: this
 * is a diagnostic, and a diagnostic that fails to parse an otherwise valid
 * file is worse than no diagnostic at all.
 *
 * @param {string} root
 * @param {string} dirName
 * @param {import('./log.js').Logger} log
 */
export function checkZonDependency(root, dirName, log) {
  const zonPath = path.join(root, 'build.zig.zon')
  if (!exists(zonPath)) {
    throw new Error(
      `no build.zig.zon in ${root}.\n` +
        'Run `npx zig-native-build init` to create the build files for this project.',
    )
  }
  const zon = fs.readFileSync(zonPath, 'utf8')
  if (zon.includes(ZIG_PACKAGE_NAME)) {
    return
  }

  log.warn(
    `build.zig.zon does not declare the build template. Add this to its .dependencies:\n\n` +
      `    .${ZIG_PACKAGE_NAME} = .{ .path = "${dirName}" },\n`,
  )
}
