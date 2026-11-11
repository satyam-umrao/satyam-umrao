import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ================= CONFIG =================
const USER = "satyam-umrao";
const NAME = "SATYAM UMRAO";
const CITY = "KANPUR";
const LAT = 26.4499, LON = 80.3319;
const FEATURED = ["ToolNest-AI", "caffora", "satyamtechlabs", "portfolio-website"];

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
try {
  const r = await fetch(
    `https://api.open-meteo.com/v1/forecast?latitude=${LAT}&longitude=${LON}&current=temperature_2m,weather_code`
  );
  const w = await r.json();
  weather = { temp: Math.round(w.current.temperature_2m), code: w.current.weather_code };
} catch (e) {
  console.warn("Could not load weather:", e.message);
}
const wc = weather?.code ?? 0;
const cloudy = wc >= 1;
const rainy = (wc >= 51 && wc <= 67) || (wc >= 80 && wc <= 82) || wc >= 95;
const cond = (c) =>
  c === 0 ? "CLEAR" : c <= 3 ? "CLOUDY" : c <= 48 ? "FOG" : c <= 57 ? "DRIZZLE"
  : c <= 67 ? "RAIN" : c <= 77 ? "SNOW" : c <= 82 ? "RAIN" : "STORM";

// time in India (IST = UTC+5:30)
const istMinutes = (now.getUTCHours() * 60 + now.getUTCMinutes() + 330) % 1440;
const hr24 = Math.floor(istMinutes / 60), min = istMinutes % 60;
const isDay = hr24 >= 6 && hr24 < 18;

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
const room = (mode) => {
  const c = themes[mode], P = ROOM[mode];
  const W = 1080, H = 540, u = 6;
  let s = "";
  let defs = `<clipPath id="rc"><rect width="${W}" height="${H}" rx="14"/></clipPath>`;
  const B = (col, row, w, h, fill, op) => {
    s += `<rect x="${col * u}" y="${row * u}" width="${w * u}" height="${h * u}" fill="${fill}"${op ? ` fill-opacity="${op}"` : ""}/>`;
  };

  // wall + floor
  B(0, 0, 180, 74, P.wallA);
  for (let x = 0; x < 180; x += 8) B(x, 0, 4, 74, P.wallB);
  B(0, 74, 180, 16, P.floorA);
  B(0, 72, 180, 2, P.base);
  for (let r = 0; r < 16; r += 4) {
    B(0, 74 + r, 180, 1, P.floorB);
    for (let x = ((r / 4) % 2) * 15; x < 180; x += 30) B(x, 74 + r, 1, 4, P.floorB);
  }

  // window with live sky
  const sky = isDay ? "#7cc4ff" : "#0d1844";
  B(6, 38, 42, 2, P.sill);
  B(8, 6, 38, 32, P.frame);
  B(10, 8, 34, 28, sky);
  if (!isDay) {
    const rs = rng(11);
    for (let i = 0; i < 16; i++) B(10 + Math.floor(rs() * 33), 8 + Math.floor(rs() * 27), 1, 1, "#ffffff", 0.9);
    B(37, 10, 2, 1, "#f4efd0"); B(36, 11, 4, 2, "#f4efd0"); B(37, 13, 2, 1, "#f4efd0");
    B(38, 11, 2, 2, sky);
  } else {
    B(13, 10, 4, 1, "#ffd84d"); B(12, 11, 6, 4, "#ffd84d"); B(13, 15, 4, 1, "#ffd84d");
  }
  if (cloudy) {
    const cc = isDay ? "#ffffff" : "#3a4770";
    for (const [cx, cy] of [[13, 18], [30, 12]]) { B(cx + 1, cy, 5, 1, cc, 0.9); B(cx, cy + 1, 8, 2, cc, 0.9); }
  }
  if (rainy) {
    const rr = rng(5);
    for (let i = 0; i < 14; i++) B(10 + Math.floor(rr() * 33), 14 + Math.floor(rr() * 20), 1, 2, "#7aa7e6", 0.9);
  }
  B(26, 8, 2, 28, P.frame);
  B(10, 21, 34, 2, P.frame);
  if (weather) {
    const tc = isDay ? "#0b2a55" : "#ffffff";
    s += drawText(`${weather.temp}C`, 66, 150, 3, tc);
    s += drawText(cond(weather.code), 66, 180, 2, tc);
  }

  // name plate
  B(80, 0, 1, 5, P.plateEdge); B(98, 0, 1, 5, P.plateEdge);
  B(62, 5, 56, 11, P.plateEdge);
  B(63, 6, 54, 9, P.plate);
  s += drawText(NAME, 62 * u + (56 * u - textWidth(NAME, 4)) / 2, 6 * u + (9 * u - 28) / 2, 4, P.plateText);

  // clock with the real time in India
  const ccx = 158, ccy = 12;
  for (let y = -6; y <= 6; y++)
    for (let x = -6; x <= 6; x++) {
      const d = Math.hypot(x, y);
      if (d <= 6.2) B(ccx + x, ccy + y, 1, 1, d > 5 ? P.clockRing : P.clockFace);
    }
  const hand = (ang, len) => {
    for (let t = 0; t <= len; t += 0.5)
      B(Math.round(ccx + Math.sin(ang) * t), Math.round(ccy - Math.cos(ang) * t), 1, 1, P.hand);
  };
  hand((min / 60) * 2 * Math.PI, 4.5);
  hand((((hr24 % 12) + min / 60) / 12) * 2 * Math.PI, 3);

  // shelves: one book per language
  B(126, 40, 52, 2, P.shelf); B(126, 42, 52, 1, P.shelfDark);
  let bx = 129;
  for (const l of langs) {
    const h = hash(l);
    const w = 3 + (h % 2), bh = 7 + (h % 4);
    if (bx + w > 175) break;
    B(bx, 40 - bh, w, bh, langColor(l));
    B(bx, 40 - bh + 2, w, 1, "#000000", 0.25);
    B(bx, 40 - 2, w, 1, "#000000", 0.25);
    bx += w + 1;
  }
  B(138, 54, 40, 2, P.shelf); B(138, 56, 40, 1, P.shelfDark);
  B(142, 50, 4, 4, P.mug); B(146, 51, 1, 2, P.mug);
  B(158, 49, 10, 5, P.frame); B(159, 50, 8, 3, P.leaf2, 0.5);

  // plant
  B(37, 50, 2, 17, P.leaf1);
  for (const [cx, cy, w, h] of [[32, 56, 5, 2], [40, 53, 6, 2], [31, 60, 6, 2], [41, 59, 6, 2], [35, 48, 6, 3], [36, 63, 4, 2]]) {
    B(cx, cy, w, h, P.leaf2);
    B(cx, cy + h - 1, w, 1, P.leaf1);
  }
  B(33, 66, 12, 2, P.pot); B(34, 68, 10, 6, P.pot); B(34, 72, 10, 2, P.potDark);

  // desk
  B(50, 57, 92, 3, P.desk); B(50, 60, 92, 1, P.deskDark);
  B(57, 61, 78, 13, "#000000", 0.18);
  B(54, 61, 3, 13, P.deskDark); B(136, 61, 3, 13, P.deskDark);

  // lamp
  B(49, 42, 18, 14, P.lamp, 0.06);
  B(54, 37, 7, 1, P.lamp); B(52, 38, 11, 3, P.lamp); B(51, 41, 13, 1, P.lamp);
  B(57, 42, 2, 14, P.lampDark); B(54, 56, 8, 1, P.lampDark);

  // monitor with scrolling commits
  B(66, 22, 60, 28, P.bezel);
  B(68, 24, 56, 23, P.screen);
  B(94, 50, 4, 5, P.bezel); B(86, 55, 20, 2, P.bezel);
  B(106, 55, 16, 2, P.bezel);
  defs += `<clipPath id="scr"><rect x="416" y="150" width="320" height="126"/></clipPath>`;
  const lh = 18, n = commitLines.length;
  const row = (l, i) =>
    `<text x="424" y="${166 + i * lh}" font-family="ui-monospace,SFMono-Regular,Consolas,monospace" font-size="12" fill="${P.code}">${esc(clip(l, 44))}</text>`;
  let rows = commitLines.map((l, i) => row(l, i)).join("");
  let anim = "";
  if (n >= 7) {
    rows += commitLines.map((l, i) => row(l, i + n)).join("");
    anim = `<animateTransform attributeName="transform" type="translate" from="0 0" to="0 -${n * lh}" dur="${n * 2.5}s" repeatCount="indefinite"/>`;
  }
  s += `<g clip-path="url(#scr)"><g>${rows}${anim}</g></g>`;

  // chair
  B(102, 61, 16, 10, P.chair); B(103, 62, 14, 1, P.chairHi);
  B(109, 71, 2, 2, P.chair); B(103, 73, 14, 1, P.chair);

  // sleeping cat + Z
  B(140, 77, 28, 1, "#000000", 0.2);
  B(146, 70, 16, 7, P.cat);
  B(150, 70, 2, 7, P.catDark); B(155, 70, 2, 7, P.catDark);
  B(141, 72, 6, 5, P.cat); B(141, 70, 2, 2, P.cat); B(145, 70, 2, 2, P.cat);
  B(142, 74, 2, 1, P.catDark);
  B(162, 73, 5, 3, P.cat);
  s += drawText("Z", 950, 372, 3, c.label);
  s += drawText("Z", 984, 336, 2, c.label);

  // updated stamp
  const stamp = `UPDATED ${now.toISOString().slice(0, 10)}`;
  s += drawText(stamp, W - 24 - textWidth(stamp, 2), H - 22, 2, c.label);

  return svg(
    W, H,
    `<defs>${defs}</defs><g clip-path="url(#rc)" shape-rendering="crispEdges">${s}</g><rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="none" stroke="${c.border}" stroke-width="2"/>`,
    `${NAME}'s pixel room: ${CITY} weather, latest commits and languages`
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
