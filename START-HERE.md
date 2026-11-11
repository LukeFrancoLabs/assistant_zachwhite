# Assistant: set up on your MacBook (about 15 minutes, once)

You start the email tool by typing `email` in Terminal. It opens its own browser window, you sign in to Salesforce there, and it works through your pipeline list.

## What you need
- A Mac with internet (Apple Silicon or Intel).
- Your Salesforce login (the same Okta sign-in you use every day).
- The address of your pipeline list in Salesforce (the Opportunities list you work from). Open it in your usual browser and keep that tab open: the setup in step 5 asks you to paste its address.
- Node.js 18 or newer (step 1).

## 1. Check Node.js
Open **Terminal** (press Cmd-Space, type Terminal, press Enter) and run:

```
node --version
```

If it prints v18 or higher, go to step 2. If it says "command not found" (or a lower number), install the LTS version from https://nodejs.org (download the macOS installer and click through it), then **close Terminal, open a new one**, and run the check again.

## 2. Put the folder in your home folder
Double-click the zip. Move the folder it makes, `Assistant`, to your home folder so that its path is `~/Assistant` (in Finder: Go > Home). Or in Terminal, if the zip is in Downloads:

```
unzip ~/Downloads/Assistant.zip -d ~/
```

## 3. Install what it needs (once)

```
cd ~/Assistant
npm install
npx playwright install chromium
chmod +x run.sh
```

`npx playwright install chromium` downloads the browser the tool drives (a few hundred MB, a few minutes). Notices from `npm install` are normal. If macOS says a file is from an unidentified developer, run `xattr -dr com.apple.quarantine ~/Assistant` and try again.

## 4. Make the `email` command

```
printf "\nalias email='%s/Assistant/run.sh'\n" "$HOME" >> ~/.zshrc
source ~/.zshrc
```

Check it: `type email` should say "email is an alias for ...Assistant/run.sh". (macOS uses zsh. If `echo $SHELL` shows /bin/bash, use `~/.bash_profile` instead of `~/.zshrc`.)

## 5. First run: set up your name, then a practice run (nothing is sent)

```
email --test
```

**The very first time**, a setup screen opens first and asks for your details, one at a time: your full name (exactly as Salesforce shows it on your texts), your first name (what your texts call you), your job title, your call number, your text number, your booking link and your **pipeline list**. For the list, open the list you work from in Salesforce in your usual browser, copy the whole address from the address bar and paste it in: it has to be a list of **Opportunities**, and it has to be YOUR list, not a teammate's. Then it shows everything, with your email signature exactly as it will be sent, and asks you to check every letter: type `yes` to save, or the number of a line to fix it (pressing Enter alone does not save). You do this once: it is saved in `sender.json` and never asked again.

Then a green $ shows while the browser loads, then a welcome message. In the browser window that opened, sign in to Salesforce. Your pipeline list opens by itself. Back in Terminal press Enter and give a small range such as 1-3. The tool reads each account in that range and writes its email for you (see **How the messages are written** below), and you read every draft before anything goes out. In `--test` the tool fills in each email on the account page and stops: **nothing is sent.**

Your Salesforce login is saved in `~/Assistant/.browser-profile-email`, so next time you will not have to sign in again (until Salesforce signs you out).

## 6. A real run
`email` with no flags is **live: it sends.** Do a practice run first. It asks once, after it has shown you every drafted email: type `y` to send.

## How the messages are written
`email` (emails) and `email --text` (texts) do not ask you to pick a template any more. For each account in your range the tool reads its Salesforce opportunities and notes (a note titled **Granola** that you wrote comes first), has Claude write that account's message from what it read, checks every claim in it against those notes, and prints the draft. Nothing is sent until you have seen all of them and typed `y`. Before it reads anything for an account it opens the account and reads **Customer Status (beta)**: an account that is "Enrolled: …" (for example "Enrolled: Current Customer") is a current customer and is never contacted, unless it is only on the free Invoicing and Payments plan. A draft that fails the checks, an account closed-won in the last 30 days and anyone marked do-not-contact are also left out and listed. Each account takes a minute or two.

This needs **Claude Code** installed and signed in on this Mac: run `claude auth login --sso` once and finish the sign-in in the browser. If it is not signed in, the tool says so before it reads anything.

To pick a ready-made email or text yourself instead, add `--no-auto` (`email --no-auto`, `email --text --no-auto`). Giving your own wording with `--message "…"` or `--template N` (texts), or `--email-template` (emails), also skips the writing.

## Current customers are never contacted
In every mode, right before the tool texts or emails an account, it reads that account's **Customer Status (beta)** on its page. An account that is "Enrolled: …" (for example "Enrolled: Current Customer") is a current customer: it is skipped and put on the held list, so no other mode contacts it either. The one exception is an account that is only on the free Invoicing and Payments plan, which is still ours to sell. If the field is not on the page, the tool says so, writes the account down in `status-checks.jsonl` and carries on, unless the account is already on the held list.

## Changing your details later
Every time you start `email`, a small box shows who you are sending as and which list will open: press **Enter** to start, or type **S** and press Enter for **Settings**, where you can change any line (your pipeline list is line 7), check the result and confirm it. `email --settings` opens Settings straight away. A change applies from the next run.

## Changing your text messages
With `--no-auto` (or `--template N`), the text campaign (`email --text`) offers ready-made texts to pick from. To read them or change their wording, type **S** when `email` starts (or run `email --settings`), then **T**. Pick a text by its number, then **e** to change its wording (finish with a line that says `END`), check the preview, and type `yes` to save. A ready-made text keeps its name. `<first name>`, `<full name>`, `<call number>`, `<text number>` and `<booking link>` are filled in from your own details when a text is sent, so type them where your details go. You can also write a new text with **n** (it needs a name no other text has), put a changed text back to the original with **r**, or remove one of your own with **x**. Your changes are saved in `text-templates.json` and apply from the next run.

## Your outreach data log
Every text and email this tool actually sends is also saved, one line each, in `outreach-data-log.jsonl` in this folder: when it went out, to whom, what was sent, and who sent it from which computer (your name from `sender.json` and this computer's name). It is your own record and it stays on this computer: nothing uploads it. The outreach page (the local page that opens in your browser when you start `email`) says at the bottom how many sends it holds. A practice run (`--test` or `--dry-run`) sends nothing, so it adds nothing. Keep the file when you are given a new version of the folder; to start a fresh log, quit the tool and delete the file.

## If something goes wrong
- "command not found: email": open a new Terminal window, or run `source ~/.zshrc`, and redo step 4.
- "Cannot find module 'playwright'": run `cd ~/Assistant && npm install`.
- "Executable doesn't exist at .../ms-playwright/...": run `cd ~/Assistant && npx playwright install chromium`.
- "Browser did not start in time": close the tool's browser window, run `lsof -ti :9324 | xargs kill -9`, then `email --test` again.
- Your list does not open, or Salesforce says you cannot see it: run `email --settings`, choose line 7 and paste the address of a list you can open (copy it from the address bar while that list is showing in your usual browser). It has to be a list of Opportunities.
- Salesforce opens on a list you did not choose (your recently viewed opportunities): no pipeline list is saved yet. Run `email --settings` and set line 7.
- It asks for your name, numbers and list again: `sender.json` did not come along when the folder was replaced by a new version. Type them in again, once.
- A text you changed shows its built-in wording again, and a warning line appears when you start `email`: `text-templates.json` did not come along with the folder, or that text is not a good text any more. Open Settings (`S`, then `T`), look at it, and write it again.
- "Claude (cli) isn't answering": run `claude auth login --sso`, finish the sign-in in the browser, then run the same command again. Nothing was read or sent. Or add `--no-auto` to use a template, which needs no Claude.
- Stop a run any time with Ctrl-C.

Your name, numbers and booking link in every text and email, and the list that opens by itself, come from `sender.json`, which the setup screen writes (change them in Settings). What you send is recorded in files ending in `.jsonl` in this folder: keep them (and `sender.json`, `text-templates.json` and `.browser-profile-email`) when you are given a new version of the folder.
