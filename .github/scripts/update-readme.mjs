import { readFileSync, writeFileSync } from "node:fs";

const USER = "satyam-umrao";
const MAX_PROJECTS = 4; // how many cards to show (kept even for the 2-column layout)
const EXCLUDE = new Set([USER]); // skip the profile repo itself; add more names if needed

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "readme-updater",
  ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

const res = await fetch(
  `https://api.github.com/users/${USER}/repos?per_page=100&sort=pushed`,
  { headers }
);
if (!res.ok) throw new Error(`GitHub API ${res.status}`);
const repos = await res.json();

const picked = repos
  .filter((r) => !r.fork && !r.archived && !EXCLUDE.has(r.name))
  .sort((a, b) => b.stargazers_count - a.stargazers_count || new Date(b.pushed_at) - new Date(a.pushed_at))
  .slice(0, MAX_PROJECTS);

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const card = (r, i) => {
  const base = `https://www.gitskins.com/api/section/pixel-card?username=${USER}&i=${i}&r=${encodeURIComponent(r.name)}`;
  const alt = esc(`${r.name}: ${r.description ?? ""}`);
  return `<a href="${r.html_url}"><picture><source media="(prefers-color-scheme: light)" srcset="${base}&mode=light" /><img src="${base}&mode=dark" width="49%" alt="${alt}" /></picture></a>`;
};

const block = picked.map(card).join("\n");

const file = "README.md";
const md = readFileSync(file, "utf8");
const next = md.replace(
  /<!--PROJECTS:START-->[\s\S]*?<!--PROJECTS:END-->/,
  `<!--PROJECTS:START-->\n${block}\n<!--PROJECTS:END-->`
);

if (next !== md) writeFileSync(file, next);
console.log(`Projects: ${picked.map((r) => r.name).join(", ")}`);
