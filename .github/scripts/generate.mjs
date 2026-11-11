import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ================= CONFIG =================
const USER = "satyam-umrao";
const NAME = "SATYAM UMRAO";
const TAGLINE = "FRONTEND DEVELOPER / BCA STUDENT";
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

// ================= 2. LATEST PUBLIC COMMITS =================
let commitLines = [];
try {
  const events = await rest(`/users/${USER}/events/public?per_page=50`);
  for (const e of events) {
    if (e.type !== "PushEvent") continue;
    const repo = e.repo.name.split("/")[1];
    const list = e.payload.commits ?? [];
    if (list.length) {
      for (const c of [...list].reverse())
        commitLines.push(`${repo}: ${c.message.split("\n")[0]}`);
    } else commitLines.push(`${repo}: pushed code`);
    if (commitLines.length >= 4) break;
  }
} catch (e) {
  console.warn("Could not load events:", e.message);
}
commitLines = commitLines.slice(0, 4);
if (!commitLines.length) commitLines = ["NO PUBLIC ACTIVITY YET"];

// ================= 3. WEATHER =================
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
const cond = (c) =>
  c === 0 ? "CLEAR" : c <= 3 ? "CLOUDY" : c <= 48 ? "FOG" : c <= 57 ? "DRIZZLE"
  : c <= 67 ? "RAIN" : c <= 77 ? "SNOW" : c <= 82 ? "RAIN" : "STORM";

// ================= 4. PROJECT REPOS (public only) =================
const repos = [];
for (const name of FEATURED) {
  try {
    const r = await rest(`/repos/${USER}/${name}`);
    if (r.private) { console.warn(`Skipped ${name}: private`); continue; }
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
const centerX = (s, px, W) => Math.round((W - textWidth(s, px)) / 2);

const drawText = (s, x, y, px, color) => {
  let out = "";
  [...U(s)].forEach((ch, i) => {
    const rows = FONT[ch] ?? FONT[" "];
    rows.forEach((row, ry) => {
      for (let cx = 0; cx < 5; ) {
        if (row[cx] === "1") {
          let end = cx;
          while (end + 1 < 5 && row[end + 1] === "1") end++;
          out += `<rect x="${x + (i * 6 + cx) * px}" y="${y + ry * px}" width="${(end - cx + 1) * px}" height="${px}" fill="${color}"/>`;
          cx = end + 1;
        } else cx++;
      }
    });
  });
  return `<g shape-rendering="crispEdges">${out}</g>`;
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
  dark: { bg: "#151b23", panel: "#0d1117", border: "#232b36", value: "#ffffff", label: "#8b95a5", green: "#3fb950", star: "#2b3647" },
  light: { bg: "#f6f8fa", panel: "#ffffff", border: "#d0d7de", value: "#1f2328", label: "#656d76", green: "#1a7f37", star: "#d0d7de" },
};
const LANG = {
  TypeScript: "#3178c6", JavaScript: "#f1e05a", Java: "#b07219", Python: "#3572A5",
  HTML: "#e34c26", CSS: "#563d7c", "C++": "#f34b7d", C: "#888888", PHP: "#4F5D95",
};

// ================= BUILDERS =================
const banner = (c) => {
  const W = 1080, H = 300;
  let s = frame(W, H, c);

  const r = rng(7);
  for (let i = 0; i < 28; i++)
    s += `<rect x="${20 + Math.floor(r() * (W - 40))}" y="${14 + Math.floor(r() * 140)}" width="3" height="3" fill="${c.star}"/>`;

  const stamp = `UPDATED ${now.toISOString().slice(0, 10)}`;
  s += drawText(stamp, W - 30 - textWidth(stamp, 2), 18, 2, c.label);
  s += drawText(NAME, centerX(NAME, 9, W), 40, 9, c.value);
  s += drawText(TAGLINE, centerX(TAGLINE, 3, W), 124, 3, c.label);

  // weather panel
  s += `<rect x="40" y="168" width="300" height="112" rx="10" fill="${c.panel}" stroke="${c.border}" stroke-width="2"/>`;
  s += drawText(`${CITY} NOW`, 62, 184, 2, c.label);
  if (weather) {
    const t = `${weather.temp}C`;
    s += drawText(t, 62, 210, 6, c.value);
    s += drawText(cond(weather.code), 62 + textWidth(t, 6) + 20, 228, 3, c.green);
  } else {
    s += drawText("NO DATA", 62, 220, 4, c.label);
  }

  // terminal panel
  s += `<rect x="364" y="168" width="676" height="112" rx="10" fill="${c.panel}" stroke="${c.border}" stroke-width="2"/>`;
  s += drawText(">_ LATEST COMMITS", 386, 184, 2, c.label);
  commitLines.forEach((line, i) => {
    s += drawText(clip(line, 48), 386, 206 + i * 18, 2, c.green);
  });
  return svg(W, H, s, `${NAME}: ${CITY} weather and latest commits`);
};

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
  const lines = wrap(r.description || "No description yet.", 44, 3);
  lines.forEach((l, i) => {
    s += `<text x="144" y="${72 + i * 20}" font-family="-apple-system,'Segoe UI',Helvetica,Arial,sans-serif" font-size="13" fill="${c.label}">${esc(l)}</text>`;
  });

  s += `<g shape-rendering="crispEdges">`;
  STAR.forEach((row, ry) => {
    [...row].forEach((v, rx) => {
      if (v === "1") s += `<rect x="${144 + rx * 2}" y="${158 + ry * 2}" width="2" height="2" fill="${c.green}"/>`;
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
  writeFileSync(`assets/header-${mode}.svg`, banner(c));
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

console.log({ commitsAll, prs, stars, best, projects: repos.map((r) => r.name), weather });
