# Pipeline Assistant for the team

Personal day management for every AE — morning queue, replies, post-call kit, my leads, today’s log. **Not** Shark / LDS mass campaigns.

## What each rep gets

| Tab | Job |
|-----|-----|
| **Morning** | Holds, interested replies needing a follow-up, personal board due |
| **Replies** | Inbound replies this copy knows about |
| **Quick kit** | Day-after-demo email, book-demo text, soft follow-ups — copy a command |
| **My leads** | Hand-added follow-ups + next stage |
| **Board** | Default **HVAC board** as an n8n-style flow graph (nodes + day gaps). Also Post-demo, Nurture, Plumbing / Electrical, cold drip — switch pack, edit Day/template |
| **Content** | Sales Content Finder library — filter by trade / need / competitor, copy link or subject |
| **Today** | What already went out today |
| Sends / Templates / Scoreboard / DNC | Same as before |

**Nurture until reconnect:** Pro says “talk in summer” and it’s fall? **Move to Nurture** and pick **summer** (or june / 2026-06-01 / 90 days). Touches stay **quiet** early, **ramp** in the last ~45 days before that date, then they land on **Re-engage** (`#reengage`). CLI: `node textLog.js --nurture-lead <SF link> --until summer` · preview plan: `node nurtureSchedule.js summer` · sweep: `node textLog.js --graduate-nurture`.

Opens are not tracked (no pixels). Replies need a one-time Gmail feed per machine (`node replyPoller.js --setup`).

---

## Install a copy for a rep (you, on their laptop or a shared folder)

From this repo:

```bash
./install-for-rep.sh "Zach White"
# or a specific folder:
./install-for-rep.sh "Zach White" ~/assistant_zach
```

That copies the project, runs `npm install`, Playwright Chromium, pulls shared templates, writes a starter `sender.json`, and installs the `zw` alias.

Hand them:

1. New terminal → `zw`
2. Settings → booking link + phone
3. Browser opens Pipeline Assistant on localhost
4. Optional replies: `node replyPoller.js --setup`
5. When you change team templates: `node teamSync.js --pull`

---

## Manage templates / kit remotely

You edit once; every machine pulls.

### Option A — git (simplest)

1. Edit `team-shared/day-desk.json` (kit) and/or pack email templates:
   ```bash
   node teamSync.js --pack
   ```
2. Commit + push.
3. On each rep machine:
   ```bash
   git pull
   node teamSync.js --pull
   ```

### Option B — Dropbox / Google Drive (no git for them)

1. Put a folder somewhere both of you can see, e.g. `~/Dropbox/assistant-team/`
2. On **your** machine, publish into it:
   ```bash
   export ASSISTANT_TEAM_SHARED=~/Dropbox/assistant-team
   node teamSync.js --pack
   ```
3. On **their** machine (once, or in their shell profile):
   ```bash
   export ASSISTANT_TEAM_SHARED=~/Dropbox/assistant-team
   node teamSync.js --pull
   ```
4. Re-run `--pull` whenever you tell them you updated (or add it to their morning habit).

`install-for-rep.sh` respects `ASSISTANT_TEAM_SHARED` if set when you install.

### What is managed

Listed in `team-shared/manifest.json`:

- `day-desk.json` — Quick kit buttons
- `email-templates.json` / `email-menu.json` — email copy + menu

Per-rep `sender.json` (name, booking link, phone, text overrides) is **never** overwritten by sync.

---

## Day-to-day for a rep

```text
zw                  → welcome menu + Pipeline Assistant in the browser
zwdemo              → director demo — filled Morning / Today / My leads (mock data, port 9341)
Morning tab         → work the queue
Quick kit           → after a call/demo, copy a send command
My leads            → add the account after a good conversation
```

### Director walkthrough (`zwdemo`)

```bash
zwdemo
# or:  node outreachDashboard.js --demo
```

Opens **http://127.0.0.1:9341/** with a blue DEMO banner and mock HVAC shops, holds, interested replies, nurture → re-engage, and a full Today / Sends log. Nothing is written to real logs; live `zw` stays on port 9340.

Add a lead from the terminal:

```bash
node textLog.js --add-lead <Salesforce account URL> --tag referral --did email,text,call
```

---

## Content library (Sales Content Finder)

Snapshot of [hcp-brand-content Sales Content Finder](https://hcp-brand-content.github.io/sales-content-finder/) — every trade × need path scored the same way as the site.

```bash
node syncContentLibrary.js   # refresh content-library/ + email-content.json
```

Browse in the **Content** tab, or pull assets into emails via `contentPicker.js` / `--library`.

---

## Your own Pipeline Assistant

Same app — just run `zw`. Shark / report / Claude-off tooling stays on your copy; reps mostly live in Morning → Kit → My leads.

### Mac Mini not updating? (`file://…/outreach-dashboard/index.html`)

That URL is the **old static page** from `main`. Pipeline Assistant needs localhost + the feature branch:

```bash
cd ~/assistant_zachwhite
git fetch origin
git checkout cursor/nurture-slow-drip-bcc4   # or cursor/claude-off-full-list-harvest-ed5f after nurture merges
git pull
node outreachDashboard.js --serve           # leave this running, OR just run zw (it starts serve)
```

You should see **http://127.0.0.1:9340/** with Morning / Board / Content / My leads — not a `file://` path. If serve fails, check `outreach-dashboard/server.log`.
