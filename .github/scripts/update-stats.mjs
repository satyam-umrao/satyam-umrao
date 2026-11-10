import { writeFileSync, mkdirSync } from "node:fs";

const USER = "satyam-umrao";
const token = process.env.STATS_TOKEN;

const gql = async (query, variables) => {
  const r = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "readme-stats",
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

// ---------- 1. fetch totals (all-time, incl. private as counts) ----------
const { user } = await gql(
  `query($login:String!){ user(login:$login){ createdAt } }`,
  { login: USER }
);

const now = new Date();
const t = { commits: 0, prs: 0, issues: 0, reviews: 0, private: 0 };

for (let y = new Date(user.createdAt).getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
  const from = `${y}-01-01T00:00:00Z`;
  const to = y === now.getUTCFullYear() ? now.toISOString() : `${y}-12-31T23:59:59Z`;
  const d = await gql(
    `query($login:String!,$from:DateTime!,$to:DateTime!){
      user(login:$login){
        contributionsCollection(from:$from,to:$to){
          totalCommitContributions
          totalPullRequestContributions
          totalIssueContributions
          totalPullRequestReviewContributions
          restrictedContributionsCount
        }
      }
    }`,
    { login: USER, from, to }
  );
  const c = d.user.contributionsCollection;
  t.commits += c.totalCommitContributions;
  t.prs += c.totalPullRequestContributions;
  t.issues += c.totalIssueContributions;
  t.reviews += c.totalPullRequestReviewContributions;
  t.private += c.restrictedContributionsCount;
}
const total = t.commits + t.prs + t.issues + t.reviews + t.private;

// ---------- 2. 5x7 pixel font (each glyph = 7 rows of 5 bits) ----------
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
    C: "01110/10001/10000/10000/10000/10001/01110",
    E: "11111/10000/10000/11110/10000/10000/11111",
    I: "01110/00100/00100/00100/00100/00100/01110",
    L: "10000/10000/10000/10000/10000/10000/11111",
    M: "10001/11011/10101/10101/10001/10001/10001",
    O: "01110/10001/10001/10001/10001/10001/01110",
    P: "11110/10001/10001/11110/10000/10000/10000",
    Q: "01110/10001/10001/10001/10101/10010/01101",
    R: "11110/10001/10001/11110/10100/10010/10001",
    S: "01111/10000/10000/01110/00001/00001/11110",
    T: "11111/00100/00100/00100/00100/00100/00100",
    U: "10001/10001/10001/10001/10001/10001/01110",
    V: "10001/10001/10001/10001/10001/01010/00100",
    " ": "00000/00000/00000/00000/00000/00000/00000",
  }).map(([k, v]) => [k, v.split("/")])
);

const textWidth = (s, px) => s.length * 6 * px - px;

const drawText = (s, x, y, px, color) => {
  let out = "";
  [...s].forEach((ch, i) => {
    const rows = FONT[ch] ?? FONT[" "];
    rows.forEach((row, ry) => {
      // merge consecutive pixels in a row into one rect
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
  return out;
};

// ---------- 3. build the card ----------
const stats = [
  ["TOTAL", total],
  ["COMMITS", t.commits],
  ["PULL REQS", t.prs],
  ["ISSUES", t.issues],
  ["PRIVATE", t.private],
];

const themes = {
  dark: { bg: "#151b23", border: "#232b36", value: "#ffffff", label: "#8b95a5" },
  light: { bg: "#f6f8fa", border: "#d0d7de", value: "#1f2328", label: "#656d76" },
};

const W = 1080, H = 140, PAD = 30;
const colW = (W - PAD * 2) / stats.length;

const build = (c) => {
  let body = "";
  // one size for every number, picked so the widest one leaves a clear gap
  const widest = Math.max(...stats.map(([, v]) => String(v).length));
  let px = 7;
  while (textWidth("0".repeat(widest), px) > colW - 44 && px > 3) px--;
  const valueTop = 98 - 14 - 7 * px; // number sits just above the label

  stats.forEach(([label, value], i) => {
    const x = PAD + i * colW;
    body += drawText(String(value), x, valueTop, px, c.value);
    body += drawText(label, x, 98, 3, c.label);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="All-time contributions: ${total} total, ${t.commits} commits, ${t.prs} pull requests, ${t.issues} issues, ${t.private} private" shape-rendering="crispEdges">
<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="14" fill="${c.bg}" stroke="${c.border}" stroke-width="2"/>
${body}
</svg>`;
};

mkdirSync("assets", { recursive: true });
writeFileSync("assets/stats-dark.svg", build(themes.dark));
writeFileSync("assets/stats-light.svg", build(themes.light));
console.log("Stats:", { total, ...t });
