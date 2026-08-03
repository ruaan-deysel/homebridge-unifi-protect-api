import { readFileSync, writeFileSync } from 'node:fs'
import process from 'node:process'

const [version, outputFile] = process.argv.slice(2)

if (!version || !outputFile) {
  console.error('Usage: node scripts/release-notes.mjs <version> <output-file>')
  process.exit(2)
}

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-z-][0-9a-z-]*))*)?(?:\+[0-9a-z-]+(?:\.[0-9a-z-]+)*)?$/i

if (!semver.test(version)) {
  console.error(`${JSON.stringify(version)} is not a semantic version.`)
  process.exit(1)
}

const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function markdownLines(markdown) {
  const lines = []
  const linePattern = /([^\r\n]*)(?:\r\n|\n|\r|$)/g
  let match = linePattern.exec(markdown)

  while (match?.[0]) {
    lines.push({ text: match[1], start: match.index, end: linePattern.lastIndex })
    match = linePattern.exec(markdown)
  }

  return lines
}

function h2Headings(markdown) {
  const headings = []
  let fence

  for (const line of markdownLines(markdown)) {
    if (fence) {
      const closingFence = line.text.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)
      if (closingFence && closingFence[1][0] === fence[0] && closingFence[1].length >= fence.length) {
        fence = undefined
      }
      continue
    }

    const openingFence = line.text.match(/^ {0,3}(`{3,}|~{3,})/)
    if (openingFence) {
      fence = openingFence[1]
      continue
    }

    if (/^ {0,3}##(?:[ \t]+|$)/.test(line.text)) {
      headings.push(line)
    }
  }

  return headings
}

function removeBlankSeparatorLines(markdown) {
  const contentLines = markdownLines(markdown).filter(line => /\S/.test(line.text))
  const firstLine = contentLines[0]
  const lastLine = contentLines.at(-1)
  return markdown.slice(firstLine.start, lastLine.start + lastLine.text.length)
}

const changelog = readFileSync('CHANGELOG.md', 'utf8')
const sectionHeading = new RegExp(
  `^## \\[${escapeRegExp(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`,
)
const headings = h2Headings(changelog)
const matches = headings.filter(heading => sectionHeading.test(heading.text))

if (matches.length === 0) {
  console.error(`CHANGELOG.md has no changelog section for ${version}.`)
  process.exit(1)
}

if (matches.length > 1) {
  console.error(`CHANGELOG.md contains ${version} more than once.`)
  process.exit(1)
}

const match = matches[0]
const nextHeading = headings[headings.indexOf(match) + 1]
const untrimmedNotes = changelog.slice(match.end, nextHeading?.start)

if (!/\S/.test(untrimmedNotes)) {
  console.error(`The ${version} changelog section has no notes.`)
  process.exit(1)
}

const notes = removeBlankSeparatorLines(untrimmedNotes)
writeFileSync(outputFile, `${notes}\n`)
