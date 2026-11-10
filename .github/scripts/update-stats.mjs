import { readFileSync, writeFileSync } from "node:fs";

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

const { user } = await gql(
  `query($login:String!){ user(login:$login){ createdAt } }`,
  { login: USER }
);

const now = new Date();
const t = { commits: 0, prs: 0, issues: 0, reviews: 0, private: 0 };

// contributionsCollection covers at most 1 year per query, so loop year by year
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
const block = `| Total contributions | Commits (public) | Pull requests | Issues | Reviews | Private contributions |
|:--:|:--:|:--:|:--:|:--:|:--:|
| **${total}** | ${t.commits} | ${t.prs} | ${t.issues} | ${t.reviews} | ${t.private} |

<sub>All-time, including private repos (counts only). Updated ${now.toISOString().slice(0, 10)}.</sub>`;

const md = readFileSync("README.md", "utf8");
const next = md.replace(
  /<!--STATS:START-->[\s\S]*?<!--STATS:END-->/,
  `<!--STATS:START-->\n${block}\n<!--STATS:END-->`
);
if (next !== md) writeFileSync("README.md", next);
