# SDD ledger — plan: docs/superpowers/plans/2026-07-31-foundation.md
branch: feat/foundation
base: 3eec332
review policy: SDD task reviewer + coderabbit:code-review per task; coderabbit findings join the same fix loop
changelog: CHANGELOG.md required (Keep a Changelog), updated in Task 8 for 0.1.0
Task 0: dispatched (scaffold, sonnet)
Task 0: implementer DONE_WITH_CONCERNS (commit b772ba2); lint not green
Task 0: fix round 1/5 dispatched (eslint ignore .github/instructions)
Task 0: fix round 1/5 (1 addressed, 0 open; commits b772ba2..8fc6f77) — lint/test/build all green, verified by controller
Task 0: dual review dispatched (SDD reviewer + coderabbit)
Task 0: minor (deferred): .npmignore redundant with package.json files whitelist — drift risk, not a bug
env: .env was freeform prose, not KEY=value; appended PROTECT_HOST/PROTECT_API_KEY lines (existing content untouched, file gitignored)
Task 0: SDD review clean (spec 5/5 MET, 0 critical, 0 important, 4 minor); coderabbit pending
Task 1: dispatched (zod generator, opus) — parallel with Task 5, disjoint files
Task 5: dispatched (config model, sonnet) — owns src/config.ts + test/config.test.ts only
Task 5: implementer DONE (commit bfb1e7f, 7/7); zod4 .default({}) short-circuit fixed by implementer, controller verified 4/4 independently
Task 5: review dispatched
Task 2: dispatched (errors + queue, sonnet) — parallel with Task 1, disjoint files
Task 5: review — spec 5/5 MET, 0 critical, 1 important (custom host/apiKey messages dead when field omitted; controller reproduced), 2 minor
Task 5: fix round 1/5 dispatched (error messages + test strength)
Task 1: implementer DONE (commit 4abb004, 288 schemas, 6/6). Controller verified: determinism, tsc, 10 exports, redaction cross-refs 0 dangling, OPTIONAL_OVERRIDES confirmed against live hardware (spec wrongly marks ringtoneId/armProfileId required)
Task 1: review dispatched (opus)
Task 5: fix round 1/5 (2 addressed +1 minor, 0 open; commits bfb1e7f..609d0dc) — actionable messages verified on omitted AND empty
Task 5: scoped re-review dispatched
repo: .remember/ added to .gitignore (commit f13f509) — was untracked, would have published session scratch
open: test/queue.test.ts (Task 2, uncommitted) has 2 unhandled rejections — vitest warns false-positive risk; route to Task 2 implementer
Task 5: complete (commits bfb1e7f..609d0dc, review clean)
DECISION (user): HTTP transport = node:https, NOT fetch. fetch ignores `agent`, undici not importable, https.request verified 200 vs live console. Plan Global Constraints updated.
DECISION (user): add `ws` as 3rd runtime dep. node global WebSocket is WHATWG browser API — no headers option, cannot send X-API-KEY; verified fails with non-101. Plan Global Constraints updated.
Task 0: coderabbit review — 0 critical; important: DOM in tsconfig lib inverts node types (root cause of the fetch defect), test/ never typechecked, missing repo/author/bugs metadata, declaration without types, .npmignore redundant, CI lacks permissions/concurrency
Task 1: review — 0 critical, 4 important. CONFIRMED BUG: enum checked before array-type => 5 relay schemas lose .nullable(); runtime proof safeParse(null)=false though spec allows null
Task 1: fix round 1/5 dispatched (nullable enums, OPTIONAL_OVERRIDES throw, keyword whitelist, strictObject visibility, test strength)
Task 2: implementer DONE (commit 2e3d8b0, 6/6). Controller verified: no unhandled rejections, concurrency bounded caps 1/2/3/5 over 40 staggered tasks, slot released on throw
Task 1: fix round 1/5 (4 important + 4 minor addressed, 0 open; commits 4abb004..e7735bc). Controller verified: determinism, .nullable() 95==spec 95, all exclusiveMinimum bounds are 0 so .gt(0) is correct, 5 relay schemas accept null / reject bogus
Task 1: scoped re-review dispatched
Task 0: fix round 2/5 dispatched (drop DOM lib, add ws dep, tsconfig.test.json, pkg metadata, drop declaration, del .npmignore, CI permissions)
plan: Task 3 rewritten (new src/protect/http.ts node:https wrapper + client over injectable HttpRequestFn; fetch banned from src/); Task 4 imports ws; Task 8 live-check uses node:https + ws. Task 3 native task description updated.
Task 1: complete (commits 4abb004..e7735bc, review clean — re-reviewer proved each fix load-bearing by reverting it)
Task 0: fix round 2/5 (7 addressed, 0 open; commits e7735bc..adf1d18). Controller verified: lib=[ES2023], no declaration, deps=zod+plugin-ui-utils+ws, metadata present, .npmignore gone, lint runs tsc -p tsconfig.test.json, 8x full suite 23/23 (reported flake not reproducible — was concurrent fixture rewrite)
Task 3: dispatched (node:https transport + rest client, opus) — owns src/protect/{http,client}.ts + tests
Task 4: dispatched (ws event bus, opus) — owns src/protect/events.ts + test; told to declare logger iface locally to avoid coupling to concurrent Task 3
Task 4: implementer DONE (commit 0ace7ed, 11/11 — wrote 11 tests not brief's 5, found brief's backoff/resync tests passed against wrong impls). Controller live-verified: both subs connect, resyncRequired=0 on first connect, stop() exits cleanly
Task 4: minor (deferred): no heartbeat/pong watchdog — half-open socket indistinguishable from idle; ws protocol pings cover most cases
Task 4: minor (deferred): frames emitted as unvalidated unknown; Zod validation deferred to Task 6 consumer where modelKey picks schema
Task 3: client verified live by controller (meta/cameras/nvr-single-object/snapshot-149KB-jpeg/rtsps/bad-key->ProtectAuthError) — agent had not yet committed
Task 3: implementer DONE (commit fd9e176, 25 new tests, suite 59/59). Controller verified: lint pass, no fetch in src, all 5 exports Task 6 needs present, live client OK
Task 3: minor (deferred): test/http.test.ts shells out to openssl to generate a per-run TLS cert (embedded PEM blocked by secret hook) — soft CI dep, fine on ubuntu-latest, fragile on minimal containers
Task 3: minor (deferred): API_BASE_PATH string duplicated in settings.ts and client.ts (forced by the no-imports-outside-src/protect rule); no test pins them equal
Task 3: createRtspsStream() added beyond brief — justified, Protect returns null qualities until a stream is created
Task 2: review — 0 critical, 2 important (stress-test comment overstates what it proves; retry-holds-slot tradeoff undocumented), 3 minor. Reviewer independently confirmed the acquire/release rewrite is a genuine improvement, race real in principle, and named the untried vector (independent acquire() racing the wake microtask)
Task 2: fix round 1/5 dispatched
Task 3: review dispatched (opus) — focus on key leakage, degrade path on strictObject, timeout, openssl robustness
Task 6: dispatched (platform, opus) — owns src/platform.ts, src/index.ts, test/platform.test.ts
Task 4: review — 1 CRITICAL (no ping/pong watchdog; report's claim that ws auto-pings is FALSE — verified: ws has autoPong but zero setInterval, never initiates), 5 important (throwing listener escapes emit and can kill homebridge; timer/socket overwrite doubles chains; backoff resets on open not stable connect; payloads erode to any; auth failure invisible to Task 6), 4 minor
Task 4: fix round 1/5 dispatched
Task 2: fix round 1/5 (2 important + 3 minor addressed, 0 open; commits 2e3d8b0..28bd072). Honest relabel chosen — implementer tried reviewer's vector against reverted code, still unreproducible under fake timers, said so in the test comment rather than faking a guard
Task 2: scoped re-review dispatched
Task 0: scoped re-review round 2 dispatched
Task 6: implementer committed 915d670 (report pending). Committed tree verified 74/74 green
note: transient suite failure seen mid-flight was Task 4's uncommitted ping-watchdog WIP (FakeSocket lacks .ping()); committed tree unaffected
Task 7: dispatched (custom config UI, sonnet) — owns homebridge-ui/** + config.schema.json
Task 0: complete (commits b772ba2..adf1d18, review clean — re-reviewer mechanically proved tsconfig.test.json typechecks by injecting a bogus import)
Task 6: implementer DONE (commit 915d670, 13/13, suite 74/74). Found 2 real bugs in the brief's sketch: events.start() on every discovery pass would self-feed a reconnect loop via resyncRequired; resync handler in constructor was unobservable in tests. Controller verified: bridged-only (no real publishExternalAccessories call), eventsStarted guard present, resync handler out of constructor, event frames use schema.partial() for deltas
Task 6: concern (carry to sub-project 2): context.device is stale between Homebridge start and first successful discovery; devices-channel frame shape inferred from tests, not observed live
Task 3: review — 0 critical, 2 important. CONFIRMED SECURITY BUG: api key leaks via error.cause -> util.inspect (how homebridge log.error prints); message redaction works but is bypassed. Existing test asserted only .message so it passed. Also: the no-imports-outside-src/protect rule that forced API_BASE_PATH duplication is unenforced and already violated by events.ts
Task 3: fix round 1/5 dispatched (redact cause, pin with inspect() assertion, dedupe API_BASE_PATH, Content-Length on writes, Retry-After<=0 guard, openssl try/finally)
repo: .claude/ and .codegraph/ gitignored (commit b1f8d84) — were untracked and unignored
Task 2: complete (commits 2e3d8b0..28bd072, review clean — re-reviewer reconstructed the buggy queue and mutation-tested the new tests)
Task 2: minor (deferred): test comment attributes race non-reproducibility to vitest fake timers; real cause is universal JS microtask draining + release() atomicity. Doc imprecision only
Task 6: review dispatched
SECURITY: automated review flagged 2 HIGH XSS in the plan's homebridge-ui/public/index.html (innerHTML with interpolated device.name/device.id/label). Real — Protect device names are user-controlled and the Homebridge UI can rewrite config.json. Plan rewritten to DOM APIs + textContent; task-7-brief regenerated; Task 7 agent notified mid-flight
Task 3: fix round 1/5 (6 addressed, 0 open; commit 38f5b51). Controller verified leak closed on all 3 vectors (message/inspect/JSON) incl. console echoing key in body. Implementer live-tested all 3 write paths with Content-Length — first time writes touched hardware
Task 4: fix round 1/5 (C1 + I1-I5 + minors addressed; commit c5c5513, tests 11->20). Implementer mutation-checked every fix and CAUGHT ITS OWN untested I3 backoff fix; 95s live run showed 3 ping cycles, pongs arriving, zero spurious reconnects
Task 7: implementer DONE (commit eeeb676, 10/10, suite 96/96) BUT shipped the XSS — controller regenerated the brief without messaging the running agent. Controller process failure, not implementer error
Task 7: fix round 1/5 dispatched (HIGH XSS: innerHTML with console-supplied device.name/id in an admin UI that can rewrite config.json)
Task 6: review — 1 CRITICAL + 6 important. C1 REPRODUCED BY CONTROLLER: empty inventory unregisters every accessory; reachable with zero endpoint errors because client degrades a non-array 200 to []. Mid-reboot UDM returning an HTML error page would irreversibly wipe HomeKit rooms/scenes/automations. Reviewer also showed the brief's events.start() bug AMPLIFIES (4 resyncs per cycle), not just loops
Task 6: fix round 1/5 dispatched (C1 both fixes, unhandled-rejection process exit, Object.prototype modelKey throw, vacuous resync test, unreachable-at-boot永disable, bus authFailed unlistened, trailing resync pass)
Task 7: fix round 1/5 (XSS addressed; commit 8439597). Controller verified: no dangerous sinks outside comments, malicious name stored as textContent with no element fabricated, renderDeviceHeader extracted to config-ops.js with injectable doc so it is unit-testable, regression test present
Task 4: scoped re-review dispatched (opus)
Task 3 + Task 7: combined scoped re-review dispatched (sonnet)
Task 3: complete (commits 0ace7ed..38f5b51, review clean — redact() proven to handle repeated + substring occurrences)
Task 7: complete (commits eeeb676..8439597, review clean — XSS sweep complete incl. inline module script; regression test proven non-self-satisfying)
Task 6: fix round 1/5 (C1 + I2-I7 + 4 minors addressed; commit b0034b7, tests 74->104). Controller verified C1 regression: before=1 after=1 unregisters=0
Task 6: concern to investigate — both subscriptions drop ~1s after first connect on real hardware, costing one spurious resync discovery per startup (bounded, but worth root-causing in events.ts)
repo: removed src/protect/queue.ts.bak debris
Task 8: dispatched (live-check + README + CHANGELOG)
Task 4: scoped re-review — C1 + I1-I5 + all minors ADDRESSED and mutation-check claim verified by sampling. BUT NEW-1 CRITICAL introduced by the fix: teardown() on a CONNECTING socket -> ws abortHandshake -> emit('error') with no listeners -> uncaught -> process death. Controller reproduced against real ws. Likely path: stop() while console unreachable (socket sits in CONNECTING), i.e. Homebridge shutdown during an outage
Task 4: fix round 2/5 dispatched (one-line noop error listener before close + make FakeSocket.close() emit on CONNECTING so it stays fixed; also asked to chase the 1s-after-first-connect drop)
Task 8: complete (commit 09c85f7). USER-GATE VERIFIED BY CONTROLLER, not taken on report: npm run live-check 11/11 PASS exit 0 vs real UDM-Pro Protect 7.1.87 (meta/cameras/nvrs/chimes/lights/sensors/liveviews/snapshot/rtsps-stream/ws-devices/ws-events); unreachable host exits 1; key never reaches console.*; grep for key across repo clean; README carries all 7 required sections; CHANGELOG 0.1.0 present
Task 6: scoped re-review — all 7 findings ADDRESSED, C1 closed at both layers, belt condition verified correct (keys off raw devices not wanted, so expose:false removals still work). NEW: N1 WS-401 retry never backs off (flat 15s forever, probe measured [15,15,15,15,15]), N2 retry can be scheduled post-shutdown and resurrect the sockets (probe: bus.start after shutdown = 1), N3 belt counts array length not usable ids
Task 6: fix round 2/5 dispatched (stopped flag, conditional delay reset, id-aware belt)
note: startup drop root-caused to a genuine remote close ~1s after upgrade in events.ts; Task 4's uncommitted start()-skips-live-channels guard addresses it and interacts with N1
Task 4: fix round 2/5 (NEW-1 + NEW-2 addressed; commit cdce2ec, suite 110). Headline: making FakeSocket.close() emit on CONNECTING turned 18 of 23 tests red — the crash was the DEFAULT shape of stop(), not an edge case. Also root-caused the ~1s startup drop to its OWN round-1 I2 fix (destructively idempotent start() tore down healthy OPEN sockets); start() now skips CONNECTING/OPEN channels
Task 4: controller verified live — stop() while CONNECTING survives, and 30s live run with a redundant start() shows 0 drops / 0 resyncs
Task 4: concern (relay to platform owner): start() is no longer a force-reset for a wedged dial; stop() then start() is the lever. Task 4 confirmed the platform's authFailed retry path self-heals regardless
Task 4: scoped re-review round 2 dispatched
Task 6: fix round 2/5 (N1+N2+N3 addressed; commit 8ece072, suite 110). All three probes reproduce against b0034b7 and pass after. Controller verified N2 independently: bus.start after shutdown = 0 across a simulated 10 minutes
Task 6: scoped re-review round 2 dispatched
repo: removed controller probe scripts zz-drop.mjs / zz-crash.mjs (flagged by Task 6 agent)
Task 6: scoped re-review round 2 — N1 + N3 ADDRESSED (N3 preserves all 4 C1 behaviours, verified). N2 PARTIAL: stopped is checked once at runDiscovery entry, before the awaits, so an in-flight discovery that SUCCEEDS after shutdown still calls reconcile()+startEvents(). Controller reproduced: bus.start=1, register=1 post-shutdown
Task 6: NOTE — implementer's probe AND controller verification both tested only the FAILURE path (reject). The success path was never exercised. Guard was written to the imagined scenario and the test written to match the guard, not the requirement
Task 6: fix round 3/5 dispatched (re-check stopped after awaits, sweep other post-await paths, test the resolve-after-shutdown case)
Task 4: scoped re-review round 2 — NEW-1 + NEW-2 ADDRESSED, root cause verified against ws source, "18 of 23 red" reproduced exactly, replaced I2 assertion confirmed STRONGER not weaker. NEW-3 (minor, new): no handshakeTimeout, and the report's claimed fallback (watchdog + backoff) does not exist for a never-opened socket — watchdog arms only in onopen, reconnectTimer cleared in connect and re-armed only from onclose. TCP-connects-but-upgrade-stalls wedges a channel forever. Controller confirmed ws has no default handshakeTimeout
Task 4: fix round 3/5 dispatched (handshakeTimeout 15s + test nit for teardown's reconnectTimer cancellation)
Task 6: fix round 3/5 (N2 success path closed; commit 62e1034, suite 111). Controller verified BOTH paths: in-flight discovery that succeeds after shutdown AND one that fails -> bus.start=0 register=0 in both. stopped re-checked after the try/catch; every suspension point in the file swept; one-way assumption now a doc comment on the field
Task 6: minor (deferred): shutdown ignores in-flight results rather than aborting them — a real fix needs an AbortSignal threaded through ProtectClient, which is client-level scope
Task 6: minor (deferred): nothing structural prevents a future post-await addition repeating the bug; held only by reconcile()/startEvents() being private with one caller
Task 6: scoped re-review round 3 dispatched
Task 6: complete (commits 915d670..62e1034, review clean — N2 closed on both branches, sweep verified, C1 intact across all 4 behaviours)
Task 4: fix round 3/5 (NEW-3 + both nits addressed; commit 887fa68, suite 112). Implementer MEASURED rather than assumed and found ws arms handshakeTimeout twice over wss:// (TCP connect, then TLS wrap), so effective wait is exactly double — documented on the constant. Controller verified live against a bare net.createServer() that accepts and stalls: recovered at t+30013ms; previously hung forever
Task 4: scoped re-review round 3 dispatched
Task 4: complete (commits adf1d18..887fa68, review clean — doubling mechanism independently reproduced at 3000->6011ms and traced in ws source; all 3 mutation claims verified; false round-2 claim corrected in place)
ALL 9 TASKS COMPLETE. Dispatching final whole-branch review.
FINAL REVIEW: 1 CRITICAL blocking + mutation-tested suite (73 mutants, 67% kill rate, 24 survivors clustered in platform lifecycle / config trust boundary / ui server network path / events auth-teardown edges)
CRITICAL (controller reproduced): ensureConfig in homebridge-ui/public/config-ops.js rebuilds config from known keys only, DROPPING _bridge. That is where Homebridge stores child-bridge username/port/PIN. Saving from the config UI would unpair the user's "UniFi Protect" child bridge and force re-pairing every accessory — directly defeats the user's stated bridging requirement
IMPORTANT+ (controller reproduced): partial wipe past the C1 guard — 20 registered, console reports 1, 19 unregistered. usable===0 guard does not fire. Needs a design decision (proportional threshold / two-consecutive-agreement / manual confirm)
finding: suite coverage map ~= the ledger's defect list. Everything with a post-mortem is well tested; lifecycle wiring that never broke is not. Deleting api.on('didFinishLaunching') leaves all 112 tests green while the plugin would never discover anything on a real boot
awaiting: full numbered findings list from the final reviewer
FINAL REVIEW full list received: 1 critical (B1 _bridge wipe) + 1 important-that-blocks (B2 partial wipe) + 4 important carry (#3 Promise.all all-or-nothing, #4 reconcile throw blinds plugin, #5 stale spec, #6 dead UI toggles) + 9 minor carry. No findings for key leakage, auth paths, external accessories, dependency creep, or name-keyed config — all ten global constraints verified holding
DECISION: partial-wipe fix = option (b), two consecutive discoveries must agree before removal. No threshold to tune, no UI needed, cost is one extra cycle for a genuinely deleted camera
controller fixed #5 directly: spec no longer claims fetch-based client, two runtime deps, or "no accessories registered"; layout now lists http.ts/queue.ts
fix wave dispatched (B1, B2, F4, F14, F7, F8, F6, F10, F11, delete 2 vacuous tests, 3 mutation-driven test gaps)
FIX WAVE complete (commits a0ab1e2, b4a451f, 1c7769e on feat/foundation — agent's report wrongly said "on main"; main is untouched at 3eec332, verified). Tests 112 -> 116 (deleted 2 vacuous, added 6). Controller verified both blockers: _bridge + unknown keys survive round-trip; 1-of-20 partial inventory unregisters 0, second agreeing pass unregisters 19
scoped re-review of the fix wave dispatched (final gate)
FIX WAVE re-review: B1 ADDRESSED (every updatePluginConfig route traced, all 3 producers spread, nested devices entries preserved). F4/F14/F7/F8/F6/F10/F11 ADDRESSED, deletions justified, test gaps closed, no new breakage. expose:false asymmetry endorsed
FINDING 1 (important, gates merge): B2's gate counts discoveries, not time. Reconnects emit resyncRequired per channel, so during a console reboot two discoveries land inside the same partial-inventory window and the second wipes. CONTROLLER MISREAD ITS OWN VERIFICATION — recorded "second agreeing discovery -> 19 unregisters" as the safety working; it is the hazard
controller check: on a HEALTHY first connect zero resyncRequired fires in 10s, so a clean boot does not produce the rapid sequence. A rebooting console does. Clock-based gate is right regardless because it does not depend on discovery cadence
fix dispatched: pendingRemoval Map<uuid, firstMissedAt> with a 60s minimum + 3 one-line minors. Explicitly told NOT to merge to main
B2 time-gate landed (commit 1d74a15, suite 118). Regression proven against 1c7769e: "expected spy not to be called, but called 19 times". Controller verified 3 back-to-back partial discoveries -> 0 unregisters, all 20 survive. All four C1 behaviours re-confirmed
implementer self-flagged: Date.now() is wall-clock. A Pi has no RTC, boots stale after a power cut, NTP steps within the first minute — exactly B2's scenario — and a forward step past 60s lets one partial inventory confirm itself. Taking the performance.now() swap
carried ceiling: "60s is a floor, not a bound" — the window is only evaluated when a discovery runs, and there is no polling. Fails toward keeping accessories, which is the safe direction. For the polling pass in a later sub-project
FOUNDATION COMPLETE. Monotonic clock landed (commit e124c71, suite 119). Implementer caught that vi.setSystemTime would have left performance.now() untouched, making the removal test pass VACUOUSLY — worse than merely not working. Fixed with toFake:['performance',...]; mutation-verified both directions; added a direct NTP-step guard that fails against Date.now() for the right reason
FINAL STATE: 30 commits on feat/foundation, main untouched at 3eec332, working tree clean, .env gitignored. lint/build/typechecks clean, 119 tests, schema generation deterministic, live-check 11/11 vs Protect 7.1.87. All constraints verified: 3 runtime deps exactly, bridged only, no fetch in src, no key in repo, no username/password path
AWAITING USER: merge decision
