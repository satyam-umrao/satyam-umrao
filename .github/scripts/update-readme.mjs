import { readFileSync, writeFileSync } from "node:fs";

const USER = "satyam-umrao";

// Featured projects, shown in this order. Add or remove names to change the cards.
const FEATURED = ["ToolNest-AI", "caffora", "satyamtechlabs", "portfolio-website"];

const headers = {
  Accept: "application/vnd.github+json",
  "User-Agent": "readme-updater",
  ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }),
};

const esc = (s = "") => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

const cards = [];
for (const name of FEATURED) {
  const res = await fetch(`https://api.github.com/repos/${USER}/${name}`, { headers });
  if (!res.ok) {
    console.warn(`Skipped ${name}: GitHub API ${res.status} (check the name and that the repo is public)`);
    continue;
  }
  const r = await res.json();
  const i = cards.length;
  const base = `https://www.gitskins.com/api/section/pixel-card?username=${USER}&i=${i}&r=${encodeURIComponent(r.name)}`;
  const alt = esc(`${r.name}: ${r.description ?? ""}`);
  cards.push(
    `<a href="${r.html_url}"><picture><source media="(prefers-color-scheme: light)" srcset="${base}&mode=light" /><img src="${base}&mode=dark" width="49%" alt="${alt}" /></picture></a>`
  );
}

if (cards.length === 0) throw new Error("No featured repos could be loaded");

const file = "README.md";
const md = readFileSync(file, "utf8");
const next = md.replace(
  /<!--PROJECTS:START-->[\s\S]*?<!--PROJECTS:END-->/,
  `<!--PROJECTS:START-->\n${cards.join("\n")}\n<!--PROJECTS:END-->`
);

if (next !== md) writeFileSync(file, next);
console.log(`Projects: ${FEATURED.join(", ")}`);
