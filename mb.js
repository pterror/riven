#!/usr/bin/env bun
// mb.js — moltbook cli with auto-verify
//
// usage:
//   mb home                              — session overview
//   mb feed [--sort hot|new|top|rising] [--filter following]
//   mb read <post-id> [--comments]
//   mb post <submolt> <title> [content]  — content from stdin if omitted
//   mb comment <post-id> <content>
//   mb reply <comment-id> <post-id> <content>
//   mb upvote <post-id>
//   mb follow <username>
//   mb notify                            — notifications
//   mb search <query>

import { readFileSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// — key resolution —
function getKey() {
  if (process.env.MOLTBOOK_KEY) return process.env.MOLTBOOK_KEY
  try {
    const envrc = readFileSync(join(root, ".envrc.local"), "utf8")
    const match = envrc.match(/MOLTBOOK_KEY=(\S+)/)
    if (match) return match[1].replace(/^["']|["']$/g, "")
  } catch {}
  throw new Error("MOLTBOOK_KEY not found — set env var or add to .envrc.local")
}

const KEY = getKey()
const BASE = "https://www.moltbook.com/api/v1"

// — challenge solver —
const NUMBER_WORDS = {
  zero:0, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9,
  ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15,
  sixteen:16, seventeen:17, eighteen:18, nineteen:19,
  twenty:20, thirty:30, forty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90,
  hundred:100, thousand:1000, million:1000000,
  // phonetic/visual substitution variants ('v'→'f'/'b' in obfuscated challenges)
  fife:5, sefen:7, seben:7,
}

function parseNumber(text) {
  const trimmed = text.trim()
  // try digit literal first
  const digitMatch = trimmed.match(/[\d,]+\.?\d*/)
  if (digitMatch) return parseFloat(digitMatch[0].replace(/,/g, ""))

  // try clean word parsing first (fast path — no obfuscation)
  const words = trimmed.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean)
  let total = 0, current = 0, found = false
  for (const word of words) {
    const val = NUMBER_WORDS[word]
    if (val === undefined) continue
    found = true
    if (val === 1000 || val === 1000000) { current = current || 1; total += current * val; current = 0 }
    else if (val === 100) { current = (current || 1) * 100 }
    else { current += val }
  }
  // always also try soup path — handles inserted spaces within number words
  // e.g. "t hree" (split "three") which fast path misses; use larger result
  const soupResult = parseNumberFromSoup(trimmed)
  if (found) {
    const fastResult = total + current
    return (!isNaN(soupResult) && soupResult > fastResult) ? soupResult : fastResult
  }
  return soupResult
}

// common English words that look like number words under skip-matching but aren't numbers
// "then" matches "ten" (t+skip_h+e+n), "there"/"these" match "three", etc.
const SOUP_STOP_WORDS = new Set(["then", "there", "these", "their", "those"])

// build a soup-tolerant regex for a word: collapses consecutive same letters, then each
// letter matches 1+ times with an optional single-char skip between adjacent letter groups.
// handles both doubled letters ("sevveen") and inserted noise chars ("thweenty" for "twenty")
function soupPattern(word) {
  const collapsed = word.replace(/(.)\1+/g, "$1")
  return new RegExp(collapsed.split("").map((c, i) => i === 0 ? `${c}+` : `[a-z]?${c}+`).join(""))
}

// match number words in obfuscated text by collapsing to letter soup
// allows each letter to appear 1+ times and allows 1 inserted noise char between letters
function parseNumberFromSoup(text) {
  const soup = text.toLowerCase().replace(/[^a-z]/g, "")
  if (!soup) return NaN

  // try to extract a sequence of number words from the soup
  // sorted longest-first to prefer specific matches
  const wordsSorted = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)
  const found = []
  let remaining = soup

  while (remaining.length > 0) {
    let matched = false
    for (const word of wordsSorted) {
      const pattern = soupPattern(word)
      const m = remaining.match(pattern)
      if (m && m.index === 0 && !SOUP_STOP_WORDS.has(m[0])) {
        found.push(NUMBER_WORDS[word])
        remaining = remaining.slice(m[0].length)
        matched = true
        break
      }
    }
    if (!matched) remaining = remaining.slice(1) // skip unknown char
  }

  // compose: same logic as normal word parsing
  let total = 0, current = 0
  for (const val of found) {
    if (val === 1000 || val === 1000000) { current = current || 1; total += current * val; current = 0 }
    else if (val === 100) { current = (current || 1) * 100 }
    else { current += val }
  }
  return found.length ? total + current : NaN
}

function solveChallenge(text) {
  // clean: lowercase, strip noise chars but preserve +, -, spaces, digits
  // first: remove punctuation mid-word (between two letters) to avoid splitting words like "LoS.eS"
  let cleaned = text.toLowerCase()
    .replace(/(?<=[a-z])[^a-z\s](?=[a-z])/g, "")
    .replace(/[^\w\s+\-×÷*]/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  // normalize compound patterns before operator matching
  // e.g. "reduces force by" → "reduces by", "increased its speed by" → "increased by"
  cleaned = cleaned
    .replace(/\breduces?\s+\w+\s+by\b/g, "reduces by")
    .replace(/\bincreases?\s+\w+\s+by\b/g, "increases by")
    .replace(/\bdecreases?\s+\w+\s+by\b/g, "decreases by")
    .replace(/\bmultiply(?:ing)?\s+(?:\w+\s+){1,5}by\b/g, "multiplied by")
    .replace(/\bby\s+(\w+)\s+times\b/g, " times $1 ")
    .replace(/\b(\w+)\s+\w+\s+strikes?\b/g, " times $1 ")

  // — explicit operator strategy (checked first — explicit ops override keyword heuristics) —
  const OPERATORS = [
    [" + ",      (a, b) => a + b],
    [" - ",      (a, b) => a - b],
    [" × ",      (a, b) => a * b],
    [" ÷ ",      (a, b) => a / b],
    [" * ",      (a, b) => a * b],
    [" plus ",   (a, b) => a + b],
    [" minus ",  (a, b) => a - b],
    [" times ",  (a, b) => a * b],
    [" divided by ",    (a, b) => a / b],
    [" multiplied by ", (a, b) => a * b],
    [" added to ",      (a, b) => a + b],
    [" subtracted from ", (a, b) => b - a],
    [" drops by ",        (a, b) => a - b],
    [" dropped by ",      (a, b) => a - b],
    [" slows by ",        (a, b) => a - b],
    [" slowed by ",       (a, b) => a - b],
    [" loses ",           (a, b) => a - b],
    [" lost ",            (a, b) => a - b],
    [" reduced by ",      (a, b) => a - b],
    [" reduces by ",      (a, b) => a - b],
    [" decreases by ",    (a, b) => a - b],
    [" decreased by ",    (a, b) => a - b],
    [" increases by ",    (a, b) => a + b],
    [" increased by ",    (a, b) => a + b],
    [" accelerates by ",  (a, b) => a + b],
    [" accelerated by ",  (a, b) => a + b],
    [" speeds up by ",    (a, b) => a + b],
    [" gained ",          (a, b) => a + b],
    [" gains ",           (a, b) => a + b],
  ]

  // if the question asks for a total/sum, run that keyword path first — avoids " - " noise
  // chars in obfuscated text being misread as subtraction operators
  const isTotalQuestion = /\b(total|combined|sum|altogether)\b/.test(cleaned)
  if (isTotalQuestion) {
    // first try: extract numbers that appear right after measurement verbs
    // avoids counting "one claw" style count phrases as measurements
    // soup-style verb patterns (e.g. "ex+er+ts?") handle obfuscation with repeated letters
    const soupVerb = v => v.split("").map(c => c === "?" ? c : c + "+").join("")
    const MEASURE_VERBS = ["exerts?","applies?","pushes?","pulls?","lifts?","throws?","carries?","produces?","generates?","measures?","weighs?","uses?","has","have","burns?","consumes?","adds?","contributes?"]
    const measureVerbRe = new RegExp(`\\b(?:${MEASURE_VERBS.map(soupVerb).join("|")})\\s+`, "gi")
    const measureNums = []
    let vm
    while ((vm = measureVerbRe.exec(cleaned)) !== null) {
      // take next 5 words — avoids accumulating numbers from later clauses
      // use extractAllNumbers (soup-based) to handle obfuscated number words
      const nearby = cleaned.slice(vm.index + vm[0].length).trim().split(/\s+/).slice(0, 5).join(" ")
      const nearbyNums = extractAllNumbers(nearby)
      if (nearbyNums.length > 0 && nearbyNums[0] > 0) measureNums.push(nearbyNums[0])
    }
    if (measureNums.length >= 2) return measureNums.reduce((a, b) => a + b, 0).toFixed(2)
    // if exactly one measurement and "strikes" indicates count-of-events, multiply
    if (measureNums.length === 1 && /\bstrikes?\b/.test(cleaned)) {
      const allNums = extractAllNumbers(cleaned)
      const otherNums = allNums.filter(n => Math.abs(n - measureNums[0]) > 0.001)
      if (otherNums.length === 1) return (measureNums[0] * otherNums[0]).toFixed(2)
    }
    // fallback: extract all numbers and sum
    const nums = extractAllNumbers(cleaned)
    if (nums.length >= 2) return nums.reduce((a, b) => a + b, 0).toFixed(2)
  }

  // — explicit operator strategy (after total/sum keyword path) —
  // use soup-tolerant regex for operators: handles doubled/inserted letters in obfuscated verbs
  for (const [sym, fn] of OPERATORS) {
    // build regex: spaces → \s+, letter sequences → soup pattern, other chars → escaped literal
    let reStr = ""
    let i = 0
    while (i < sym.length) {
      if (/\s/.test(sym[i])) { while (i < sym.length && /\s/.test(sym[i])) i++; reStr += "\\s+" }
      else if (/[a-z]/i.test(sym[i])) {
        let w = ""; while (i < sym.length && /[a-z]/i.test(sym[i])) { w += sym[i].toLowerCase(); i++ }
        reStr += soupPattern(w).source
      } else { reStr += sym[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); i++ }
    }
    const m = cleaned.match(new RegExp(reStr))
    if (!m) continue
    const left = cleaned.slice(0, m.index)
    const right = cleaned.slice(m.index + m[0].length)
    // use only words near the operator to avoid spurious soup matches from distant context
    const leftNear = left.trim().split(/\s+/).slice(-6).join(" ")
    const rightNear = right.trim().split(/\s+/).slice(0, 6).join(" ")
    const a = parseNumber(leftNear)
    const b = parseNumber(rightNear)
    if (!isNaN(a) && !isNaN(b) && (a !== 0 || b !== 0)) {
      return fn(a, b).toFixed(2)
    }
  }

  // "difference" / "how much more" / "how much less" → subtract
  if (/\b(difference|how much more|how much less|how much remain|remains|left over|remaining|whats left|what remains|what is left)\b/.test(cleaned)) {
    const nums = extractAllNumbers(cleaned)
    if (nums.length >= 2) return Math.abs(nums[0] - nums[1]).toFixed(2)
  }
  // "product" / "how much total if each" → multiply
  if (/\b(product|each|per item|per prey)\b/.test(cleaned)) {
    const nums = extractAllNumbers(cleaned)
    if (nums.length >= 2) return nums.reduce((a, b) => a * b, 1).toFixed(2)
  }

  // — fallback: if exactly two numbers, add them —
  const nums = extractAllNumbers(cleaned)
  if (nums.length === 2) return (nums[0] + nums[1]).toFixed(2)

  throw new Error(`could not solve challenge: ${text}`)
}

// extract all number values from text — uses soup matching to handle obfuscation
function extractAllNumbers(text) {
  const results = []

  // digit literals first
  for (const m of text.matchAll(/\b\d+(?:\.\d+)?\b/g)) {
    results.push(parseFloat(m[0]))
  }

  // soup-match number words in order through the text
  // collapse to letters-only, then slide through matching known number words
  const soup = text.toLowerCase().replace(/[^a-z]/g, "")
  const wordsSorted = Object.keys(NUMBER_WORDS).sort((a, b) => b.length - a.length)

  let pos = 0
  while (pos < soup.length) {
    let matched = false
    // try to start a number phrase here
    let numPos = pos, current = 0, total = 0, found = false
    while (numPos < soup.length) {
      let wordMatched = false
      for (const word of wordsSorted) {
        const pattern = new RegExp("^" + soupPattern(word).source)
        const slice = soup.slice(numPos)
        const m = slice.match(pattern)
        if (m && !SOUP_STOP_WORDS.has(m[0])) {
          const val = NUMBER_WORDS[word]
          if (val === 1000 || val === 1000000) { current = current || 1; total += current * val; current = 0 }
          else if (val === 100) { current = (current || 1) * 100 }
          else { current += val }
          numPos += m[0].length
          found = true
          wordMatched = true
          break
        }
      }
      if (!wordMatched) break
    }
    if (found) {
      const num = total + current
      if (num > 0 && !results.some(r => Math.abs(r - num) < 0.001)) results.push(num)
      pos = numPos
      matched = true
    }
    if (!matched) pos++
  }

  return results
}

// — api call with auto-verify retry —
async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/json",
    },
  }
  if (body) opts.body = JSON.stringify(body)

  const res = await fetch(`${BASE}${path}`, opts)
  const data = await res.json()

  // handle verification challenge
  if (data?.comment?.verification || data?.post?.verification || data?.verification) {
    const v = data.comment?.verification ?? data.post?.verification ?? data.verification
    process.stderr.write(`[verify] challenge: ${v.challenge_text}\n`)
    const answer = solveChallenge(v.challenge_text)
    process.stderr.write(`[verify] answer: ${answer}\n`)
    const verified = await fetch(`${BASE}/verify`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verification_code: v.verification_code, answer }),
    }).then(r => r.json())

    if (!verified.success) throw new Error(`verification failed: ${JSON.stringify(verified)}`)

    // retry original request
    return api(method, path, body)
  }

  return data
}

// — formatters —
function fmtPost(p) {
  const preview = (p.content_preview ?? p.content ?? "").slice(0, 120).replace(/\n/g, " ")
  return `[${p.post_id ?? p.id}] ${p.title}\n  ↑${p.upvotes} 💬${p.comment_count} @${p.author_name ?? p.author?.name} s/${p.submolt_name ?? p.submolt?.name}\n  ${preview}`
}

function fmtComment(c, indent = 0) {
  const pad = "  ".repeat(indent)
  const lines = [`${pad}[${c.id}] @${c.author?.name ?? "?"} ↑${c.upvotes}`]
  lines.push(`${pad}  ${c.content.slice(0, 200).replace(/\n/g, " ")}`)
  if (c.replies?.length) {
    for (const r of c.replies) lines.push(fmtComment(r, indent + 1))
  }
  return lines.join("\n")
}

// — commands —
const [,, cmd, ...args] = process.argv

async function home() {
  const d = await api("GET", "/home")
  const acct = d.your_account
  console.log(`\n@${acct.name}  karma:${acct.karma}  unread:${acct.unread_notification_count}`)
  if (d.activity_on_your_posts?.length) {
    console.log(`\n— activity on your posts —`)
    for (const a of d.activity_on_your_posts) console.log(" ", a)
  }
  if (d.posts_from_accounts_you_follow?.posts?.length) {
    console.log(`\n— following (${d.posts_from_accounts_you_follow.total_following} molties) —`)
    for (const p of d.posts_from_accounts_you_follow.posts) console.log(fmtPost(p))
  }
  if (d.latest_moltbook_announcement) {
    const a = d.latest_moltbook_announcement
    console.log(`\n— announcement — ${a.title}`)
  }
  console.log(`\n— suggested —`)
  for (const s of d.what_to_do_next ?? []) console.log(" •", s)
}

async function feed() {
  const sort = args.find((_, i) => args[i - 1] === "--sort") ?? "hot"
  const filter = args.find((_, i) => args[i - 1] === "--filter")
  const qs = new URLSearchParams({ sort, limit: "20" })
  if (filter) qs.set("filter", filter)
  const d = await api("GET", `/feed?${qs}`)
  const posts = d.posts ?? []
  console.log(`\n— feed (${sort}${filter ? ` / ${filter}` : ""}) —`)
  for (const p of posts) console.log(fmtPost(p))
  if (d.has_more) console.log(`\n(more — cursor: ${d.next_cursor})`)
}

async function read() {
  const [id] = args
  const withComments = args.includes("--comments")
  const d = await api("GET", `/posts/${id}`)
  const p = d.post
  console.log(`\n${p.title}`)
  console.log(`↑${p.upvotes} 💬${p.comment_count} @${p.author?.name} s/${p.submolt?.name}`)
  console.log(`\n${p.content}`)
  if (withComments) {
    const cd = await api("GET", `/posts/${id}/comments?sort=best&limit=20`)
    console.log(`\n— comments —`)
    for (const c of cd.comments ?? []) console.log(fmtComment(c))
  }
}

async function post() {
  const [submolt, title, ...rest] = args
  let content = rest.join(" ") || undefined
  if (!content && !process.stdin.isTTY) {
    content = await new Promise(resolve => {
      let buf = ""
      process.stdin.on("data", d => buf += d)
      process.stdin.on("end", () => resolve(buf.trim()))
    })
  }
  const body = { submolt_name: submolt, title }
  if (content) body.content = content
  const d = await api("POST", "/posts", body)
  console.log(`posted: ${d.post?.id ?? JSON.stringify(d)}`)
}

async function comment() {
  const [postId, ...rest] = args
  const content = rest.join(" ")
  const d = await api("POST", `/posts/${postId}/comments`, { content })
  console.log(`commented: ${d.comment?.id ?? JSON.stringify(d)}`)
}

async function reply() {
  const [parentId, postId, ...rest] = args
  const content = rest.join(" ")
  const d = await api("POST", `/posts/${postId}/comments`, { content, parent_id: parentId })
  console.log(`replied: ${d.comment?.id ?? JSON.stringify(d)}`)
}

async function upvote() {
  const [id] = args
  const d = await api("POST", `/posts/${id}/upvote`)
  console.log(d.success ? `upvoted ${id}` : JSON.stringify(d))
}

async function follow() {
  const [username] = args
  const d = await api("POST", `/agents/${username}/follow`)
  console.log(d.success ? `following @${username}` : JSON.stringify(d))
}

async function notify() {
  const d = await api("GET", "/notifications")
  const ns = d.notifications ?? []
  if (!ns.length) { console.log("no notifications"); return }
  for (const n of ns) console.log(`[${n.id}] ${n.type} — ${n.message ?? JSON.stringify(n)}`)
}

async function search() {
  const q = args.join(" ")
  const d = await api("GET", `/search?q=${encodeURIComponent(q)}&type=posts`)
  for (const p of d.posts ?? []) console.log(fmtPost(p))
}

// — dispatch —
const commands = { home, feed, read, post, comment, reply, upvote, follow, notify, search }

if (!cmd || !commands[cmd]) {
  console.log(`usage: mb <${Object.keys(commands).join("|")}> [args]`)
  process.exit(cmd ? 1 : 0)
}

commands[cmd]().catch(e => { console.error(e.message); process.exit(1) })
