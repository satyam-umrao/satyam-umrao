import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ================= CONFIG =================
const USER = "satyam-umrao";
const NAME = "SATYAM UMRAO";
const CITY = "KANPUR";
const LAT = 26.4499, LON = 80.3319;
const FEATURED = ["ToolNest-AI", "caffora", "Java", "MyDocuStack"];

const STATS_TOKEN = process.env.STATS_TOKEN;
const GH_TOKEN = process.env.GITHUB_TOKEN;
if (!STATS_TOKEN) throw new Error("STATS_TOKEN secret is missing");

// ================= API HELPERS =================
const rest = async (path) => {
  const r = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "readme-generator",
      ...(GH_TOKEN && { Authorization: `Bearer ${GH_TOKEN}` }),
    },
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
};

const gql = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${STATS_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "readme-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

// ================= 1. STATS DATA (private counts included) =================
const { user } = await gql(
  `query($login:String!){ user(login:$login){ createdAt } }`,
  { login: USER }
);
const now = new Date();
let commits = 0, prs = 0, priv = 0;
const days = new Map();

for (let y = new Date(user.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
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
const commitsAll = commits + priv;

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

// ================= 2. LATEST PUBLIC COMMITS (for the monitor) =================
let commitLines = [];
try {
  const events = await rest(`/users/${USER}/events/public?per_page=100`);
  const seen = new Set();
  for (const e of events) {
    if (e.type !== "PushEvent" || commitLines.length >= 8) continue;
    const sha = e.payload.head;
    const repo = e.repo.name.split("/")[1];
    if (!sha || seen.has(sha) || repo === USER) continue;
    seen.add(sha);
    try {
      const c = await rest(`/repos/${e.repo.name}/commits/${sha}`);
      commitLines.push(`${repo}: ${c.commit.message.split("\n")[0]}`);
    } catch {}
  }
} catch (e) {
  console.warn("Could not load events:", e.message);
}
if (!commitLines.length) commitLines = ["no public commits yet"];

// ================= 3. LANGUAGES (for the bookshelf) =================
let langs = [];
try {
  const all = await rest(`/users/${USER}/repos?per_page=100&type=owner`);
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
    const r = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day&timezone=Asia%2FKolkata`
    );
    const w = (await r.json()).current;
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

// time in India (IST = UTC+5:30)
const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
const hr24 = Math.floor(istMinutes / 60), min = istMinutes % 60;
const isDay = weather ? weather.isDay : hr24 >= 6 && hr24 < 18;
const twilight = isDay && (hr24 < 7 || hr24 >= 17);
const stampTime = `${String(hr24).padStart(2, "0")}:${String(min).padStart(2, "0")} IST`;

// ================= 5. PROJECT REPOS (public only) =================
const repos = [];
for (const name of FEATURED) {
  try {
    const r = await rest(`/repos/${USER}/${name}`);
    if (r.private) { console.warn(`Skipped ${name}: repo is private`); continue; }
    repos.push(r);
  } catch (e) {
    console.warn(`Skipped ${name}: ${e.message} (check spelling and that it is public)`);
  }
}

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
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${inner}</svg>`;
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

// ================= THE PIXEL ROOM =================
// ================= WEATHER ICON (for the bar) =================
const weatherIcon = (ox, oy, c) => {
  const k = 4;
  const cell = (x, y, w, h, fill) =>
    `<rect x="${ox + x * k}" y="${oy + y * k}" width="${w * k}" height="${h * k}" fill="${fill}"/>`;
  const cl = "#9fb0c3";
  const cloud = (dy = 0) => cell(2, 2 + dy, 5, 1, cl) + cell(1, 3 + dy, 7, 1, cl) + cell(0, 4 + dy, 9, 2, cl);
  const disc = (cx, cy, r, fill) => {
    let o = "";
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++)
        if (Math.hypot(x - cx, y - cy) <= r) o += cell(x, y, 1, 1, fill);
    return o;
  };
  const rays = [[4,0],[5,0],[4,9],[5,9],[0,4],[0,5],[9,4],[9,5],[1,1],[8,1],[1,8],[8,8]]
    .map(([x, y]) => cell(x, y, 1, 1, "#ffe98a")).join("");
  const drop = (x, d, fill) => `<g class="dr" style="animation-delay:-${d}s">${cell(x, 7, 1, 2, fill)}</g>`;
  const moon = (cx, cy, r) => disc(cx, cy, r, "#f4efd0") + disc(cx + 1.8, cy - 1, r - 0.4, c.panel);

  let body = "";
  if (kind === "clear")
    body = isDay ? `<g class="o pulse">${rays}</g>${disc(4.5, 4.5, 2.6, "#ffd84d")}` : moon(4.5, 4.5, 3.4);
  else if (kind === "partly")
    body = (isDay ? disc(3.5, 3.5, 2.4, "#ffd84d") : moon(3.5, 3.5, 2.8)) + `<g class="bob">${cloud(1)}</g>`;
  else if (kind === "cloudy") body = `<g class="bob">${cloud(1)}</g>`;
  else if (kind === "fog")
    body = `<g class="bob">${cell(1, 2, 8, 1, cl)}${cell(0, 4, 9, 1, cl)}${cell(1, 6, 8, 1, cl)}</g>`;
  else if (kind === "drizzle" || kind === "rain")
    body = cloud(0) + drop(2, 0, "#7aa7e6") + drop(4, 0.4, "#7aa7e6") + drop(6, 0.8, "#7aa7e6");
  else if (kind === "snow")
    body = cloud(0) + drop(2, 0, "#9ec1f0") + drop(4, 0.6, "#9ec1f0") + drop(6, 1.1, "#9ec1f0");
  else
    body = cloud(0) +
      `<g class="bl" style="animation-duration:1.6s">${cell(5, 6, 2, 1, "#ffd84d")}${cell(4, 7, 2, 1, "#ffd84d")}${cell(5, 8, 1, 2, "#ffd84d")}</g>`;
  return `<g shape-rendering="crispEdges">${body}</g>`;
};

// ================= THE PIXEL ROOM (animated) =================
const room = (mode) => {
  const c = themes[mode], P = ROOM[mode];
  const W = 1080, H = 600, u = 6;
  const R = (col, row, w, h, fill, op) =>
    `<rect x="${col * u}" y="${row * u}" width="${w * u}" height="${h * u}" fill="${fill}"${op ? ` fill-opacity="${op}"` : ""}/>`;
  const g = (cls, style, inner) => `<g class="${cls}"${style ? ` style="${style}"` : ""}>${inner}</g>`;
  const lh = 18, n = commitLines.length;
  const dayHr = hr24 + min / 60;
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
.tail{transform-origin:0 50%;animation:wag 3s ease-in-out infinite}
.zz{opacity:0;animation:zz 4s ease-out infinite}
.st{opacity:0;animation:steam 2.4s ease-out infinite}
.glow{animation:glow 4s ease-in-out infinite}
.bl{animation:blink 1.2s steps(1) infinite}
.sec{transform-box:view-box;transform-origin:951px 75px;animation:sweep 60s steps(60) infinite}
.log{animation:scroll linear infinite}
.bob{animation:bob 2.5s ease-in-out infinite}
.dr{animation:dr 1.2s linear infinite}
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
@keyframes breathe{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.08)}}
@keyframes wag{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(12deg)}}
@keyframes zz{0%{opacity:0;transform:translate(0,0)}20%{opacity:1}100%{opacity:0;transform:translate(24px,-56px)}}
@keyframes steam{0%{opacity:0;transform:translateY(0)}30%{opacity:.8}100%{opacity:0;transform:translateY(-24px)}}
@keyframes glow{0%,100%{opacity:.55}50%{opacity:1}}
@keyframes blink{0%{opacity:1}50%{opacity:0}}
@keyframes sweep{to{transform:rotate(360deg)}}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes dr{0%{transform:translateY(-2px);opacity:0}30%{opacity:1}100%{transform:translateY(6px);opacity:0}}
@keyframes scroll{from{transform:translateY(0)}to{transform:translateY(-${n * lh}px)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

  let defs =
    `<clipPath id="rc"><path d="M0,14A14,14 0 0 1 14,0H1066A14,14 0 0 1 1080,14V540H0Z"/></clipPath>` +
    `<clipPath id="win"><rect x="60" y="48" width="204" height="168"/></clipPath>` +
    `<clipPath id="scr"><rect x="412" y="168" width="328" height="110"/></clipPath>`;

  // ---- wall + floor
  s += R(0, 0, 180, 74, P.wallA);
  for (let x = 0; x < 180; x += 8) s += R(x, 0, 4, 74, P.wallB);
  s += R(0, 74, 180, 16, P.floorA) + R(0, 72, 180, 2, P.base);
  for (let r = 0; r < 16; r += 4) {
    s += R(0, 74 + r, 180, 1, P.floorB);
    for (let x = ((r / 4) % 2) * 15; x < 180; x += 30) s += R(x, 74 + r, 1, 4, P.floorB);
  }

  // ---- window: live sky
  const sk = overcast
    ? isDay ? (twilight ? ["#5d5a78", "#b78a74"] : ["#8fa3b8", "#b7c4d1"]) : ["#121827", "#1b2336"]
    : isDay ? (twilight ? ["#6c5b9e", "#f2956b"] : ["#6bb8f5", "#a8dcff"]) : ["#0a1233", "#16245a"];
  let sky = R(10, 8, 34, 28, sk[0]) + R(10, 26, 34, 10, sk[1]);

  if (!isDay || twilight) {
    const nStars = !isDay ? (overcast ? 4 : 18) : overcast ? 0 : 6;
    const rs = rng(11);
    for (let i = 0; i < nStars; i++)
      sky += `<rect class="tw" x="${62 + Math.floor(rs() * 198)}" y="${52 + Math.floor(rs() * 84)}" width="4" height="4" fill="#ffffff" style="animation-delay:-${(rs() * 3).toFixed(2)}s;animation-duration:${(2 + rs() * 3).toFixed(2)}s"/>`;
  }

  if (!overcast && isDay) {
    const f = Math.min(1, Math.max(0, (dayHr - 6) / 12));
    const cx = Math.round(16 + f * 22), cy = Math.round(28 - Math.sin(Math.PI * f) * 14);
    const col = twilight ? "#ffb347" : "#ffd84d";
    let disc = "", rays = "";
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) if (Math.hypot(dx, dy) <= 3.3) disc += R(cx + dx, cy + dy, 1, 1, col);
    for (const [dx, dy] of [[0,-5],[0,5],[-5,0],[5,0],[-4,-4],[4,-4],[-4,4],[4,4]])
      rays += R(cx + dx, cy + dy, 1, 1, "#ffe98a");
    sky += g("o pulse", "", rays) + disc;
  }
  if (!overcast && !isDay) {
    const f = Math.min(1, (dayHr >= 18 ? dayHr - 18 : dayHr + 6) / 12);
    const cx = Math.round(16 + f * 22), cy = Math.round(28 - Math.sin(Math.PI * f) * 14);
    const cut = cy >= 24 ? sk[1] : sk[0];
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) if (Math.hypot(dx, dy) <= 3.3) sky += R(cx + dx, cy + dy, 1, 1, "#f4efd0");
    for (let dy = -3; dy <= 3; dy++)
      for (let dx = -3; dx <= 3; dx++) if (Math.hypot(dx - 2, dy + 1) <= 2.7) sky += R(cx + dx, cy + dy, 1, 1, cut);
  }

  if (kind === "fog")
    for (let i = 0; i < 3; i++)
      sky += g("fog", `animation-delay:-${i * 2.5}s`, R(6, 14 + i * 7, 42, 2, "#ffffff", 0.3));

  const nCloud = { clear: 1, partly: 2, cloudy: 4, fog: 0, drizzle: 4, rain: 4, snow: 4, storm: 4 }[kind];
  const cc = overcast
    ? isDay ? (["drizzle", "rain", "storm"].includes(kind) ? "#6f7b8b" : "#98a4b3") : "#2a3144"
    : isDay ? "#ffffff" : "#3a4770";
  const cr = rng(21);
  for (let i = 0; i < nCloud; i++) {
    const row = 9 + Math.floor(cr() * 14);
    const big = overcast || i % 2 === 0;
    const body = big
      ? R(11, row, 7, 1, cc, 0.95) + R(10, row + 1, 10, 2, cc, 0.95)
      : R(11, row, 5, 1, cc, 0.95) + R(10, row + 1, 8, 2, cc, 0.95);
    const d = 40 + cr() * 40;
    sky += g("cl", `animation-duration:${d.toFixed(1)}s;animation-delay:-${(cr() * d).toFixed(1)}s`, body);
  }

  const nDrops = { drizzle: 10, rain: 24, storm: 30 }[kind] ?? 0;
  const dr = rng(33);
  for (let i = 0; i < nDrops; i++) {
    const dur = 0.55 + dr() * 0.45;
    sky += `<rect class="rd" x="${60 + Math.floor(dr() * 200)}" y="48" width="3" height="10" fill="#8fb4ee" fill-opacity=".85" style="animation-duration:${dur.toFixed(2)}s;animation-delay:-${(dr() * dur).toFixed(2)}s"/>`;
  }
  if (kind === "snow") {
    const sr = rng(44);
    for (let i = 0; i < 18; i++) {
      const dur = 4 + sr() * 4;
      sky += `<rect class="sn" x="${60 + Math.floor(sr() * 196)}" y="48" width="4" height="4" fill="#ffffff" style="animation-duration:${dur.toFixed(1)}s;animation-delay:-${(sr() * dur).toFixed(1)}s"/>`;
    }
  }
  if (kind === "storm") sky += `<rect class="bolt" x="60" y="48" width="204" height="168" fill="#ffffff"/>`;

  if (isDay && !twilight && !overcast) {
    const bc = "#2b3a55";
    sky += g("fly", "animation-duration:24s;animation-delay:-7s",
      g("fa", "", R(10, 16, 1, 1, bc) + R(11, 17, 1, 1, bc) + R(12, 16, 1, 1, bc)) +
      g("fb", "", R(10, 17, 1, 1, bc) + R(11, 16, 1, 1, bc) + R(12, 17, 1, 1, bc)));
  }

  s += R(6, 38, 42, 2, P.sill) + R(8, 6, 38, 32, P.frame);
  s += `<g clip-path="url(#win)">${sky}</g>`;
  s += R(26, 8, 2, 28, P.frame) + R(10, 21, 34, 2, P.frame);

  // ---- hanging name plate (swings)
  const plate =
    R(80, 0, 1, 5, P.plateEdge) + R(98, 0, 1, 5, P.plateEdge) +
    R(62, 5, 56, 11, P.plateEdge) + R(63, 6, 54, 9, P.plate) +
    drawText(NAME, 62 * u + (56 * u - textWidth(NAME, 4)) / 2, 6 * u + (9 * u - 28) / 2, 4, P.plateText);
  s += `<g class="swing">${plate}</g>`;

  // ---- clock (time of the last update + sweeping second hand)
  const ccx = 158, ccy = 12;
  for (let y = -6; y <= 6; y++)
    for (let x = -6; x <= 6; x++) {
      const d = Math.hypot(x, y);
      if (d <= 6.2) s += R(ccx + x, ccy + y, 1, 1, d > 5 ? P.clockRing : P.clockFace);
    }
  const hand = (ang, len) => {
    const seen = new Set();
    let o = "";
    for (let t = 0; t <= len; t += 0.5) {
      const x = Math.round(ccx + Math.sin(ang) * t), y = Math.round(ccy - Math.cos(ang) * t);
      const key = `${x},${y}`;
      if (!seen.has(key)) { seen.add(key); o += R(x, y, 1, 1, P.hand); }
    }
    return o;
  };
  s += hand((min / 60) * 2 * Math.PI, 4.5);
  s += hand((((hr24 % 12) + min / 60) / 12) * 2 * Math.PI, 3);
  const secHand = `<line class="sec" x1="951" y1="75" x2="951" y2="42" stroke="#d1453b" stroke-width="2"/><rect x="948" y="72" width="6" height="6" fill="#d1453b"/>`;

  // ---- shelves: one book per language, mug with steam, picture
  s += R(126, 40, 52, 2, P.shelf) + R(126, 42, 52, 1, P.shelfDark);
  let bx = 129;
  for (const l of langs) {
    const h = hash(l);
    const w = 3 + (h % 2), bh = 7 + (h % 4);
    if (bx + w > 175) break;
    s += R(bx, 40 - bh, w, bh, langColor(l)) + R(bx, 40 - bh + 2, w, 1, "#000000", 0.25) + R(bx, 38, w, 1, "#000000", 0.25);
    bx += w + 1;
  }
  s += R(138, 54, 40, 2, P.shelf) + R(138, 56, 40, 1, P.shelfDark);
  s += R(142, 50, 4, 4, P.mug) + R(146, 51, 1, 2, P.mug);
  for (const [col, d] of [[142, 0], [144, -0.8], [145, -1.6]])
    s += g("st", `animation-delay:${d}s`, R(col, 48, 1, 1, "#ffffff", 0.8));
  s += R(158, 49, 10, 5, P.frame) + R(159, 50, 8, 3, P.leaf2, 0.5);

  // ---- plant (sways)
  let plant = R(37, 50, 2, 17, P.leaf1);
  for (const [cx, cy, w, h] of [[32, 56, 5, 2], [40, 53, 6, 2], [31, 60, 6, 2], [41, 59, 6, 2], [35, 48, 6, 3], [36, 63, 4, 2]])
    plant += R(cx, cy, w, h, P.leaf2) + R(cx, cy + h - 1, w, 1, P.leaf1);
  s += g("plant o", "", plant) + R(33, 66, 12, 2, P.pot) + R(34, 68, 10, 6, P.pot) + R(34, 72, 10, 2, P.potDark);

  // ---- desk + glowing lamp
  s += R(50, 57, 92, 3, P.desk) + R(50, 60, 92, 1, P.deskDark);
  s += R(57, 61, 78, 13, "#000000", 0.18) + R(54, 61, 3, 13, P.deskDark) + R(136, 61, 3, 13, P.deskDark);
  s += g("glow", "", R(49, 42, 18, 14, P.lamp, 0.22) + R(52, 44, 12, 10, P.lamp, 0.22));
  s += R(54, 37, 7, 1, P.lamp) + R(52, 38, 11, 3, P.lamp) + R(51, 41, 13, 1, P.lamp);
  s += R(57, 42, 2, 14, P.lampDark) + R(54, 56, 8, 1, P.lampDark);

  // ---- monitor with scrolling commits
  s += R(66, 22, 60, 28, P.bezel) + R(68, 24, 56, 23, P.screen);
  s += R(94, 50, 4, 5, P.bezel) + R(86, 55, 20, 2, P.bezel) + R(106, 55, 16, 2, P.bezel);
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

  // ---- chair
  s += R(102, 61, 16, 10, P.chair) + R(103, 62, 14, 1, P.chairHi) + R(109, 71, 2, 2, P.chair) + R(103, 73, 14, 1, P.chair);

  // ---- sleeping cat (breathes, tail wags, Zs float up)
  s += R(140, 77, 28, 1, "#000000", 0.2);
  const cat =
    R(146, 70, 16, 7, P.cat) + R(150, 70, 2, 7, P.catDark) + R(155, 70, 2, 7, P.catDark) +
    R(141, 72, 6, 5, P.cat) + R(141, 70, 2, 2, P.cat) + R(145, 70, 2, 2, P.cat) + R(142, 74, 2, 1, P.catDark);
  s += g("cat o", "", cat) + g("tail o", "", R(162, 73, 5, 3, P.cat));
  for (const [x, y, px, d] of [[852, 404, 3, 0], [872, 392, 2, -1.3], [892, 380, 2, -2.6]])
    s += g("zz", `animation-delay:${d}s`, drawText("Z", x, y, px, c.label));

  // ---- weather bar under the room
  const y0 = 548, bh = 44;
  let hud = `<rect x="12" y="${y0}" width="1056" height="${bh}" rx="8" fill="${c.panel}" stroke="${c.border}" stroke-width="2"/>`;
  const col = (x, label, value) => drawText(label, x, y0 + 5, 2, c.label) + drawText(value, x, y0 + 21, 3, c.value);
  if (weather) {
    const t = `${weather.temp}C`;
    hud += weatherIcon(26, y0 + 2, c);
    hud += drawText(t, 80, y0 + 5, 5, c.value);
    hud += drawText(KIND_LABEL[kind], 80 + textWidth(t, 5) + 16, y0 + 12, 3, c.green);
    hud += `<rect x="345" y="${y0 + 8}" width="2" height="${bh - 16}" fill="${c.border}"/>`;
    hud += col(365, "HUMIDITY", `${weather.humidity}%`);
    hud += col(530, "WIND", `${weather.wind} KMH`);
    hud += col(690, "FEELS LIKE", `${weather.feels}C`);
  } else {
    hud += drawText("WEATHER OFFLINE", 30, y0 + 12, 3, c.label);
  }
  hud += col(850, "UPDATED", stampTime);

  return svg(
    W, H,
    `<defs><style>${css}</style>${defs}</defs>` +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="${c.bg}"/>` +
    `<g clip-path="url(#rc)" shape-rendering="crispEdges">${s}</g>` +
    secHand + hud +
    `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="none" stroke="${c.border}" stroke-width="2"/>`,
    `${NAME}'s pixel room: live ${CITY} weather, latest commits and languages`
  );
};

// ================= STATS CARD / HEADING / PROJECT CARDS =================
const statsCard = (c) => {
  const items = [
    ["COMMITS", String(commitsAll)],
    ["PULL REQS", String(prs)],
    ["STARS", String(stars)],
    ["BEST STREAK", `${best}D`],
  ];
  const W = 1080, H = 108, PAD = 30;
  const colW = (W - PAD * 2) / items.length;
  const NUM_PX = 5, LABEL_PX = 2.5, LABEL_Y = 66;
  const NUM_Y = LABEL_Y - 8 - 7 * NUM_PX;
  let s = frame(W, H, c);
  items.forEach(([label, value], i) => {
    const x = PAD + i * colW;
    s += drawText(value, x, NUM_Y, NUM_PX, c.value);
    s += drawText(label, x, LABEL_Y, LABEL_PX, c.label);
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

  s += `<rect x="24" y="28" width="96" height="96" rx="10" fill="${lc}" fill-opacity="0.2"/>`;
  for (let y = 0; y < 5; y++)
    for (let x = 0; x < 3; x++)
      if (rand() > 0.45) {
        const py = 36 + y * 16;
        s += `<rect x="${32 + x * 16}" y="${py}" width="16" height="16" fill="${lc}"/>`;
        if (x !== 2) s += `<rect x="${32 + (4 - x) * 16}" y="${py}" width="16" height="16" fill="${lc}"/>`;
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
  if (r.language)
    s += `<text x="504" y="172" text-anchor="end" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="12" fill="${c.label}">${esc(r.language)}</text>`;
  return svg(W, H, s, `${r.name}: ${r.description ?? ""}`);
};

// ================= WRITE FILES =================
mkdirSync("assets/cards", { recursive: true });
for (const [mode, c] of Object.entries(themes)) {
  writeFileSync(`assets/header-${mode}.svg`, room(mode));
  writeFileSync(`assets/stats-${mode}.svg`, statsCard(c));
  writeFileSync(`assets/projects-${mode}.svg`, projectsHeader(c));
  for (const r of repos)
    writeFileSync(`assets/cards/${r.name.toLowerCase()}-${mode}.svg`, card(r, c));
}

// ================= README PROJECT CARDS =================
const block = repos
  .map((r) => {
    const f = r.name.toLowerCase();
    return `<a href="${r.html_url}"><picture><source media="(prefers-color-scheme: light)" srcset="assets/cards/${f}-light.svg" /><img src="assets/cards/${f}-dark.svg" width="49%" alt="${esc(r.name)}" /></picture></a>`;
  })
  .join("\n");

const md = readFileSync("README.md", "utf8");
if (!md.includes("<!--PROJECTS:START-->")) throw new Error("PROJECTS markers missing in README.md");
const next = md.replace(
  /<!--PROJECTS:START-->[\s\S]*?<!--PROJECTS:END-->/,
  `<!--PROJECTS:START-->\n${block}\n<!--PROJECTS:END-->`
);
if (next !== md) writeFileSync("README.md", next);

console.log({ commitsAll, prs, stars, best, langs, commitLines, projects: repos.map((r) => r.name), weather });
