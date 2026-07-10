# Ascent v2 — Implementation Plan

This plan is written to be executed step by step by an implementation pass (Claude
Opus). It covers two workstreams. **Do Workstream 2 (service worker removal) first**
— rationale in "Execution order" at the end. Vercel deployment is deliberately NOT
part of this plan; the owner will do that manually following `VERCEL_DEPLOY.md`.

## Context

Ascent is a single-page miles tracker for two users in Singapore. It recommends
which credit card to use for a purchase to maximise 4mpd (miles-per-dollar) earning
and tracks remaining monthly bonus caps per card. Stack: plain HTML/CSS/JS, no
framework, no build step — and that must stay true. All data lives in
`localStorage` (`milesTrackerState`, `milesTrackerConfig`, `milesTrackerSettings`).
Primary usage is an iPhone home-screen PWA.

Files: `index.html`, `style.css`, `script.js`, `sw.js`, `manifest.json`, icons.
Local dev server config lives in `.claude/` (a simple static server on a fixed port).

Decisions already confirmed with the owner:

- **Design language: "clean fintech"** — near-white neutrals, one strong accent,
  big numbers, crisp card surfaces, pill/segmented controls.
- **Dark mode: yes**, automatic via `prefers-color-scheme`.
- **Existing localStorage data is disposable** — no migration or import feature needed.
- **Online-only is acceptable** — the service worker is removed entirely; offline
  launch of the home-screen app is a knowingly accepted loss.
- No new tooling: no framework, no bundler, no CSS preprocessor.

---

## Workstream 2 — Remove the service worker (do this first)

### Current state

`sw.js` implements an offline-first app shell and nothing else — no push
notifications, no background sync, no messaging:

- Cache name `ascent-shell-v1`, pre-caching index/CSS/JS/manifest/icons on install.
- **Navigations**: network-first, falling back to cached `index.html` offline.
- **All other GET requests** (CSS, JS, icons, Google Fonts): stale-while-revalidate —
  served from cache instantly, refreshed in the background, so file edits propagate
  one page-load late.
- `skipWaiting()` on install and `clients.claim()` on activate.

It is registered at the bottom of `script.js` (`window.onload`, ~line 1265):
`navigator.serviceWorker.register("sw.js")`.

**What breaks when removed:** offline launch of the installed PWA, and
instant-from-cache loads. **What does NOT break:** all data (localStorage is
independent of the SW), Add-to-Home-Screen installability (iOS only needs the
manifest + apple meta tags), CSV export, everything else.

### Approach: self-destructing service worker

Do **not** simply delete `sw.js`. Browsers that already have the old worker
re-fetch `sw.js` on navigation; a 404 leaves the old worker — and its
stale-while-revalidate cache — in control until the browser eventually drops it.
A self-destruct worker deterministically kills it on the next online visit.

Replace the entire contents of `sw.js` with:

```js
// Self-destructing service worker. Ascent no longer uses a SW; this exists so
// browsers holding the old offline-shell worker clean it up on their next visit.
// Safe to leave deployed indefinitely.
self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
        await self.registration.unregister();
        const clients = await self.clients.matchAll({ type: "window" });
        clients.forEach((client) => client.navigate(client.url));
    })());
});
```

In `script.js`, delete the registration block (the `if ("serviceWorker" in
navigator) { navigator.serviceWorker.register("sw.js")... }` at the end of
`window.onload`, including its "Offline support" comment) and replace it with a
belt-and-braces unregister:

```js
// The app no longer uses a service worker; clean up any old registration.
if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations()
        .then((regs) => regs.forEach((reg) => reg.unregister()))
        .catch(() => { /* nothing to clean up */ });
}
```

### Key decisions / tradeoffs

- **Self-destruct file vs. plain deletion**: keep the file. It's ~15 lines, costs
  nothing, and is the only reliable way to evict the old worker from browsers that
  have it (both phones' home-screen installs on the current GitHub Pages origin).
- **Keep `manifest.json`, apple meta tags, and icons**: home-screen install is still
  wanted; none of it depends on a SW.
- **Why removal is safe here specifically**: the old worker is network-first for
  navigations, so any online load fetches fresh `index.html`; the browser's SW
  update check also re-fetches `sw.js` on navigation, and the new byte-different
  worker installs with `skipWaiting` and destroys itself. The future Vercel origin
  never sees the old worker at all — this cleanup matters for the existing origin.

### Risks

- User is offline when opening the app → it won't launch. Accepted by the owner.
- On the very first revisit, the old SW may serve a stale `script.js` once (its
  stale-while-revalidate behavior). Harmless: the self-destruct worker still
  installs via the SW update path, clears caches, and reloads open clients.

### Task list

1. Replace the contents of `sw.js` with the self-destruct worker above.
2. In `script.js`, remove the SW registration block at the end of `window.onload`
   and add the unregister snippet in its place.
3. Verify locally: serve the app, load it once with the OLD sw.js to install the
   worker, then swap in the new files and reload — DevTools → Application →
   Service Workers should show no active registration and Cache Storage should be
   empty. Confirm the app still loads and functions normally afterwards.

---

## Workstream 1 — UI overhaul (v2, "clean fintech")

### Current state / audit

- **CSS is three accreted generations** in one file: an original warm-cream theme,
  an "iPhone/Mobile Safari Optimization Layer", and a "v3 UI PASS" — each partially
  overriding the last. Symptoms: duplicate `.input-group`/`.toggle-group` blocks,
  dead rules (`#transactionTable th/td` styles for a `<table>` that is now divs,
  `.reset-icon`, `h1` styles with no `h1` in the document), token drift
  (`var(--color-bg-card, #fff8f3)` fallbacks referencing tokens that don't exist;
  `--color-accent-2` equal to `--color-accent` while fallbacks say `#b85c1e`),
  `!important` on input font-size, `will-change` sprinkled broadly, a global
  `border-width: 0.7px` hack.
- **Inconsistent control language**: gradient buttons (generic `button`), a black
  `.btn-primary`, bordered `.btn-secondary`/`.export-btn`, and accent-filled pills
  all coexist. Cards lift on hover (`translateY(-4px)`) — meaningless on a phone.
- **HTML hygiene**: missing `<!DOCTYPE html>` (risks quirks mode), `<meta charset>`
  appears after other head tags, multiple inline `style=""` attributes, no visible
  app name anywhere (no header), hand-maintained version string in the footer.
- **Hierarchy**: the recommendation — the entire point of the app — is a bordered
  gradient box competing with equally-weighted Summary/History cards. Total miles
  and cap bars fight for attention.
- **No dark mode**; `theme-color` is hardcoded light.
- **Blocking dialogs**: `alert()` for validation, `prompt()` for new card names,
  `confirm()` for destructive actions. Settings is a show/hide card that scrolls
  into view rather than an overlay.

### Approach — concrete before → after decisions

1. **Rebuild `style.css` from scratch** on a single token layer. Delete all three
   legacy layers; carry over only what's deliberately kept (swipe-to-delete
   mechanics, safe-area insets, `touch-action: manipulation`, the ≥16px input
   font-size that prevents iOS zoom). Tokens in `:root`, overridden once in
   `@media (prefers-color-scheme: dark)`: background, surface, border, text
   primary/secondary/tertiary, accent + on-accent, success, danger, radii, spacing,
   shadow.
2. **Palette**: before — cream `#F7F5F2` with sunset-orange gradients; after —
   near-white neutral base (light: `#FAFAF9`-family background with white surfaces;
   dark: `#111214`-family background with slightly lifted surfaces) and a single
   money-green accent (emerald, ~`#059669` in light mode, a brighter variant in
   dark). Pick exact values contrast-checked to WCAG AA against their surfaces.
   Orange disappears except, optionally, as the app icon's brand color.
3. **Typography**: keep Inter, extend the Google Fonts link to weights 400/500/600/700.
   Apply `font-variant-numeric: tabular-nums` to every money/miles figure (total
   miles, cap remaining, transaction amounts/miles, recommendation miles). Type
   scale roughly 12 / 14 / 16 / 22 / 34px.
4. **Layout**: add a slim app header — "Ascent" wordmark left, the settings gear
   (moved out of the Add Purchase card) right. Section order stays Add Purchase →
   Summary → History. Single column, container max-width tightened from 720px to
   ~480px so desktop doesn't look sparse.
5. **Recommendation hero**: before — orange-gradient bordered box; after — the
   primary surface inside the Add card: quiet uppercase label ("Best card for
   $X"), card name in large type, miles earned as the big tabular number,
   bonus/base/rule collapsed into one muted meta line. Keep the split-plan variant
   visually consistent (rows of amount → card → miles). Preserve the DOM contract
   (`#inlineRecommendation`, existing `.rec-*` class names) so `script.js` template
   edits stay minimal.
6. **Controls**: exactly three button styles — primary (accent-filled: Add, Save),
   secondary (bordered: Export CSV, + Add Card), destructive-text (Reset, Remove).
   Remove gradient and black-button styles and all hover `translateY`. Category
   toggles become a proper segmented control (the current pill markup is already
   close — restyle, don't restructure). Restyle the card `<select>` with a custom
   chevron (`appearance: none` + background SVG).
7. **Summary**: total miles is the hero figure. Cap bars: thinner track, accent
   fill, and the low-remaining state becomes a `.low` class the JS toggles instead
   of the current hardcoded `#ff4d4d` inline style writes in `renderProgressBars()`
   (`script.js` ~lines 464–471) — this is required for dark mode to work. Keep the
   existing "draws down" semantics and the width transition.
8. **Transaction history**: do not touch the swipe-to-delete JS; preserve the
   `.tx-row` / `.swiped` / `.delete-bg` class contract and the 72px offset pairing
   between the CSS transform and delete-button width. Restyle rows: stacked
   date+time (already present), tabular numbers, hairline dividers. Add an empty
   state ("No purchases yet") rendered by `renderTransactions()` when the filtered
   list is empty — currently the card just sits blank.
9. **Settings**: promote the settings panel to a native `<dialog>` element styled
   as a sheet (plain HTML, no tooling; requires iOS 15.4+, acceptable). Replace
   `prompt()` for the new-card name with an inline input inside the dialog. Replace
   `alert()` validation failures in `saveSettings()` with an inline error line in
   the dialog. `confirm()` for destructive actions (remove card, reset) may stay —
   scope control.
10. **HTML hygiene**: add `<!DOCTYPE html>`, put `<meta charset>` first in `<head>`,
    remove every inline `style=""` (move to classes), add two `theme-color` metas
    with `media="(prefers-color-scheme: light|dark)"`, update `manifest.json`
    `background_color`/`theme_color` to the new palette, retitle the page
    "Ascent — Miles Tracker".
11. **Dark mode**: token overrides only — no second stylesheet. Audit that toasts,
    progress bars, the dialog, the select, and focus rings all read from tokens.
    The only JS-written inline colors are the progress-bar ones removed in (7).

**Tooling flag:** every item above is achievable in plain HTML/CSS/JS with zero new
tooling. Out of scope (would require tooling and is explicitly not wanted):
frameworks, bundling, CSS preprocessing, an icon system beyond the existing inline
SVGs.

### Key decisions / tradeoffs

- **Rewrite CSS rather than patch**: the accretion *is* the problem; patching a
  fourth layer on top would recreate it. The risk of a rewrite is contained because
  the JS↔CSS coupling surface is just class names (see Risks).
- **`script.js` logic stays untouched** — recommendation engine, split planner,
  state management, CSV export are correct and out of scope. JS edits are limited
  to: progress-bar class toggling (7), empty state (8), dialog open/close +
  inline validation (9), and the SW unregister from Workstream 2.
- **Native `<dialog>` over a hand-rolled overlay**: free focus trapping, Esc
  handling, and backdrop; the iOS 15.4+ floor is fine for two known users.

### Risks

- **Class-name coupling**: `script.js` builds DOM with specific class names
  (`.rec-*`, `.tx-*`, `.settings-*`, `.progress-*`, toast ids). Before deleting any
  CSS rule, grep `script.js` for every class it references and keep those names
  alive in the new stylesheet.
- **Swipe-to-delete regressions**: the most fragile interaction. Mitigation: don't
  modify its JS, keep the transform/width contract, and manually re-test swipe,
  tap-outside-to-close, delete, and undo.
- **Dark-mode leaks from JS-set inline styles**: the progress-bar writes are the
  only instance; decision (7) removes them.
- **iOS quirks reintroduced**: keep the ≥16px input font-size, safe-area padding,
  and `touch-action: manipulation` in the rewrite or focus-zoom/notch bugs return.

### Task list

1. `index.html` skeleton pass: DOCTYPE, head order, title, dual `theme-color`
   metas, app header markup, remove all inline styles, move the settings gear to
   the header, convert the settings panel container to `<dialog>`.
2. New `style.css` foundation: token layer (light + dark), reset, base typography,
   body/container layout, retained iOS layer (input font-size, safe areas,
   tap-highlight, touch-action).
3. Header/wordmark styles.
4. Add Purchase card: amount input, segmented category control, primary Add
   button, restyled card `<select>`.
5. Recommendation hero styles (single-card and split variants), preserving the
   existing `.rec-*` DOM contract.
6. Summary card: total-miles hero figure, cap bars; change `renderProgressBars()`
   in `script.js` to toggle a `.low` class instead of writing inline styles.
7. Transaction history: header row, row styles, swipe visuals (preserve contract),
   tabular numbers; add empty state in `renderTransactions()`.
8. Settings dialog: sheet styling, dialog open/close wiring in `script.js`
   (`showModal()`/`close()` replacing display toggling), inline new-card input
   replacing `prompt()`, inline validation message replacing `alert()` in
   `saveSettings()`.
9. Toasts (undo + added) restyled from tokens; footer simplified; bump version
   string to v4 / current date.
10. Update `manifest.json` colors. Full verification pass (below).

### Verification (applies to both workstreams)

Serve locally (the `.claude/` launch config runs a static server; equivalently
`python3 -m http.server` in the repo root) and exercise:

- Type an amount → recommendation appears, best card auto-selects; switch category →
  recommendation updates; manually change card → override respected until Add.
- Add purchases on both default cards (HSBC exact-earn and UOB $5-block rounding);
  totals, cap bars, and history update; cap-exceeded warning still fires.
- Enable overflow split in settings, enter an amount above the best card's
  remaining cap → split recommendation renders; Add logs one transaction per card.
- Swipe a row left → delete button; delete → undo toast → undo restores it.
- Settings: open dialog, add a card via inline input, trigger a validation error
  (blank name) → inline error shows, fix and Save → persists after reload.
- Export CSV; Reset (with export prompt) → clean default state.
- Toggle light/dark via OS or DevTools emulation — no hardcoded-color leaks,
  including toasts, bars, dialog, select.
- iPhone-width viewport (~390px): no horizontal scroll, comfortable tap targets.
- DevTools → Application: no service worker registered, Cache Storage empty.

---

## Execution order

1. **Workstream 2 first** (tasks are small and self-contained). Killing the
   stale-while-revalidate cache before UI work means every reload during the
   overhaul serves fresh CSS/JS — otherwise the old worker serves each edit one
   load late and verification can't be trusted.
2. **Workstream 1 second**, tasks 1–10 in order (foundation → components →
   interactions → polish).
3. **Deployment to Vercel is manual and owner-driven** via `VERCEL_DEPLOY.md` —
   not a task in this plan. Nothing in Workstream 1 depends on Workstream 2's code;
   the ordering is purely for a trustworthy dev loop.
