# assistant_zachwhite

Terminal tool for Zach White’s Housecall Pro outreach. Type `zw` to open Salesforce in a dedicated Chrome window, harvest accounts from your **campaign report**, and send emails or texts.

For the full walkthrough (first-run setup, Settings, troubleshooting), see [`START-HERE.md`](./START-HERE.md).

---

## Installation guide

### What you need

- A Mac with internet (Apple Silicon or Intel)
- Your Salesforce / Okta login
- **Node.js 18+**

### 1. Install Node.js (if needed)

Open **Terminal** and run:

```bash
node --version
```

You want `v18` or higher. If you get `command not found` (or an older version), install the LTS build from [nodejs.org](https://nodejs.org), then quit Terminal and open a new window.

### 2. Get this folder

**From GitHub (recommended):**

```bash
cd ~
git clone https://github.com/LukeFrancoLabs/assistant_zachwhite.git
cd ~/assistant_zachwhite
```

**Or from a zip:** unzip it, move the folder to your home directory so the path is `~/assistant_zachwhite`, then:

```bash
cd ~/assistant_zachwhite
```

### 3. Install dependencies (once)

```bash
cd ~/assistant_zachwhite
npm install
npx playwright install chromium
./install-zw.sh
```

- `npm install` — Node packages  
- `npx playwright install chromium` — the browser the tool drives (a few hundred MB)  
- `./install-zw.sh` — adds the `zw` command to your shell  

Then open a **new** Terminal window (or run `source ~/.zshrc`).

Check:

```bash
type zw
```

It should show an alias pointing at `…/assistant_zachwhite/run.sh`.

If macOS blocks files from the internet:

```bash
xattr -dr com.apple.quarantine ~/assistant_zachwhite
```

### 4. First practice run (nothing is sent)

```bash
zw --test
```

1. **First launch only:** enter your full name, first name, title, call/text numbers, booking link, and campaign report (this copy already offers the built-in report — confirm or paste another `/lightning/r/Report/…/view` link). Type `yes` to save.
2. Sign into Salesforce in the Chrome window that opens. Your campaign report loads by itself.
3. Press Enter in Terminal, pick a small range (e.g. `1-3`), and review drafts. **Nothing is sent** in `--test`.

### 5. Live run

```bash
zw
```

This **sends**. Always do `zw --test` first.

---

## Updating later

If you already cloned the repo and are on the feature branch:

```bash
cd ~/assistant_zachwhite
git pull
```

After the PR is merged to `main`:

```bash
cd ~/assistant_zachwhite
git checkout main
git pull
```

---

## Everyday commands

| Command | What it does |
|--------|----------------|
| `zw --test` | Practice email run — nothing sent |
| `zw` | Live email campaign |
| `zw --text` | Text campaign |
| `zw --settings` | Change name, numbers, campaign report, Claude drafts, text templates |

At the start screen: **Enter** = start, **S** = Settings.

---

## Defaults (this copy)

- **Campaign report** opens automatically (not an opportunity list view). Change it in Settings → line 7.
- **Claude drafts** are **off** — you pick a template. Turn on later in Settings → line 8 if you want Claude to write each message.
- Launch shows an **H → C → P** countdown (*do the work* / *enjoy the journey* / *champion the pro*).

---

## Common problems

| Problem | Fix |
|--------|-----|
| `command not found: zw` | New Terminal, or `source ~/.zshrc`, then re-run `./install-zw.sh` |
| `Cannot find module 'playwright'` | `cd ~/assistant_zachwhite && npm install` |
| Playwright browser missing | `cd ~/assistant_zachwhite && npx playwright install chromium` |
| Browser did not start in time | Close the tool’s Chrome, then `lsof -ti :9324 \| xargs kill -9` and try `zw --test` again |
| Wrong / missing report | `zw --settings` → line 7 → paste a `/lightning/r/Report/…/view` link |

Stop any run with **Ctrl-C**.

Keep these when you replace the folder: `sender.json`, `text-templates.json`, `.browser-profile-email`, and any `*.jsonl` logs.
