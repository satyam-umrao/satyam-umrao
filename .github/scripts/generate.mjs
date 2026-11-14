import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

// ================= CONFIG =================
const USER = process.env.GITHUB_USER || "satyam-umrao";
const NAME = process.env.PROFILE_NAME || "SATYAM UMRAO";
const CITY = process.env.CITY || "KANPUR";
const TIME_ZONE = process.env.TIME_ZONE || "Asia/Kolkata";
const LAT = Number(process.env.LATITUDE ?? 26.4499);
const LON = Number(process.env.LONGITUDE ?? 80.3319);
const FEATURED = (process.env.FEATURED_REPOS || "ToolNest-AI,caffora,Java,MyDocuStack")
  .split(",").map((x) => x.trim()).filter(Boolean);
const scaleInput = Number(process.env.OUTPUT_SCALE || 4);
const OUTPUT_SCALE = Number.isFinite(scaleInput) ? Math.min(4, Math.max(1, Math.floor(scaleInput))) : 4;
const ASSET_DIR = process.env.ASSET_DIR || "assets";
const README_FILE = process.env.README_FILE || "README.md";
const DRY_RUN = process.argv.includes("--dry-run");
const SHOW_HELP = process.argv.includes("--help") || process.argv.includes("-h");

const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.STATS_TOKEN;
const STATS_TOKEN = process.env.STATS_TOKEN || GH_TOKEN;

if (SHOW_HELP) {
  console.log(`GitHub profile SVG generator\n\nUsage: node generate.mjs [--dry-run]\n\nEnvironment:\n  GITHUB_USER       GitHub login (default: ${USER})\n  PROFILE_NAME      Name shown on the room sign\n  CITY, LATITUDE, LONGITUDE  Weather location\n  TIME_ZONE         Clock timezone (default: ${TIME_ZONE})\n  FEATURED_REPOS    Comma-separated repository names\n  OUTPUT_SCALE      SVG output density from 1 to 4 (default: 4)\n  ASSET_DIR         Asset output folder (default: assets)\n  README_FILE       README to update (default: README.md)\n  GITHUB_TOKEN      GitHub token; can also supply STATS_TOKEN\n  STATS_TOKEN       GitHub token with GraphQL access\n\n--dry-run fetches data and builds the SVGs without writing files.`);
  process.exit(0);
}
if (!STATS_TOKEN) throw new Error("GitHub token missing. Set STATS_TOKEN or GITHUB_TOKEN.");
if (!Number.isFinite(LAT) || !Number.isFinite(LON)) throw new Error("LATITUDE and LONGITUDE must be valid numbers.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const requestJson = async (url, options = {}) => {
  let lastError;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
      if (!r.ok) {
        const detail = (await r.text()).slice(0, 500);
        const error = new Error(`${url} -> ${r.status}${detail ? `: ${detail}` : ""}`);
        if (r.status < 500 && r.status !== 429) throw error;
        lastError = error;
        const retryAfter = Number(r.headers.get("retry-after"));
        await sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 500 * 2 ** attempt);
        continue;
      }
      return await r.json();
    } catch (e) {
      lastError = e;
      if (e.message?.includes(" -> ") && !/ -> (429|5\d\d)/.test(e.message)) throw e;
      if (attempt < 3) await sleep(500 * 2 ** attempt);
    }
  }
  throw lastError || new Error(`Request failed: ${url}`);
};

// ================= API HELPERS =================
const rest = async (path) => {
  return requestJson(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "readme-generator",
      ...(GH_TOKEN && { Authorization: `Bearer ${GH_TOKEN}` }),
    },
  });
};

const gql = async (query, variables) => {
  const j = await requestJson("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STATS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "readme-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (j.errors?.length) throw new Error(j.errors.map((e) => e.message).join("; "));
  if (!j.data) throw new Error("GitHub GraphQL returned no data.");
  return j.data;
};

// ================= 1. STATS DATA (private counts included) =================
const { user } = await gql(
  `query($login:String!){ user(login:$login){ createdAt } }`,
  { login: USER }
);
if (!user?.createdAt) throw new Error(`GitHub user "${USER}" was not found or is inaccessible.`);
const queryNow = new Date();
let commits = 0, prs = 0, priv = 0;
const days = new Map();

for (let y = new Date(user.createdAt).getUTCFullYear(); y <= queryNow.getUTCFullYear(); y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === queryNow.getUTCFullYear() ? queryNow.toISOString() : `${y}-12-31T23:59:59Z`;
  const d = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from,to:$to){
          totalCommitContributions
          totalPullRequestContributions
          restrictedContributionsCount
          contributionCalendar{ weeks{ contributionDays{ date contributionCount } } }
        }
      }
    }`,
    { login: USER, from, to }
  );
  const c = d.user.contributionsCollection;
  commits += c.totalCommitContributions;
  prs += c.totalPullRequestContributions;
  priv += c.restrictedContributionsCount;
  for (const w of c.contributionCalendar.weeks)
    for (const day of w.contributionDays)
      days.set(day.date, Math.max(days.get(day.date) ?? 0, day.contributionCount));
}
// Restricted contribution counts include private activity, so present this as
// overall activity rather than implying every restricted item was a commit.
const activity = commits + priv;

let stars = 0, cursor = null, more = true;
while (more) {
  const d = await gql(
    `query($login:String!,$after:String){
      user(login:$login){
        repositories(first:100, after:$after, ownerAffiliations:OWNER){
          nodes{ stargazerCount }
          pageInfo{ hasNextPage endCursor }
        }
      }
    }`,
    { login: USER, after: cursor }
  );
  const r = d.user.repositories;
  stars += r.nodes.reduce((s, n) => s + n.stargazerCount, 0);
  more = r.pageInfo.hasNextPage;
  cursor = r.pageInfo.endCursor;
}

let best = 0, run = 0, prev = null;
for (const date of [...days.keys()].sort()) {
  const active = days.get(date) > 0;
  const nextDay = prev && (new Date(date) - new Date(prev)) / 86400000 === 1;
  run = active ? (nextDay && run > 0 ? run + 1 : 1) : 0;
  if (active) best = Math.max(best, run);
  prev = date;
}
const dayKey = (d) => d.toISOString().slice(0, 10);
const shiftDay = (date, amount) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + amount);
  return dayKey(d);
};
const todayKey = dayKey(queryNow);
let streakDate = days.get(todayKey) > 0 ? todayKey : shiftDay(todayKey, -1);
let current = 0;
while (days.get(streakDate) > 0) {
  current++;
  streakDate = shiftDay(streakDate, -1);
}

// ================= 2. LATEST PUBLIC COMMITS (for the monitor) =================
let commitLines = [];
try {
  const events = await rest(`/users/${encodeURIComponent(USER)}/events/public?per_page=100`);
  const seen = new Set();
  const picks = [];
  for (const e of events) {
    if (e.type !== "PushEvent" || picks.length >= 8) continue;
    const sha = e.payload?.head;
    const repo = e.repo.name.split("/")[1];
    if (!sha || seen.has(sha) || repo === USER) continue;
    seen.add(sha);
    picks.push({ repo, fullName: e.repo.name, sha });
  }
  commitLines = (await Promise.all(picks.map(async ({ repo, fullName, sha }) => {
    try {
      const c = await rest(`/repos/${fullName}/commits/${sha}`);
      return `${repo}: ${c.commit.message.split("\n")[0]}`;
    } catch (e) {
      console.warn(`Could not load commit ${sha.slice(0, 7)}:`, e.message);
      return null;
    }
  }))).filter(Boolean);
} catch (e) {
  console.warn("Could not load events:", e.message);
}
if (!commitLines.length) commitLines = ["no public commits yet"];

// ================= 3. LANGUAGES (for the bookshelf) =================
let langs = [];
try {
  const all = [];
  for (let page = 1; ; page++) {
    const batch = await rest(`/users/${encodeURIComponent(USER)}/repos?per_page=100&type=owner&page=${page}`);
    all.push(...batch);
    if (batch.length < 100) break;
  }
  const count = {};
  for (const r of all) if (!r.fork && r.language) count[r.language] = (count[r.language] ?? 0) + 1;
  langs = Object.entries(count).sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 9);
} catch (e) {
  console.warn("Could not load languages:", e.message);
}
if (!langs.length) langs = ["TypeScript", "JavaScript", "HTML", "CSS", "Java"];

// ================= 4. WEATHER =================
let weather = null;
for (let attempt = 0; attempt < 3 && !weather; attempt++) {
  try {
    const data = await requestJson(
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day&timezone=${encodeURIComponent(TIME_ZONE)}`
    );
    const w = data.current;
    if (!w) throw new Error("Weather service returned no current conditions.");
    weather = {
      temp: Math.round(w.temperature_2m),
      feels: Math.round(w.apparent_temperature),
      humidity: Math.round(w.relative_humidity_2m),
      wind: Math.round(w.wind_speed_10m),
      code: w.weather_code,
      isDay: w.is_day === 1,
    };
  } catch (e) {
    console.warn(`Weather attempt ${attempt + 1} failed:`, e.message);
    await new Promise((res) => setTimeout(res, 2000));
  }
}
const wc = weather?.code ?? 0;
const kind =
  wc === 0 ? "clear" : wc <= 2 ? "partly" : wc === 3 ? "cloudy" : wc <= 48 ? "fog"
  : wc <= 57 ? "drizzle" : wc <= 67 ? "rain" : wc <= 77 ? "snow" : wc <= 82 ? "rain"
  : wc <= 86 ? "snow" : "storm";
const KIND_LABEL = {
  clear: "CLEAR", partly: "CLOUDS", cloudy: "OVERCAST", fog: "FOG",
  drizzle: "DRIZZLE", rain: "RAIN", snow: "SNOW", storm: "STORM",
};
const overcast = ["cloudy", "fog", "drizzle", "rain", "snow", "storm"].includes(kind);

// ================= 5. PROJECT REPOS (public only) =================
const repos = [];
for (const name of FEATURED) {
  try {
    const r = await rest(`/repos/${encodeURIComponent(USER)}/${encodeURIComponent(name)}`);
    if (r.private) { console.warn(`Skipped ${name}: repo is private`); continue; }
    repos.push(r);
  } catch (e) {
    console.warn(`Skipped ${name}: ${e.message} (check spelling and that it is public)`);
  }
}

// Snapshot the clock after network requests so long-running API fetches cannot
// leave the room clock displaying the time from the start of the run.
const now = new Date();
const clockParts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "short", hourCycle: "h23",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(now).map(({ type, value }) => [type, value]));
const localDate = `${clockParts.year}-${clockParts.month}-${clockParts.day}`;
const hr24 = Number(clockParts.hour);
const min = Number(clockParts.minute);
const clockSeconds = Number(clockParts.second) + now.getUTCMilliseconds() / 1000;
const timeZoneLabel = clockParts.timeZoneName || TIME_ZONE;
const isDay = weather ? weather.isDay : hr24 >= 6 && hr24 < 18;
const twilight = isDay && (hr24 < 7 || hr24 >= 17);
const stampTime = `${String(hr24).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(Math.floor(clockSeconds)).padStart(2, "0")} ${timeZoneLabel}`;
const stampTime = `${String(hr24).padStart(2, "0")}:${String(min).padStart(2, "0")}:${String(Math.floor(clockSeconds)).padStart(2, "0")}`;

// ================= PIXEL FONT (5x7) =================
const FONT = Object.fromEntries(
  Object.entries({
    "0": "01110/10001/10011/10101/11001/10001/01110",
    "1": "00100/01100/00100/00100/00100/00100/01110",
    "2": "01110/10001/00001/00010/00100/01000/11111",
    "3": "11110/00001/00001/01110/00001/00001/11110",
    "4": "00010/00110/01010/10010/11111/00010/00010",
    "5": "11111/10000/11110/00001/00001/10001/01110",
    "6": "00110/01000/10000/11110/10001/10001/01110",
    "7": "11111/00001/00010/00100/01000/01000/01000",
    "8": "01110/10001/10001/01110/10001/10001/01110",
    "9": "01110/10001/10001/01111/00001/00010/01100",
    A: "01110/10001/10001/11111/10001/10001/10001",
    B: "11110/10001/10001/11110/10001/10001/11110",
    C: "01110/10001/10000/10000/10000/10001/01110",
    D: "11110/10001/10001/10001/10001/10001/11110",
    E: "11111/10000/10000/11110/10000/10000/11111",
    F: "11111/10000/10000/11110/10000/10000/10000",
    G: "01110/10001/10000/10111/10001/10001/01111",
    H: "10001/10001/10001/11111/10001/10001/10001",
    I: "01110/00100/00100/00100/00100/00100/01110",
    J: "00111/00010/00010/00010/00010/10010/01100",
    K: "10001/10010/10100/11000/10100/10010/10001",
    L: "10000/10000/10000/10000/10000/10000/11111",
    M: "10001/11011/10101/10101/10001/10001/10001",
    N: "10001/11001/10101/10011/10001/10001/10001",
    O: "01110/10001/10001/10001/10001/10001/01110",
    P: "11110/10001/10001/11110/10000/10000/10000",
    Q: "01110/10001/10001/10001/10101/10010/01101",
    R: "11110/10001/10001/11110/10100/10010/10001",
    S: "01111/10000/10000/01110/00001/00001/11110",
    T: "11111/00100/00100/00100/00100/00100/00100",
    U: "10001/10001/10001/10001/10001/10001/01110",
    V: "10001/10001/10001/10001/10001/01010/00100",
    W: "10001/10001/10001/10101/10101/11011/10001",
    X: "10001/10001/01010/00100/01010/10001/10001",
    Y: "10001/10001/01010/00100/00100/00100/00100",
    Z: "11111/00001/00010/00100/01000/10000/11111",
    " ": "00000/00000/00000/00000/00000/00000/00000",
    ".": "00000/00000/00000/00000/00000/01100/01100",
    ",": "00000/00000/00000/00000/01100/00100/01000",
    ":": "00000/01100/01100/00000/01100/01100/00000",
    "-": "00000/00000/00000/11111/00000/00000/00000",
    "_": "00000/00000/00000/00000/00000/00000/11111",
    "/": "00001/00010/00010/00100/01000/01000/10000",
    "'": "00100/00100/01000/00000/00000/00000/00000",
    "!": "00100/00100/00100/00100/00100/00000/00100",
    "?": "01110/10001/00001/00110/00100/00000/00100",
    "(": "00010/00100/01000/01000/01000/00100/00010",
    ")": "01000/00100/00010/00010/00010/00100/01000",
    "#": "01010/01010/11111/01010/11111/01010/01010",
    "+": "00000/00100/00100/11111/00100/00100/00000",
    "=": "00000/00000/11111/00000/11111/00000/00000",
    ">": "10000/01000/00100/00010/00100/01000/10000",
    "<": "00001/00010/00100/01000/00100/00010/00001",
    "*": "00000/10101/01110/11111/01110/10101/00000",
    "@": "01110/10001/10111/10101/10111/10000/01110",
    "[": "01110/01000/01000/01000/01000/01000/01110",
    "]": "01110/00010/00010/00010/00010/00010/01110",
    "%": "11001/11010/00010/00100/01000/01011/10011",
  }).map(([k, v]) => [k, v.split("/")])
);

const U = (s) =>
  String(s).toUpperCase().replace(/[^A-Z0-9 .,:\-_\/'!?()#+=<>*@\[\]%]/gu, " ");
const textWidth = (s, px) => [...U(s)].length * 6 * px - px;

const drawText = (s, x, y, px, color) => {
  let out = "";
  [...U(s)].forEach((ch, i) => {
    const rows = FONT[ch] ?? FONT[" "];
    rows.forEach((row, ry) => {
      for (let cx = 0; cx < 5; ) {
        if (row[cx] === "1") {
          let end = cx;
          while (end + 1 < 5 && row[end + 1] === "1") end++;
          out += `<rect x="${x + (i * 6 + cx) * px}" y="${y + ry * px}" width="${(end - cx + 1) * px}" height="${px}"/>`;
          cx = end + 1;
        } else cx++;
      }
    });
  });
  return `<g fill="${color}" shape-rendering="crispEdges">${out}</g>`;
};

// ================= SMALL HELPERS =================
const esc = (s = "") =>
  String(s)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (s, n) => (s.length > n ? s.slice(0, n - 3) + "..." : s);
const hash = (s) => {
  let h = 2166136261;
  for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
};
const rng = (a) => () => {
  a |= 0; a = (a + 0x6d2b79f5) | 0;
  let t = Math.imul(a ^ (a >>> 15), 1 | a);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const wrap = (text, width, maxLines) => {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (let w of words) {
    if (w.length > width) w = w.slice(0, width - 3) + "...";
    if ((line + " " + w).trim().length <= width) line = (line + " " + w).trim();
    else { lines.push(line); line = w; }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = clip(lines[maxLines - 1] + "...", width);
  }
  return lines;
};
const svg = (W, H, inner, label) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * OUTPUT_SCALE}" height="${H * OUTPUT_SCALE}" preserveAspectRatio="xMidYMid meet" shape-rendering="crispEdges" role="img" aria-label="${esc(label)}"><title>${esc(label)}</title>${inner}</svg>`;
const frame = (W, H, c) =>
  `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="${c.bg}" stroke="${c.border}" stroke-width="2"/>`;

const themes = {
  dark: { bg: "#151b23", panel: "#0d1117", border: "#232b36", value: "#ffffff", label: "#8b95a5", green: "#3fb950" },
  light: { bg: "#f6f8fa", panel: "#ffffff", border: "#d0d7de", value: "#1f2328", label: "#656d76", green: "#1a7f37" },
};
const LANG = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Java: "#b07219", Python: "#3572A5",
  HTML: "#e34c26", CSS: "#563d7c", "C++": "#f34b7d", C: "#888888", PHP: "#4F5D95",
};
const langColor = (l) => LANG[l] ?? `hsl(${hash(l) % 360} 55% 55%)`;

// ================= ROOM PALETTES =================
const ROOM_DARK = {
  wallA: "#121829", wallB: "#161d31", floorA: "#3b2b1f", floorB: "#2f2218", base: "#241a12",
  frame: "#4a3524", sill: "#5a4230", plate: "#cfcac0", plateEdge: "#8f8a80", plateText: "#2b2b2b",
  desk: "#6b4a33", deskDark: "#4a3322", bezel: "#242a36", screen: "#06100c", code: "#3fb950",
  lamp: "#e9c46a", lampDark: "#3a3f4c", chair: "#1d2330", chairHi: "#2a3244",
  shelf: "#5a4230", shelfDark: "#3b2b1f", clockFace: "#ece8dc", clockRing: "#8a8478", hand: "#2b2b2b",
  cat: "#c98b4a", catDark: "#9c6a35", pot: "#b4533a", potDark: "#8c3f2a",
  leaf1: "#2f6b3a", leaf2: "#43a257", mug: "#e8e2d0",
};
const ROOM = {
  dark: ROOM_DARK,
  light: {
    ...ROOM_DARK,
    wallA: "#e6ebf5", wallB: "#dde4f0", floorA: "#cda57c", floorB: "#b98f66", base: "#a07a55",
    frame: "#8a6240", sill: "#9c7550", plate: "#f2efe8", plateEdge: "#b9b3a6", plateText: "#1f2328",
    desk: "#b88d60", deskDark: "#8e6642", chair: "#3a4458", chairHi: "#4a5670",
    shelf: "#9c7550", shelfDark: "#7d5c3f",
  },
};

// ================= THE PIXEL ROOM (finer pixels, animated) =================
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a, b, t) => {
  const A = hex(a), B = hex(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
};

const room = (mode) => {
  const c = themes[mode], P = ROOM[mode];
  const dark = mode === "dark";
  const W = 1080, H = 540, u = 3;
  const R = (x, y, w, h, fill, op) =>
    `<rect x="${x * u}" y="${y * u}" width="${w * u}" height="${h * u}" fill="${fill}"${op ? ` fill-opacity="${op}"` : ""}/>`;
  const g = (cls, style, inner) => `<g class="${cls}"${style ? ` style="${style}"` : ""}>${inner}</g>`;
  const tw = (x, y, w, fill, delay, dur) =>
    `<rect class="tw" x="${x * u}" y="${y * u}" width="${w * u}" height="${w * u}" fill="${fill}" style="animation-delay:-${delay.toFixed(2)}s;animation-duration:${dur.toFixed(2)}s"/>`;
  const disc = (cx, cy, r, fill, op) => {
    let o = "";
    for (let dy = -r; dy <= r; dy++) {
      const hw = Math.round(Math.sqrt(r * r - dy * dy));
      o += R(cx - hw, cy + dy, 2 * hw + 1, 1, fill, op);
    }
    return o;
  };
  const crescent = (cx, cy, r, fill) => {
    const ox = Math.round(r * 0.55), oy = -Math.round(r * 0.25), r2 = r * 0.85;
    let o = "";
    for (let dy = -r; dy <= r; dy++) {
      const hw = Math.round(Math.sqrt(r * r - dy * dy));
      const x0 = cx - hw;
      let x1 = cx + hw;
      const dd = dy - oy;
      if (Math.abs(dd) <= r2) x1 = Math.min(x1, cx + ox - Math.round(Math.sqrt(r2 * r2 - dd * dd)) - 1);
      if (x1 >= x0) o += R(x0, cy + dy, x1 - x0 + 1, 1, fill);
    }
    return o;
  };
  const stroke = (cx, cy, ang, len, t, fill) => {
    const seen = new Set();
    let o = "";
    for (let k = 0; k <= len; k += 0.5) {
      const x = Math.round(cx + Math.sin(ang) * k), y = Math.round(cy - Math.cos(ang) * k);
      const key = `${x},${y}`;
      if (!seen.has(key)) { seen.add(key); o += R(x, y, t, t, fill); }
    }
    return o;
  };

  const lh = 18, n = commitLines.length;
  const dayHr = hr24 + min / 60;
  const curt = dark ? ["#5a2d3f", "#43202f", "#7a4258"] : ["#c98aa0", "#b0708a", "#e3a9bb"];
  const rug = dark ? ["#2a3a5c", "#34487a", "#4a6199"] : ["#6d7fa8", "#8ea0c9", "#b0bfe0"];
  const wain = mix(P.wallA, "#000000", 0.2);
  const catLight = mix(P.cat, "#ffffff", 0.25);
  const skin = dark ? "#c88f6d" : "#ae704f";
  const skinHi = mix(skin, "#ffffff", 0.22);
  const hair = dark ? "#30251f" : "#342820";
  const shirt = dark ? "#2e7894" : "#326b8c";
  const shirtHi = mix(shirt, "#ffffff", 0.2);
  const pants = dark ? "#343b54" : "#46526b";
  let s = "";

  // ---- animations (CSS inside the SVG)
  const css = `
.o{transform-box:fill-box;transform-origin:center}
.tw{animation:tw 3s ease-in-out infinite}
.cl{animation:drift linear infinite}
.rd{animation:fall linear infinite}
.sn{animation:snow linear infinite}
.fog{animation:fogmove 9s ease-in-out infinite}
.bolt{opacity:0;animation:bolt 7s infinite}
.fly{animation:fly linear infinite}
.fa{animation:fa .6s steps(1) infinite}
.fb{animation:fb .6s steps(1) infinite}
.pulse{animation:pulse 3s ease-in-out infinite}
.plant{transform-origin:50% 100%;animation:sway 5s ease-in-out infinite}
.swing{transform-box:view-box;transform-origin:540px 0;animation:swing 6s ease-in-out infinite}
.cat{transform-origin:50% 100%;animation:breathe 3.6s ease-in-out infinite}
.human{transform-box:fill-box;transform-origin:50% 100%;animation:human-breathe 3.2s ease-in-out infinite}
.typing{animation:type 0.65s steps(1) infinite}
.tail{transform-origin:0 50%;animation:wag 3s ease-in-out infinite}
.zz{opacity:0;animation:zz 4s ease-out infinite}
.st{opacity:0;animation:steam 2.4s ease-out infinite}
.glow{animation:glow 4s ease-in-out infinite}
.bl{animation:blink 1.2s steps(1) infinite}
.sec{transform-box:view-box;transform-origin:949.5px 73.5px;animation:sweep 60s steps(60) infinite;animation-delay:-${clockSeconds.toFixed(2)}s}
.log{animation:scroll linear infinite}
@keyframes tw{0%,100%{opacity:.15}50%{opacity:1}}
@keyframes drift{from{transform:translateX(-64px)}to{transform:translateX(214px)}}
@keyframes fall{from{transform:translateY(-14px)}to{transform:translateY(184px)}}
@keyframes snow{0%{transform:translate(0,-10px)}50%{transform:translate(10px,90px)}100%{transform:translate(0,184px)}}
@keyframes fogmove{0%,100%{transform:translateX(-18px)}50%{transform:translateX(18px)}}
@keyframes bolt{0%,86%,100%{opacity:0}88%{opacity:.8}90%{opacity:.1}92%{opacity:.7}95%{opacity:0}}
@keyframes fly{from{transform:translate(-30px,6px)}to{transform:translate(250px,-26px)}}
@keyframes fa{0%{opacity:1}50%{opacity:0}}
@keyframes fb{0%{opacity:0}50%{opacity:1}}
@keyframes pulse{0%,100%{transform:scale(1);opacity:.7}50%{transform:scale(1.12);opacity:1}}
@keyframes sway{0%,100%{transform:rotate(-2.2deg)}50%{transform:rotate(2.2deg)}}
@keyframes swing{0%,100%{transform:rotate(-1.4deg)}50%{transform:rotate(1.4deg)}}
@keyframes breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.07)}}
@keyframes human-breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.015)}}
@keyframes type{0%,100%{transform:translateY(0)}50%{transform:translateY(1px)}}
@keyframes wag{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(12deg)}}
@keyframes zz{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(24px,-56px)}}
@keyframes steam{0%{opacity:0;transform:translateY(0)}30%{opacity:.8}100%{opacity:0;transform:translateY(-24px)}}
@keyframes glow{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes blink{0%{opacity:1}50%{opacity:0}}
@keyframes sweep{to{transform:rotate(360deg)}}
@keyframes scroll{from{transform:translateY(0)}to{transform:translateY(-${n * lh}px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

  const defs =
    `<clipPath id="rc"><rect width="${W}" height="${H}" rx="14"/></clipPath>` +
    `<clipPath id="win"><rect x="60" y="48" width="204" height="168"/></clipPath>` +
    `<clipPath id="scr"><rect x="412" y="168" width="328" height="110"/></clipPath>` +
    `<pattern id="scan" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="3" fill="#000000" fill-opacity=".22"/></pattern>`;

  // ---- wall: striped wallpaper, wainscot, baseboard
  s += R(0, 0, 360, 148, P.wallA);
  for (let x = 0; x < 360; x += 4) s += R(x, 0, 2, 148, P.wallB) + R(x + 2, 0, 1, 148, mix(P.wallB, "#ffffff", 0.05));
  s += R(0, 118, 360, 30, wain) + R(0, 117, 360, 2, mix(wain, "#ffffff", 0.18)) + R(0, 119, 360, 1, mix(wain, "#000000", 0.3));
  for (let x = 6; x < 360; x += 30)
    s += R(x, 124, 24, 18, mix(wain, "#000000", 0.28)) + R(x + 1, 125, 22, 16, mix(wain, "#ffffff", 0.06));
  s += R(0, 144, 360, 4, P.base) + R(0, 144, 360, 1, mix(P.base, "#ffffff", 0.2));

  // ---- floor: planks, seams, grain, rug
  s += R(0, 148, 360, 32, P.floorA) + R(0, 148, 360, 1, mix(P.floorA, "#ffffff", 0.18));
  for (let r = 0; r < 4; r++) {
    const y = 148 + r * 8;
    s += R(0, y, 360, 1, P.floorB);
    for (let x = (r % 2) * 28; x < 360; x += 56) s += R(x, y, 1, 8, P.floorB);
  }
  const fr = rng(3);
  for (let i = 0; i < 150; i++)
    s += R(Math.floor(fr() * 350), 150 + Math.floor(fr() * 28), 3 + Math.floor(fr() * 6), 1, mix(P.floorA, "#ffffff", 0.07));
  s += R(60, 158, 210, 19, rug[0]) + R(62, 160, 206, 15, rug[1]) + R(66, 163, 198, 9, rug[0], 0.45);
  for (let x = 70; x < 262; x += 12) s += R(x, 165, 6, 5, rug[2], 0.55);
  for (let x = 62; x < 268; x += 4) s += R(x, 177, 2, 2, rug[0]);
  s += R(98, 150, 190, 7, "#000000", 0.18);

  // ---- window: live sky
  const sk = overcast
    ? isDay ? (twilight ? ["#5d5a78", "#b78a74"] : ["#8fa3b8", "#b7c4d1"]) : ["#121827", "#1b2336"]
    : isDay ? (twilight ? ["#6c5b9e", "#f2956b"] : ["#6bb8f5", "#a8dcff"]) : ["#0a1233", "#16245a"];
  const skyAt = (row) => mix(sk[0], sk[1], Math.min(1, Math.round(((row - 16) / 56) * 6) / 6));
  let sky = "";
  for (let r = 16; r < 72; r += 2) sky += R(20, r, 68, 2, skyAt(r));

  if (!isDay || twilight) {
    const nStars = !isDay ? (overcast ? 8 : 36) : overcast ? 0 : 10;
    const rs = rng(11);
    for (let i = 0; i < nStars; i++)
      sky += tw(22 + Math.floor(rs() * 64), 18 + Math.floor(rs() * 34), rs() > 0.85 ? 2 : 1, "#ffffff", rs() * 3, 2 + rs() * 3);
  }

  if (!overcast && isDay) {
    const f = Math.min(1, Math.max(0, (dayHr - 6) / 12));
    const cx = Math.round(34 + f * 40), cy = Math.round(60 - Math.sin(Math.PI * f) * 34);
    const col = twilight ? "#ffb347" : "#ffd84d";
    let rays = "";
    for (const [dx, dy] of [[0, -10], [0, 9], [-10, 0], [9, 0], [-7, -7], [7, -7], [-7, 7], [7, 7]])
      rays += R(cx + dx, cy + dy, 2, 2, "#ffe98a");
    sky += disc(cx, cy, 10, col, 0.18) + g("o pulse", "", rays) + disc(cx, cy, 6, col) + disc(cx - 1, cy - 1, 3, "#fff3b0", 0.7);
  }
  if (!overcast && !isDay) {
    const f = Math.min(1, Math.max(0, (dayHr >= 18 ? dayHr - 18 : dayHr + 6) / 12));
    const cx = Math.round(34 + f * 40), cy = Math.round(58 - Math.sin(Math.PI * f) * 30);
    sky += disc(cx, cy, 9, "#f4efd0", 0.1) + crescent(cx, cy, 5, "#f4efd0");
  }

  // distant skyline
  const city = rng(9);
  const bcol = isDay ? mix(sk[1], "#35506e", overcast ? 0.7 : 0.55) : "#0a0f1f";
  let sx = 20;
  while (sx < 88) {
    const bw = Math.min(4 + Math.floor(city() * 4), 88 - sx);
    const bh = 6 + Math.floor(city() * 9), top = 72 - bh;
    sky += R(sx, top, bw, bh, bcol);
    for (let wy = top + 2; wy < 70; wy += 3)
      for (let wx = sx + 1; wx < sx + bw - 1; wx += 2) {
        const v = city();
        if (!isDay && v > 0.6) sky += v > 0.93 ? tw(wx, wy, 1, "#f2c14e", city() * 3, 3) : R(wx, wy, 1, 1, "#f2c14e", 0.9);
        else if (isDay && v > 0.85) sky += R(wx, wy, 1, 1, mix(bcol, "#ffffff", 0.25));
      }
    sx += bw + (city() > 0.6 ? 1 : 0);
  }
  sky += R(20, 70, 68, 2, mix(bcol, "#000000", 0.35));

  if (kind === "fog")
    for (let i = 0; i < 3; i++) sky += g("fog", `animation-delay:-${i * 2.5}s`, R(16, 36 + i * 7, 76, 3, "#ffffff", 0.3));

  const nCloud = { clear: 1, partly: 2, cloudy: 4, fog: 0, drizzle: 4, rain: 4, snow: 4, storm: 4 }[kind];
  const cc = overcast
    ? isDay ? (["drizzle", "rain", "storm"].includes(kind) ? "#6f7b8b" : "#98a4b3") : "#2a3144"
    : isDay ? "#ffffff" : "#3a4770";
  const csh = mix(cc, "#000000", 0.18);
  const cr = rng(21);
  for (let i = 0; i < nCloud; i++) {
    const y = 18 + Math.floor(cr() * 22);
    const big = overcast || i % 2 === 0;
    const shape = big
      ? R(26, y, 6, 1, cc) + R(23, y + 1, 12, 1, cc) + R(21, y + 2, 18, 2, cc) + R(21, y + 4, 18, 1, csh)
      : R(25, y, 5, 1, cc) + R(22, y + 1, 10, 1, cc) + R(20, y + 2, 14, 2, cc) + R(20, y + 4, 14, 1, csh);
    const d = 40 + cr() * 40;
    sky += g("cl", `animation-duration:${d.toFixed(1)}s;animation-delay:-${(cr() * d).toFixed(1)}s`, shape);
  }

  const nDrops = { drizzle: 18, rain: 40, storm: 52 }[kind] ?? 0;
  const dr = rng(33);
  for (let i = 0; i < nDrops; i++) {
    const dur = 0.55 + dr() * 0.45;
    sky += `<rect class="rd" x="${60 + Math.floor(dr() * 200)}" y="48" width="3" height="9" fill="#8fb4ee" fill-opacity=".85" style="animation-duration:${dur.toFixed(2)}s;animation-delay:-${(dr() * dur).toFixed(2)}s"/>`;
  }
  if (kind === "snow") {
    const sr = rng(44);
    for (let i = 0; i < 32; i++) {
      const dur = 4 + sr() * 4;
      sky += `<rect class="sn" x="${60 + Math.floor(sr() * 196)}" y="48" width="3" height="3" fill="#ffffff" style="animation-duration:${dur.toFixed(1)}s;animation-delay:-${(sr() * dur).toFixed(1)}s"/>`;
    }
  }
  if (kind === "storm") sky += `<rect class="bolt" x="60" y="48" width="204" height="168" fill="#ffffff"/>`;

  if (isDay && !twilight && !overcast) {
    const bc = "#2b3a55";
    sky += g("fly", "animation-duration:24s;animation-delay:-7s",
      g("fa", "", R(30, 28, 2, 1, bc) + R(32, 29, 2, 1, bc) + R(34, 28, 2, 1, bc)) +
      g("fb", "", R(30, 29, 2, 1, bc) + R(32, 28, 2, 1, bc) + R(34, 29, 2, 1, bc)));
  }

  // window frame, glass, mullions, sill
  s += R(16, 12, 76, 64, P.frame) + R(16, 12, 76, 2, mix(P.frame, "#ffffff", 0.2)) + R(16, 74, 76, 2, mix(P.frame, "#000000", 0.3));
  s += `<g clip-path="url(#win)">${sky}</g>`;
  s += R(52, 16, 4, 56, P.frame) + R(52, 16, 1, 56, mix(P.frame, "#ffffff", 0.2));
  s += R(20, 42, 68, 4, P.frame) + R(20, 42, 68, 1, mix(P.frame, "#ffffff", 0.2));
  s += R(10, 76, 88, 4, P.sill) + R(10, 76, 88, 1, mix(P.sill, "#ffffff", 0.2)) + R(10, 80, 88, 2, mix(P.sill, "#000000", 0.35));
  if (weather) {
    const lab = `${weather.temp}C ${KIND_LABEL[kind]}`;
    s += drawText(lab, Math.round(162 - textWidth(lab, 2) / 2), 254, 2, c.label);
    const detail = `FEELS ${weather.feels}C  HUM ${weather.humidity}%`;
    s += drawText(detail, Math.round(162 - textWidth(detail, 1.7) / 2), 275, 1.7, c.label);
    const wind = `WIND ${weather.wind} KPH`;
    s += drawText(wind, Math.round(162 - textWidth(wind, 1.7) / 2), 292, 1.7, c.label);
  }

  // curtains + rod
  s += R(2, 8, 104, 2, P.sill) + R(0, 7, 3, 4, P.sill) + R(105, 7, 3, 4, P.sill);
  for (const x0 of [6, 90]) {
    s += R(x0, 10, 12, 68, curt[0]);
    for (let i = 0; i < 4; i++) s += R(x0 + i * 3 + 1, 10, 1, 68, curt[1]) + R(x0 + i * 3 + 2, 10, 1, 68, curt[2], 0.55);
    s += R(x0, 46, 12, 3, mix(curt[2], "#ffffff", 0.2)) + R(x0, 78, 12, 2, curt[1]);
  }

  // fairy lights at night
  if (!isDay) {
    const cols = ["#ff6b6b", "#ffd84d", "#6bcb77", "#4d96ff", "#c77dff"];
    let wire = "", bulbs = "";
    for (let i = 0; i <= 26; i++) {
      const x = Math.round(4 + i * 13.4), y = 3 + Math.round(2 * Math.sin(i * 0.9));
      wire += R(x, y, 14, 1, "#2b2b33");
      bulbs += R(x + 5, y + 1, 2, 3, cols[i % 5]) + tw(x + 4, y + 4, 1, cols[i % 5], (i * 0.37) % 3, 2.2 + (i % 3) * 0.6);
    }
    s += wire + bulbs;
  }

  // hanging name plate (swings)
  const plate =
    R(160, 0, 1, 10, P.plateEdge) + R(196, 0, 1, 10, P.plateEdge) +
    R(124, 10, 112, 22, mix(P.plateEdge, "#000000", 0.2)) + R(125, 11, 110, 20, P.plateEdge) + R(127, 13, 106, 16, P.plate) +
    R(126, 12, 2, 2, "#8a8478") + R(232, 12, 2, 2, "#8a8478") + R(126, 28, 2, 2, "#8a8478") + R(232, 28, 2, 2, "#8a8478") +
    drawText(NAME, 124 * u + (112 * u - textWidth(NAME, 4)) / 2, 10 * u + (22 * u - 28) / 2, 4, P.plateText);
  s += `<g class="swing">${plate}</g>`;

  // poster
  s += R(252, 10, 40, 34, P.frame) + R(254, 12, 36, 30, "#1b2a41") + R(254, 12, 36, 1, "#ffffff", 0.08);
  s += drawText("</>", 254 * u + Math.round((36 * u - textWidth("</>", 2)) / 2), 12 * u + 38, 2, "#3fb950");

  // clock (time of last update + sweeping second hand)
  const ccx = 316, ccy = 24;
  s += disc(ccx, ccy, 13, mix(P.clockRing, "#000000", 0.25)) + disc(ccx, ccy, 12, P.clockRing) + disc(ccx, ccy, 10, P.clockFace);
  for (const [dx, dy] of [[0, -9], [9, 0], [0, 9], [-9, 0]]) s += R(ccx + dx, ccy + dy, 2, 2, P.hand);
  for (let mark = 1; mark < 12; mark++) {
    if (mark % 3 === 0) continue;
    const angle = mark * Math.PI / 6;
    s += R(Math.round(ccx + Math.sin(angle) * 8), Math.round(ccy - Math.cos(angle) * 8), 1, 1, P.hand);
  }
  s += stroke(ccx, ccy, ((min + clockSeconds / 60) / 60) * 2 * Math.PI, 8, 2, P.hand);
  s += stroke(ccx, ccy, (((hr24 % 12) + min / 60 + clockSeconds / 3600) / 12) * 2 * Math.PI, 5, 2, P.hand);
  s += R(ccx - 1, ccy - 1, 3, 3, P.hand);
  const secHand = `<line class="sec" style="transform:rotate(${clockSeconds * 6}deg)" x1="949.5" y1="73.5" x2="949.5" y2="40" stroke="#d1453b" stroke-width="1.5"/><rect x="947.5" y="71.5" width="4" height="4" fill="#d1453b"/>`;

  // shelves: one book per language, succulent, mug with steam, picture
  s += R(252, 80, 104, 4, P.shelf) + R(252, 80, 104, 1, mix(P.shelf, "#ffffff", 0.2)) + R(252, 84, 104, 2, P.shelfDark);
  s += R(260, 86, 3, 8, P.shelfDark) + R(344, 86, 3, 8, P.shelfDark);
  let bx = 256;
  for (const l of langs) {
    const h = hash(l);
    const bw = 5 + (h % 3), bh = 14 + ((h >> 3) % 9);
    if (bx + bw > 340) break;
    s += R(bx, 80 - bh, bw, bh, langColor(l)) + R(bx, 80 - bh, bw, 1, "#ffffff", 0.2) + R(bx + bw - 1, 80 - bh, 1, bh, "#000000", 0.25);
    s += R(bx + 1, 80 - bh + 3, bw - 2, 1, "#ffffff", 0.4) + R(bx + 1, 80 - 5, bw - 2, 1, "#ffffff", 0.4);
    bx += bw + 1;
  }
  if (bx + 12 <= 352)
    s += R(bx + 2, 74, 8, 6, P.pot) + R(bx + 3, 70, 2, 4, P.leaf2) + R(bx + 6, 68, 2, 6, P.leaf2) + R(bx + 8, 71, 2, 3, P.leaf1);
  s += R(276, 108, 80, 4, P.shelf) + R(276, 108, 80, 1, mix(P.shelf, "#ffffff", 0.2)) + R(276, 112, 80, 2, P.shelfDark);
  s += R(284, 114, 3, 8, P.shelfDark) + R(346, 114, 3, 8, P.shelfDark);
  s += R(286, 100, 8, 8, P.mug) + R(294, 102, 2, 4, P.mug) + R(287, 101, 6, 1, "#6b4a33") + R(286, 106, 8, 2, mix(P.mug, "#000000", 0.15));
  for (const [x, d] of [[288, 0], [290, -0.8], [292, -1.6]]) s += g("st", `animation-delay:${d}s`, R(x, 95, 1, 3, "#ffffff", 0.8));
  s += R(318, 94, 24, 14, P.frame) + R(320, 96, 20, 10, "#2f5d62") + R(320, 102, 20, 4, "#3b7a57") + R(331, 98, 3, 3, "#ffd84d");

  // plant (sways)
  let plant = R(78, 100, 3, 36, P.leaf1);
  for (const [lx, ly, lw, lhh] of [[66, 108, 12, 3], [82, 104, 12, 3], [64, 116, 14, 3], [82, 114, 14, 3], [68, 124, 10, 3], [82, 122, 12, 3], [72, 95, 10, 4]])
    plant += R(lx, ly, lw, lhh, P.leaf2) + R(lx, ly + lhh - 1, lw, 1, P.leaf1) + R(lx + 1, ly, lw - 3, 1, mix(P.leaf2, "#ffffff", 0.25));
  s += g("plant o", "", plant);
  s += R(66, 134, 26, 3, mix(P.pot, "#ffffff", 0.15)) + R(68, 137, 22, 13, P.pot) + R(68, 146, 22, 4, P.potDark) + R(68, 137, 22, 2, "#2b1d12");

  // desk
  s += R(100, 114, 184, 6, P.desk) + R(100, 114, 184, 1, mix(P.desk, "#ffffff", 0.2)) + R(100, 120, 184, 3, P.deskDark);
  s += R(114, 123, 156, 27, "#000000", 0.15);
  s += R(108, 123, 6, 35, P.deskDark) + R(270, 123, 6, 35, P.deskDark) + R(108, 123, 1, 35, mix(P.deskDark, "#ffffff", 0.15));
  s += R(238, 123, 32, 30, mix(P.desk, "#000000", 0.15));
  for (const dy of [125, 139]) s += R(240, dy, 28, 12, P.desk) + R(240, dy, 28, 1, mix(P.desk, "#ffffff", 0.2)) + R(250, dy + 5, 8, 2, "#d9c9a8");

  // lamp with glow
  s += g("glow", "", R(106, 82, 22, 4, P.lamp, 0.1) + R(102, 86, 30, 6, P.lamp, 0.07) + R(98, 92, 38, 8, P.lamp, 0.05) + R(94, 100, 46, 10, P.lamp, 0.04));
  s += R(112, 72, 10, 2, P.lamp) + R(110, 74, 14, 2, P.lamp) + R(108, 76, 18, 2, P.lamp) + R(106, 78, 22, 2, P.lamp) + R(104, 80, 26, 2, mix(P.lamp, "#000000", 0.2));
  s += R(116, 82, 3, 28, P.lampDark) + R(108, 110, 18, 4, P.lampDark) + R(110, 109, 14, 1, mix(P.lampDark, "#ffffff", 0.2));

  // monitor with scrolling commits
  s += R(132, 44, 120, 56, P.bezel) + R(134, 46, 116, 52, mix(P.bezel, "#ffffff", 0.08)) + R(136, 48, 112, 46, P.screen);
  s += R(190, 97, 4, 1, "#3fb950") + R(188, 100, 8, 9, P.bezel) + R(170, 109, 44, 3, P.bezel) + R(170, 109, 44, 1, mix(P.bezel, "#ffffff", 0.15));
  s += drawText("~/COMMITS", 418, 149, 2, "#2f8f4a");
  s += drawText("LIVE", 670, 149, 2, "#ff7b72") + `<rect class="bl" x="724" y="150" width="8" height="8" fill="#ff5f56"/>`;
  s += `<rect x="412" y="166" width="328" height="1" fill="#1d3b27"/>`;
  const copies = n >= 2 ? Math.ceil(140 / (n * lh)) + 1 : 1;
  let rows = "";
  for (let k = 0; k < copies; k++)
    commitLines.forEach((l, i) => {
      rows += `<text x="420" y="${186 + (k * n + i) * lh}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="12" fill="${P.code}">${esc(clip("> " + l, 42))}</text>`;
    });
  s += `<g clip-path="url(#scr)"><g${n >= 2 ? ` class="log" style="animation-duration:${Math.max(8, n * 2.4)}s"` : ""}>${rows}</g></g>`;
  s += `<rect x="408" y="144" width="336" height="138" fill="url(#scan)"/>`;

  // keyboard, mouse, book stack
  s += R(146, 111, 56, 3, "#1b2130");
  for (let i = 0; i < 13; i++) s += R(147 + i * 4, 112, 2, 1, "#3a4458");
  s += R(210, 111, 7, 3, "#1b2130") + R(212, 111, 3, 1, "#3a4458");
  s += R(244, 108, 24, 6, "#3b6fb4") + R(246, 102, 20, 6, "#d9a441") + R(248, 97, 16, 5, "#b4533a") + R(245, 110, 22, 1, "#ffffff", 0.5);

  // chair
  s += R(220, 124, 32, 22, P.chair) + R(222, 126, 28, 2, P.chairHi) + R(235, 128, 2, 16, P.chairHi);
  s += R(216, 146, 40, 6, P.chair) + R(216, 146, 40, 1, P.chairHi) + R(234, 152, 4, 6, P.lampDark);
  s += R(222, 157, 32, 2, P.lampDark) + R(222, 159, 4, 2, P.lampDark) + R(250, 159, 4, 2, P.lampDark);
  s += R(198, 124, 32, 22, P.chair) + R(200, 126, 28, 2, P.chairHi) + R(213, 128, 2, 16, P.chairHi);
  s += R(194, 146, 40, 6, P.chair) + R(194, 146, 40, 1, P.chairHi) + R(212, 152, 4, 6, P.lampDark);
  s += R(200, 157, 32, 2, P.lampDark) + R(200, 159, 4, 2, P.lampDark) + R(228, 159, 4, 2, P.lampDark);

  // seated developer, leaning toward the monitor and typing
  const person =
    R(232, 127, 11, 20, pants) + R(245, 127, 11, 20, pants) +
    R(229, 146, 16, 4, hair) + R(244, 146, 16, 4, hair) +
    R(231, 112, 27, 22, shirt) + R(232, 113, 24, 3, shirtHi) +
    R(227, 114, 8, 9, mix(shirt, "#000000", 0.14)) + R(255, 114, 7, 9, mix(shirt, "#000000", 0.14)) +
    R(224, 117, 10, 4, skin) + R(215, 116, 12, 4, skinHi) + R(212, 115, 5, 5, skin) +
    R(257, 117, 7, 4, skin) + R(261, 116, 4, 5, skinHi) +
    R(243, 107, 8, 8, skin) + R(245, 109, 5, 2, skinHi) +
    R(246, 96, 15, 15, skin) + R(244, 100, 4, 10, skin) + R(259, 102, 3, 5, skinHi) +
    R(245, 94, 16, 5, hair) + R(243, 97, 5, 6, hair) + R(249, 92, 10, 3, hair) +
    R(244, 106, 4, 2, mix(skin, "#000000", 0.22)) +
    R(247, 100, 5, 1, hair) + R(247, 101, 1, 3, hair) + R(251, 101, 1, 3, hair) +
    R(253, 100, 5, 1, hair) + R(253, 101, 1, 3, hair) + R(257, 101, 1, 3, hair) +
    R(248, 102, 2, 1, "#8fc8d6") + R(254, 102, 2, 1, "#8fc8d6") +
    R(246, 112, 5, 4, shirtHi) + R(251, 112, 5, 4, shirtHi) + R(250, 117, 2, 7, "#e7c46a");
  s += g("human", "", person);
  s += g("typing", "", R(212, 115, 5, 5, skin) + R(199, 113, 14, 3, skin) + R(199, 116, 8, 2, skinHi));

  // sleeping cat (breathes, tail wags, Zs float up)
  s += R(280, 155, 58, 2, "#000000", 0.2);
  const cat =
    R(296, 142, 32, 13, P.cat) + R(298, 142, 28, 2, catLight) + R(296, 153, 32, 2, P.catDark) +
    R(304, 142, 3, 13, P.catDark) + R(312, 142, 3, 13, P.catDark) + R(320, 142, 3, 13, P.catDark) +
    R(282, 146, 16, 9, P.cat) + R(284, 146, 12, 1, catLight) +
    R(282, 142, 4, 4, P.cat) + R(283, 143, 2, 2, "#e8a0a8") + R(292, 142, 4, 4, P.cat) + R(293, 143, 2, 2, "#e8a0a8") +
    R(285, 150, 4, 1, "#2b1d12") + R(291, 150, 4, 1, "#2b1d12") + R(288, 152, 2, 1, "#e8a0a8") + R(286, 153, 8, 2, catLight);
  s += g("cat o", "", cat);
  s += g("tail o", "", R(328, 148, 12, 5, P.cat) + R(336, 145, 4, 4, P.cat) + R(332, 148, 2, 5, P.catDark));
  for (const [x, y, px, d] of [[850, 416, 3, 0], [872, 400, 2, -1.3], [894, 384, 2, -2.6]])
    s += g("zz", `animation-delay:${d}s`, drawText("Z", x, y, px, c.label));

  // updated stamp
  const stamp = `UPDATED ${localDate} ${stampTime}`;
  // local clock time only
  const stamp = stampTime;
  s += drawText(stamp, W - 24 - textWidth(stamp, 2), H - 22, 2, c.label);

  return svg(
    W, H,
    `<defs><style>${css}</style>${defs}</defs>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="${c.bg}"/>` +
    `<g clip-path="url(#rc)" shape-rendering="crispEdges">${s}</g>` +
    secHand +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="none" stroke="${c.border}" stroke-width="2"/>`,
    `${NAME}'s pixel room: a developer working at a computer, live ${CITY} weather, latest commits and local time`
    `${NAME}'s pixel room: live ${CITY} weather, latest commits and local time`
  );
};

// ================= STATS CARD / HEADING / PROJECT CARDS =================
const statsCard = (c) => {
  const items = [
    ["ACTIVITY", String(activity)],
    ["PULL REQUESTS", String(prs)],
    ["STARS", String(stars)],
    ["BEST STREAK", `${best}D`],
    ["CURRENT STREAK", `${current}D`],
  ];
  const W = 1080, H = 118, PAD = 24;
  const colW = (W - PAD * 2) / items.length;
  const LABEL_Y = 80;
  let s = frame(W, H, c);
  items.forEach(([label, value], i) => {
    const x = PAD + i * colW;
    const valuePx = Math.min(5, (colW - 24) / Math.max(1, [...U(value)].length * 6 - 1));
    const labelPx = Math.min(2.5, (colW - 20) / Math.max(1, [...U(label)].length * 6 - 1));
    const valueWidth = textWidth(value, valuePx);
    const labelWidth = textWidth(label, labelPx);
    s += drawText(value, x + (colW - valueWidth) / 2, 28, valuePx, c.value);
    s += drawText(label, x + (colW - labelWidth) / 2, LABEL_Y, labelPx, c.label);
    if (i > 0) s += `<line x1="${x}" y1="28" x2="${x}" y2="92" stroke="${c.border}" stroke-width="2"/>`;
    s += `<rect x="${x + (colW - 28) / 2}" y="101" width="28" height="3" fill="${c.green}"/>`;
  });
  return svg(W, H, s, items.map(([l, v]) => `${v} ${l.toLowerCase()}`).join(", "));
};

const projectsHeader = (c) => {
  const W = 1080, H = 40, px = 5;
  const t = "> PROJECTS";
  let s = drawText(t, 4, 2, px, c.green);
  const x0 = 4 + textWidth(t, px) + 20;
  s += `<line x1="${x0}" y1="20" x2="${W - 4}" y2="20" stroke="${c.border}" stroke-width="2" stroke-dasharray="4 6"/>`;
  return svg(W, H, s, "Projects");
};

const STAR = ["0001000", "0001000", "1111111", "0111110", "0011100", "0110110", "0100010"];

const card = (r, c) => {
  const W = 528, H = 200;
  const lc = LANG[r.language] ?? "#8b95a5";
  const rand = rng(hash(r.name));
  let s = frame(W, H, c);

  s += `<rect x="24" y="28" width="96" height="96" rx="10" fill="${lc}" fill-opacity="0.16"/>`;
  for (let y = 0; y < 7; y++)
    for (let x = 0; x < 4; x++)
      if (rand() > 0.42) {
        const px = 32 + x * 12, py = 34 + y * 12;
        s += `<rect x="${px}" y="${py}" width="10" height="10" fill="${lc}"/>`;
        s += `<rect x="${px}" y="${py}" width="10" height="2" fill="#ffffff" fill-opacity="0.22"/>`;
        if (x < 3) {
          const mirror = 32 + (6 - x) * 12;
          s += `<rect x="${mirror}" y="${py}" width="10" height="10" fill="${lc}"/>`;
          s += `<rect x="${mirror}" y="${py}" width="10" height="2" fill="#ffffff" fill-opacity="0.22"/>`;
        }
      }

  s += `<text x="144" y="46" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="16" font-weight="700" fill="${c.value}">${esc(clip(r.name, 26))}</text>`;
  wrap(r.description || "No description yet.", 44, 3).forEach((l, i) => {
    s += `<text x="144" y="${72 + i * 20}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="13" fill="${c.label}">${esc(l)}</text>`;
  });

  s += `<g fill="${c.green}" shape-rendering="crispEdges">`;
  STAR.forEach((row, ry) => {
    [...row].forEach((v, rx) => {
      if (v === "1") s += `<rect x="${144 + rx * 2}" y="${158 + ry * 2}" width="2" height="2"/>`;
    });
  });
  s += `</g>`;
  s += drawText(String(r.stargazers_count), 166, 154, 3, c.green);
  s += `<g fill="none" stroke="${c.label}" stroke-width="2" shape-rendering="crispEdges"><path d="M252 158v14m0-10h11v8"/><circle cx="252" cy="157" r="3" fill="${c.label}"/><circle cx="252" cy="173" r="3" fill="${c.label}"/><circle cx="263" cy="170" r="3" fill="${c.label}"/></g>`;
  s += drawText(String(r.forks_count ?? 0), 272, 154, 3, c.label);
  if (r.language)
    s += `<text x="504" y="172" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="12" fill="${c.label}">${esc(r.language)}</text>`;
  if (r.pushed_at) {
    const updated = new Date(r.pushed_at).toISOString().slice(0, 10);
    s += `<text x="504" y="188" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="10" fill="${c.label}">UPDATED ${updated}</text>`;
  }
  return svg(W, H, s, `${r.name}: ${r.description ?? ""}`);
};

// ================= BUILD OUTPUTS =================
const block = repos
  .map((r) => {
    const f = r.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    const light = relative(dirname(README_FILE), resolve(ASSET_DIR, `cards/${f}-light.svg`)).split(sep).join("/");
    const dark = relative(dirname(README_FILE), resolve(ASSET_DIR, `cards/${f}-dark.svg`)).split(sep).join("/");
    return `<a href="${esc(r.html_url)}"><picture><source media="(prefers-color-scheme: light)" srcset="${esc(light)}" /><img src="${esc(dark)}" width="49%" alt="${esc(r.name)}" /></picture></a>`;
  })
  .join("\n");

const startMarker = "<!--PROJECTS:START-->";
const endMarker = "<!--PROJECTS:END-->";
const md = readFileSync(README_FILE, "utf8");
const start = md.indexOf(startMarker), end = md.indexOf(endMarker);
if (start < 0 || end < start || md.indexOf(startMarker, start + startMarker.length) >= 0 || md.indexOf(endMarker, end + endMarker.length) >= 0)
  throw new Error(`README project markers are missing, duplicated, or out of order in ${README_FILE}.`);
const next = md.slice(0, start + startMarker.length) + `\n${block}\n` + md.slice(end);

const outputs = new Map();
for (const [mode, c] of Object.entries(themes)) {
  outputs.set(join(ASSET_DIR, `header-${mode}.svg`), room(mode));
  outputs.set(join(ASSET_DIR, `stats-${mode}.svg`), statsCard(c));
  outputs.set(join(ASSET_DIR, `projects-${mode}.svg`), projectsHeader(c));
  for (const r of repos) {
    const f = r.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
    outputs.set(join(ASSET_DIR, "cards", `${f}-${mode}.svg`), card(r, c));
  }
}

if (DRY_RUN) {
  console.log(`Dry run: prepared ${outputs.size} SVG files${next === md ? "" : " plus README update"}.`);
} else {
  const atomicWrite = (file, content) => {
    mkdirSync(dirname(file), { recursive: true });
    const temp = `${file}.tmp-${process.pid}`;
    writeFileSync(temp, content, "utf8");
    renameSync(temp, file);
  };
  for (const [file, content] of outputs) atomicWrite(file, content);
  if (next !== md) atomicWrite(README_FILE, next);
  console.log(`Generated ${outputs.size} SVG files${next === md ? "" : " and updated README"}.`);
}

console.log({ activity, prs, stars, best, current, langs, commitLines, projects: repos.map((r) => r.name), weather, outputScale: OUTPUT_SCALE });
