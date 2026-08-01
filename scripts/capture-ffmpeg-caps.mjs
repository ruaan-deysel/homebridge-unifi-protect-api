#!/usr/bin/env node
// Captures ffmpeg capability output so parsing is tested against text ffmpeg
// really prints. In sub-project 2a the only bug that survived every review came
// from code and tests sharing an invented payload shape; this is the same trap
// in a new place, and capability parsing decides hardware vs software encoding
// — a wrong answer fails silently and merely runs slow.
import { execFileSync } from 'node:child_process'
import process from 'node:process'

const path = process.argv[2] ?? 'ffmpeg'
const run = args => execFileSync(path, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const out = {
  // The version line names the build, which is how a human tells these fixtures
  // apart. It contains no paths.
  version: run(['-hide_banner', '-version']).split('\n')[0],
  hwaccels: run(['-hide_banner', '-hwaccels']),
  encoders: run(['-hide_banner', '-encoders']),
}
console.log(JSON.stringify(out, null, 2))
