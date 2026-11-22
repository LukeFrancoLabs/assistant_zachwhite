# Outreach Assistant for the team

Personal day management for every AE — morning queue, replies, post-call kit, my leads, today’s log. **Not** Shark / LDS mass campaigns.

## What each rep gets

| Tab | Job |
|-----|-----|
| **Morning** | Holds, interested replies needing a follow-up, personal board due |
| **Replies** | Inbound replies this copy knows about |
| **Quick kit** | Day-after-demo email, book-demo text, soft follow-ups — copy a command |
| **My leads** | Hand-added follow-ups + next stage |
| **Today** | What already went out today |
| Sends / Templates / Scoreboard / DNC | Same as before |

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
3. Browser opens Outreach Assistant on localhost
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
zw                  → welcome menu + Outreach Assistant in the browser
Morning tab         → work the queue
Quick kit           → after a call/demo, copy a send command
My leads            → add the account after a good conversation
```

Add a lead from the terminal:

```bash
node textLog.js --add-lead <Salesforce account URL> --tag referral --did email,text,call
```

---

## Your own Outreach Assistant

Same app — just run `zw`. Shark / report / Claude-off tooling stays on your copy; reps mostly live in Morning → Kit → My leads.
