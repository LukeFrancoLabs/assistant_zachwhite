# assistant_zachwhite: set up on your MacBook (about 15 minutes, once)

You start the tool by typing `zw` in Terminal. It opens its own browser window, you sign in to Salesforce there, and it works through your **campaign Salesforce report**. A short install guide also lives in [`README.md`](./README.md).

## What you need
- A Mac with internet (Apple Silicon or Intel).
- Your Salesforce login (the same Okta sign-in you use every day).
- Your campaign report is already set for this copy (change it later in Settings → line 7 if needed).
- Node.js 18 or newer (step 1).

## 1. Check Node.js
Open **Terminal** (press Cmd-Space, type Terminal, press Enter) and run:

```
node --version
```

If it prints v18 or higher, go to step 2. If it says "command not found" (or a lower number), install the LTS version from https://nodejs.org (download the macOS installer and click through it), then **close Terminal, open a new one**, and run the check again.

## 2. Put the folder in your home folder
Double-click the zip. Move the folder it makes, `assistant_zachwhite`, to your home folder so that its path is `~/assistant_zachwhite` (in Finder: Go > Home). Or in Terminal, if the zip is in Downloads:

```
unzip ~/Downloads/assistant_zachwhite.zip -d ~/
```

Or clone from GitHub:

```
cd ~
git clone https://github.com/LukeFrancoLabs/assistant_zachwhite.git
```

## 3. Install what it needs (once)

```
cd ~/assistant_zachwhite
npm install
npx playwright install chromium
./install-zw.sh
```

`npx playwright install chromium` downloads the browser the tool drives (a few hundred MB, a few minutes). Notices from `npm install` are normal. If macOS says a file is from an unidentified developer, run `xattr -dr com.apple.quarantine ~/assistant_zachwhite` and try again.

`./install-zw.sh` makes the `zw` command (an alias to this folder’s `run.sh`). After it finishes, open a **new** Terminal window (or run `source ~/.zshrc`).

Check it: `type zw` should say `zw` is an alias for `.../assistant_zachwhite/run.sh`. (macOS uses zsh. If `echo $SHELL` shows /bin/bash, the installer writes to `~/.bash_profile` instead.)

## 4. First run: set up your name, then a practice run (nothing is sent)

```
zw --test
```

**The very first time**, a setup screen opens first and asks for your details, one at a time: your full name (exactly as Salesforce shows it on your texts), your first name (what your texts call you), your job title, your call number, your text number, your booking link and your **campaign report** (this copy already offers the built-in report — confirm it or paste another `/lightning/r/Report/…/view` link). Then it shows everything, with your email signature exactly as it will be sent, and asks you to check every letter: type `yes` to save, or the number of a line to fix it (pressing Enter alone does not save). You do this once: it is saved in `sender.json` and never asked again.

Then a colored **H → C → P** countdown shows while the browser finishes loading (**do the work** / **enjoy the journey** / **champion the pro**), then a welcome message. In the browser window that opened, sign in to Salesforce. Your **campaign report** opens by itself (and the tool scrolls its virtualized grid the same way as report mode). Back in Terminal press Enter and give a small range such as 1-3. The tool reads each account in that range (see **How the messages are written** below), and you read every draft before anything goes out. In `--test` the tool fills in each email on the account page and stops: **nothing is sent.**

Your Salesforce login is saved in `~/assistant_zachwhite/.browser-profile-email`, so next time you will not have to sign in again (until Salesforce signs you out).

## 5. A real run
`zw` with no flags is **live: it sends.** Do a practice run first. It asks once, after it has shown you every drafted email: type `y` to send.

## How the messages are written
By default, `zw` (emails) and `zw --text` (texts) use a **ready-made template** you pick — no Claude required. Before each send the tool still opens the account and reads **Customer Status (beta)**: an account that is "Enrolled: …" (for example "Enrolled: Current Customer") is a current customer and is never contacted, unless it is only on the free Invoicing and Payments plan.

To let **Claude** write each message from that account's Salesforce notes and opportunities instead, open Settings (`S` when `zw` starts, or `zw --settings`), set **Claude drafts** to **on**, then run again. That needs **Claude Code** installed and signed in: run `claude auth login --sso` once and finish the sign-in in the browser. Nothing is sent until you have seen every draft and typed `y`. Turn Claude drafts back **off** in Settings to return to templates.

Giving your own wording with `--message "…"` or `--template N` (texts), or `--email-template` (emails), also skips Claude. So does `--no-auto`.

## Current customers are never contacted
In every mode, right before the tool texts or emails an account, it reads that account's **Customer Status (beta)** on its page. An account that is "Enrolled: …" (for example "Enrolled: Current Customer") is a current customer: it is skipped and put on the held list, so no other mode contacts it either. The one exception is an account that is only on the free Invoicing and Payments plan, which is still ours to sell. If the field is not on the page, the tool says so, writes the account down in `status-checks.jsonl` and carries on, unless the account is already on the held list.

## Changing your details later
Every time you start `zw`, a small box shows who you are sending as and which report will open: press **Enter** to start, or type **S** and press Enter for **Settings**, where you can change any line (your **campaign report** is line 7; **Claude drafts** is line 8, off by default), check the result and confirm it. `zw --settings` opens Settings straight away. A change applies from the next run.

## Changing your text messages
The text campaign (`zw --text`) offers ready-made texts to pick from when Claude drafts are off (the default). To read them or change their wording, type **S** when `zw` starts (or run `zw --settings`), then **T**. Pick a text by its number, then **e** to change its wording (finish with a line that says `END`), check the preview, and type `yes` to save. A ready-made text keeps its name. `<first name>`, `<full name>`, `<call number>`, `<text number>` and `<booking link>` are filled in from your own details when a text is sent, so type them where your details go. You can also write a new text with **n** (it needs a name no other text has), put a changed text back to the original with **r**, or remove one of your own with **x**. Your changes are saved in `text-templates.json` and apply from the next run.

You can also edit them in the browser: when `zw` starts it opens **http://127.0.0.1:9340/** — use the **Templates** tab for every text and email template (Edit → Save). Edits apply on the next launch.

## Analytics, replies, and Gmail
The **Analytics** tab on **http://127.0.0.1:9340/** shows what this copy sent (always) and what pros replied (only after a Gmail feed writes `replies.jsonl`).

- **Sends** — automatic. Every text/email `zw` actually sends is logged.
- **Replies** — need a Gmail poller. When a pro texts back, SMS-Magic emails your Gmail; when they reply to an outreach email, that lands in Gmail too. Luke’s Mac runs a Claude Desktop Gmail connector on a schedule and pipes those messages into `optOut.js`. A rep’s Mac does **not** get that unless you set it up. Run `node replyPoller.js --setup` for the steps (Claude Desktop connector, or a one-shot JSON ingest: `node replyPoller.js --sms emails.json` / `--email emails.json`). Then refresh Analytics.
- **Opens** — not tracked. Gmail does not tell this tool who opened mail, and Salesforce Lightning email opens are not wired in. Do not expect an “opened” column.

Check what is on disk: `node replyPoller.js --status`. Ambiguous matches: `node optOut.js --review`.

## Your outreach data log
Every text and email this tool actually sends is also saved, one line each, in `outreach-data-log.jsonl` in this folder: when it went out, to whom, what was sent, and who sent it from which computer (your name from `sender.json` and this computer's name). It is your own record and it stays on this computer: nothing uploads it. The outreach page at **http://127.0.0.1:9340/** (Sends / Templates / Analytics) opens when you start `zw`. A practice run (`--test` or `--dry-run`) sends nothing, so it adds nothing. Keep the file when you are given a new version of the folder; to start a fresh log, quit the tool and delete the file.

## If something goes wrong
- "command not found: zw": open a new Terminal window, or run `source ~/.zshrc`, and redo `./install-zw.sh` from `~/assistant_zachwhite`.
- "Cannot find module 'playwright'": run `cd ~/assistant_zachwhite && npm install`.
- "Executable doesn't exist at .../ms-playwright/...": run `cd ~/assistant_zachwhite && npx playwright install chromium`.
- "Browser did not start in time": close the tool's browser window, run `lsof -ti :9324 | xargs kill -9`, then `zw --test` again.
- Your report does not open, or Salesforce says you cannot see it: run `zw --settings`, choose line 7 and paste the address of the Salesforce report you want (copy it from the address bar while that report is showing). It has to be a `/lightning/r/Report/…/view` link.
- Salesforce opens on the wrong report: run `zw --settings` and set line 7 to the report you want.
- It asks for your name, numbers and list again: `sender.json` did not come along when the folder was replaced by a new version. Type them in again, once.
- A text you changed shows its built-in wording again, and a warning line appears when you start `zw`: `text-templates.json` did not come along with the folder, or that text is not a good text any more. Open Settings (`S`, then `T`), look at it, and write it again.
- "Claude (cli) isn't answering": Claude drafts are on in Settings but Claude Code is not signed in. Run `claude auth login --sso`, finish the sign-in in the browser, then run again — or set **Claude drafts** to **off** in Settings to use a template (no Claude).
- Stop a run any time with Ctrl-C.

Your name, numbers and booking link in every text and email, and the report that opens by itself, come from `sender.json`, which the setup screen writes (change them in Settings). What you send is recorded in files ending in `.jsonl` in this folder: keep them (and `sender.json`, `text-templates.json` and `.browser-profile-email`) when you are given a new version of the folder.
