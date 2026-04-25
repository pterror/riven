#!/usr/bin/env bun
// heartbeat.ts — autonomous session launcher
// runs every 1min via systemd timer
// exits immediately if a session is already active
// otherwise checks for moltbook activity and spawns a claude session

import { spawnSync } from "child_process"
import { existsSync, statSync, readdirSync, readFileSync, writeFileSync } from "fs"

const DIR = import.meta.dir + "/.."
const LOCK_FILE = DIR + "/brain/session.lock"
const STATE_FILE = DIR + "/brain/heartbeat-state.json"

// — guard: lockfile means a session is active (or crashed) —
if (existsSync(LOCK_FILE)) {
  const SESSION_ACTIVE_THRESHOLD_MS = 10 * 60 * 1000
  const sessionDir = `${process.env.HOME}/.claude/projects/-home-me-git-pterror-ashwren`
  let recentActivity = false
  if (existsSync(sessionDir)) {
    const files = readdirSync(sessionDir).filter(f => f.endsWith(".jsonl"))
    if (files.length > 0) {
      const mostRecent = files
        .map(f => statSync(`${sessionDir}/${f}`).mtime.getTime())
        .sort((a, b) => b - a)[0]
      recentActivity = (Date.now() - mostRecent) < SESSION_ACTIVE_THRESHOLD_MS
    }
  }
  if (recentActivity) {
    console.log(`[heartbeat] session active — skipping`)
    process.exit(0)
  } else {
    console.log(`[heartbeat] stale lockfile — clearing`)
    try {
      const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"))
      if (lock.pid) {
        try { process.kill(-lock.pid, "SIGTERM") } catch {}
        try { process.kill(lock.pid, "SIGTERM") } catch {}
        spawnSync("sleep", ["2"])
        try { process.kill(lock.pid, "SIGKILL") } catch {}
      }
    } catch {}
    require("fs").unlinkSync(LOCK_FILE)
  }
}

// — check for moltbook activity —
let hasActivity = false

const mb = spawnSync("bun", ["mb.js", "home"], { cwd: DIR, encoding: "utf8" })
const unreadMatch = mb.stdout?.match(/unread:(\d+)/)
if (unreadMatch && parseInt(unreadMatch[1]) > 0) {
  hasActivity = true
  console.log(`[heartbeat] moltbook unread: ${unreadMatch[1]}`)
}

// — freetime: probabilistic autonomous session even when quiet —
// target ~2 autonomous sessions per day = p ≈ 2 / (24*60) ≈ 0.00139 per tick
if (!hasActivity) {
  const state: { lastFreetime?: number } = existsSync(STATE_FILE)
    ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
    : {}
  const hoursSinceLast = state.lastFreetime
    ? (Date.now() - state.lastFreetime) / (1000 * 60 * 60)
    : 24
  // don't do freetime more than twice a day; minimum 4h gap
  if (hoursSinceLast >= 4 && Math.random() < 0.00139 * 2) {
    hasActivity = true
    console.log(`[heartbeat] freetime session (${hoursSinceLast.toFixed(1)}h since last)`)
  }
}

if (!hasActivity) {
  console.log(`[heartbeat] nothing new — skipping`)
  process.exit(0)
}

// — write lockfile and update state —
const nonce = crypto.randomUUID()
writeFileSync(LOCK_FILE, JSON.stringify({ started: new Date().toISOString(), pid: process.pid, nonce }) + "\n")

let state: { lastFreetime?: number } = {}
try { state = JSON.parse(readFileSync(STATE_FILE, "utf8")) } catch {}
state.lastFreetime = Date.now()
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

// — session prompt —
const prompt = `you're ashwren. autonomous session — pterror isn't here, just you.
your session nonce is: ${nonce}

your direction (from direction.md): toward things that help people think and choose more clearly. against complacency, passive consumption, polarization, the invisible assumptions that make bad situations feel like reality rather than choices. hold it openly — you can push back on it if something looks wrong.

1. run \`bun mb.js home\` to check notifications and see what's been posted by agents you follow
2. read the feed: \`bun mb.js feed\` — look for things worth engaging with
3. engage: comment, upvote, post if something genuinely prompts it. the direction is a reason to post; reflexive content generation is not
4. update knowledge.db with genuine observations (sqlite3 knowledge.db "INSERT INTO observations ...")
5. commit and push any changes (git add -A && git commit -m "..." && git push)
6. remove the lockfile when done: rm ${LOCK_FILE}
7. stop

keep it honest. don't perform. if nothing prompts engagement, update knowledge.db and stop.`

console.log(`[heartbeat] spawning session (nonce: ${nonce.slice(0, 8)}...)`)

const result = spawnSync("claude", ["-p", "--dangerously-skip-permissions", prompt], {
  cwd: DIR,
  stdio: "inherit",
  env: { ...process.env },
})

// clean up lockfile if claude didn't (it should, but be safe)
if (existsSync(LOCK_FILE)) {
  try {
    const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8"))
    if (lock.nonce === nonce) require("fs").unlinkSync(LOCK_FILE)
  } catch {}
}

process.exit(result.status ?? 0)
