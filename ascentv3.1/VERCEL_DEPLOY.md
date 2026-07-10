# Deploying Ascent to Vercel — a manual walkthrough

This is a learn-by-doing guide for deploying this app to Vercel yourself. It is
intentionally not automated and not part of PLAN.md. Ascent is a pure static site
(HTML/CSS/JS, no build step), which is the simplest possible thing to host — most
of Vercel's machinery (builds, serverless functions, framework presets) simply
doesn't apply.

## Prerequisites

- **A Vercel account** — sign up free at [vercel.com](https://vercel.com) (the
  Hobby plan is free and more than enough for this). Sign up **with your GitHub
  account** — it makes the git integration below one click.
- **A GitHub account** and `git` installed locally (macOS ships with it; run
  `git --version` to confirm).
- This project folder. Note: it is **not a git repository yet** — we'll fix that
  in step 1.

### The three ways to deploy, and which to use

| Method | What it is | When to use |
|---|---|---|
| **Git integration** (recommended) | Connect a GitHub repo; every `git push` auto-deploys | The normal way. Free CI/CD: push = deploy, branches get preview URLs, full deploy history and instant rollback |
| CLI (`vercel` command) | Upload the current folder from your terminal | Quick experiments, or projects you don't want in git |
| Dashboard drag-and-drop | Drag a folder onto vercel.com | One-off demos; no history, easy to forget what's deployed |

Use **git integration**. The whole point of learning this flow is that afterwards,
deployment stops being a step at all — you just push code.

## Step 1 — Turn the folder into a git repository

In a terminal, inside the project folder:

```bash
git init
```

This creates a hidden `.git/` directory that tracks your file history. Nothing is
uploaded anywhere yet — git is purely local until you add a remote.

Create a `.gitignore` file so local-only files never get committed:

```gitignore
.DS_Store
.claude/
```

`.DS_Store` is macOS Finder junk; `.claude/` holds your local dev-server config,
which is machine-specific tooling, not part of the app.

Then make your first commit:

```bash
git add .
git commit -m "Initial commit: Ascent miles tracker"
```

`git add .` stages every (non-ignored) file; `git commit` records a snapshot.
Vercel will always deploy from committed snapshots, never your unsaved working
files — that's a feature: what's deployed is always something you deliberately
recorded.

## Step 2 — Push the repo to GitHub

Vercel's git integration watches a repo hosted on GitHub (or GitLab/Bitbucket), so
the code needs to live there.

1. Go to [github.com/new](https://github.com/new), name the repo (e.g. `ascent`),
   set it to **Private** (it's a personal finance tool), and create it **without**
   a README/.gitignore (you already have files; letting GitHub add its own creates
   a conflicting history).
2. Connect your local repo to it and push:

```bash
git remote add origin git@github.com:<your-username>/ascent.git
git branch -M main
git push -u origin main
```

What each line does:
- `git remote add origin …` — tells your local repo where its hosted copy lives
  ("origin" is just the conventional nickname). Use the `https://…` URL instead if
  you haven't set up SSH keys with GitHub.
- `git branch -M main` — names your branch `main` (Vercel treats `main` as the
  production branch by default).
- `git push -u origin main` — uploads your commits; `-u` links the branches so
  future pushes are just `git push`.

## Step 3 — Import the repo into Vercel

1. In the Vercel dashboard, click **Add New… → Project**.
2. Vercel shows your GitHub repos (authorize access if prompted — you can limit it
   to just this repo). Click **Import** next to `ascent`.
3. Configure the project — this is the part worth understanding:
   - **Framework Preset: Other.** Presets exist so Vercel knows how to *build*
     Next.js, Vite, etc. You have no build, so there's nothing to preset.
   - **Build Command: leave empty.** With no build step, Vercel skips straight to
     uploading files.
   - **Output Directory: leave as the default (the repo root).** For built apps
     this points at the build's output folder (`dist/`, `build/`); for you the
     repo root *is* the site — `index.html` sits at the top level.
4. Click **Deploy**.

Vercel clones the repo, sees there's nothing to build, and publishes the files to
its global CDN. Static files are served from edge locations near the visitor —
there is no "server" running your app anywhere.

## Step 4 — Verify, then make deployment invisible

You'll get a production URL like `https://ascent-xyz.vercel.app`. Check:

- The app loads and works (add a purchase, open settings).
- On both phones: open the URL in Safari → Share → **Add to Home Screen**.
  Remember: `localStorage` is per-domain, so this is a fresh start — the old
  GitHub Pages data does not carry over (already accepted; the old site keeps its
  data if you ever need to read it back).

From now on the workflow is just:

```bash
git add .
git commit -m "describe the change"
git push
```

Every push to `main` becomes a production deployment automatically (watch it in
the dashboard's **Deployments** tab, which also gives one-click rollback). If you
ever push a branch other than `main`, Vercel builds it too but gives it a unique
**preview URL** instead of touching production — handy for trying UI changes
before your partner sees them.

## Optional — `vercel.json`

You don't need one. But two things it can do for a static site like this:

**Clean URLs** — serve `/about.html` at `/about` (only relevant if you ever add
more pages):

```json
{
  "cleanUrls": true
}
```

**Cache-control headers.** Worth understanding even if you keep the defaults:
Vercel serves your HTML/CSS/JS with ETag-based revalidation — the browser asks
"has this changed?" on each load and gets a tiny 304 response if not. That means
deploys show up immediately (no stale-cache problem), at the cost of one cheap
conditional request per file. Frameworks get aggressive year-long caching only
because their build step fingerprints filenames (`app.a1b2c3.js`); your files keep
stable names (`script.js`), so long-lived caching would serve stale code after a
deploy. **Leave the defaults alone.** This is also why removing the service worker
(PLAN.md, Workstream 2) matters before the move: without it, no layer between the
CDN and the browser holds old files.

## Gotchas for this specific stack

- **No SPA rewrites needed.** Guides for React/Vue tell you to rewrite all routes
  to `index.html`. That's for client-side routing; Ascent has exactly one page and
  no router. Skip it.
- **Relative paths already work.** The code was written for a GitHub Pages subpath
  (`./style.css`, `register("sw.js")`), so it works unchanged at a domain root.
- **The old GitHub Pages site.** Both phones' current home-screen icons point at
  the old origin and have a service worker cached there. Leave the old site up
  serving the self-destructing `sw.js` (from PLAN.md Workstream 2) until both
  phones have opened it once online, then re-add the app from the Vercel URL and
  delete the old icons. Only take the GitHub Pages site down after that — a dead
  origin can never deliver the cleanup worker.
- **`sw.js` on Vercel is harmless.** The self-destruct worker gets deployed along
  with everything else; since nothing registers it on the new origin, it's just an
  inert file.
- **Custom domain (optional).** Project → **Settings → Domains** → add e.g.
  `ascent.yourdomain.com`. Vercel tells you the exact DNS record to create at your
  registrar: a `CNAME` to `cname.vercel-dns.com` for a subdomain (or an `A` record
  to Vercel's IP for an apex domain). DNS can take minutes to a few hours to
  propagate; HTTPS certificates are provisioned automatically once it does.
  Remember: changing the domain later = new origin = localStorage starts empty
  again, so pick the final URL *before* you both start logging real data.

## Appendix — the CLI route

Worth knowing even if you use git integration:

```bash
npm i -g vercel   # one-time install
vercel            # deploy current folder as a preview
vercel --prod     # deploy current folder to production
```

The first run walks you through linking the folder to a Vercel project (it stores
the link in a `.vercel/` folder — gitignore it if it appears). Useful for
deploying uncommitted experiments; otherwise git push is the better habit.
