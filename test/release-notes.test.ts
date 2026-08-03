import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const script = join(process.cwd(), 'scripts/release-notes.mjs')
const fixtureDirectories: string[] = []

function createFixture(changelog: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'release-notes-'))
  fixtureDirectories.push(directory)
  writeFileSync(join(directory, 'CHANGELOG.md'), changelog)
  return directory
}

function runFailure(version: string, changelog: string) {
  const directory = createFixture(changelog)
  return spawnSync(process.execPath, [script, version, join(directory, 'notes.md')], {
    cwd: directory,
    encoding: 'utf8',
  })
}

function runSuccess(version: string, changelog: string): string {
  const directory = createFixture(changelog)
  const output = join(directory, 'notes.md')
  execFileSync(process.execPath, [script, version, output], { cwd: directory })
  return readFileSync(output, 'utf8')
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('writes the requested changelog section exactly', () => {
  const changelog = '# Changelog\n\n## [Unreleased]\n\n- Later work.\n\n## [1.0.0] - 2026-08-03\n\n### Added\n\n- First release.\n\n## [0.1.0] - 2026-07-31\n\n- Foundation.\n'

  expect(runSuccess('1.0.0', changelog)).toBe('### Added\n\n- First release.\n')
})

it('preserves indentation on the first notes line', () => {
  const changelog = '# Changelog\n\n## [1.0.0]\n\n    const answer = 42\n\n## [0.1.0]\n\n- Foundation.\n'

  expect(runSuccess('1.0.0', changelog)).toBe('    const answer = 42\n')
})

it('preserves Markdown hard-break spaces on the last notes line', () => {
  const changelog = '# Changelog\n\n## [1.0.0]\n\n- Keep this break.  \n\n## [0.1.0]\n\n- Foundation.\n'

  expect(runSuccess('1.0.0', changelog)).toBe('- Keep this break.  \n')
})

it.each([
  ['backtick', '```', '\n'],
  ['tilde', '~~~', '\r\n'],
])('does not treat an H2 inside a %s fence as the next section', (_name, fence, lineEnding) => {
  const changelog = [
    '# Changelog',
    '',
    '## [1.0.0]',
    '',
    `${fence}markdown`,
    '## Example heading',
    fence,
    '',
    '- Still release notes.',
    '',
    '## [0.1.0]',
    '',
    '- Foundation.',
    '',
  ].join(lineEnding)
  const expected = [`${fence}markdown`, '## Example heading', fence, '', '- Still release notes.'].join(lineEnding)

  expect(runSuccess('1.0.0', changelog)).toBe(`${expected}\n`)
})

it.each([
  '1.0.0-alpha.1',
  '2.3.4+build.5',
  '2.3.4-rc.1+build.5',
])('accepts the full semantic version %s', (version) => {
  const changelog = `# Changelog\n\n## [${version}]\n\n- Notes.\n`

  expect(runSuccess(version, changelog)).toBe('- Notes.\n')
})

it.each([
  'release',
  '01.0.0',
  '1.0.0-alpha..1',
  'v1.0.0',
])('rejects the invalid semantic version %s', (version) => {
  const result = runFailure(version, '# Changelog\n')

  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/semantic version/i)
})

it('rejects a missing changelog section', () => {
  const result = runFailure('1.0.0', '# Changelog\n\n## [0.1.0]\n\n- Foundation.\n')

  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/no changelog section/i)
})

it('rejects an empty changelog section', () => {
  const result = runFailure('1.0.0', '# Changelog\n\n## [1.0.0]\n  \n\t\n## [0.1.0]\n\n- Foundation.\n')

  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/has no notes/i)
})

it('rejects a duplicate changelog section', () => {
  const result = runFailure(
    '1.0.0',
    '# Changelog\n\n## [1.0.0]\n\n- First.\n\n## [1.0.0] - 2026-08-03\n\n- Duplicate.\n',
  )

  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/more than once/i)
})
