# Pipeline Assistant for the team

Personal day management for every AE — morning queue, replies, post-call kit, my leads, today’s log. **Not** Shark / LDS mass campaigns.

## What each rep gets

| Tab | Job |
|-----|-----|
| **Morning** | Holds, interested replies needing a follow-up, personal board due |
| **Replies** | Inbound replies this copy knows about |
| **Quick kit** | Day-after-demo email, book-demo text, soft follow-ups — copy a command |
| **My leads** | Hand-added follow-ups + next stage |
| **Board** | Modular boards — Post-demo, **Nurture (slow ~90-day)**, **HVAC / Plumbing / Electrical** 2-week drips, cold drip; change **Day** + template per outreach |
| **Content** | Sales Content Finder library — filter by trade / need / competitor, copy link or subject |
| **Today** | What already went out today |
| Sends / Templates / Scoreboard / DNC | Same as before |

**Nurture (slow drip):** On **My leads**, hit **Move to Nurture** when an opp isn’t ready. That tags `#nurture`, puts them on the ~90-day soft board, and sets an **expiration date** (default 90 days). When it expires they leave Nurture and land on the **Re-engage** list (`#reengage`) — Morning + My leads surface them for a fresh push. CLI: `node textLog.js --nurture-lead <SF link> [--expires-days 90]` · force the sweep: `node textLog.js --graduate-nurture`.

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
Morning tab         → work the queue
Quick kit           → after a call/demo, copy a send command
My leads            → add the account after a good conversation
```

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
