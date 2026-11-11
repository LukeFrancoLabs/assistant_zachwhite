#!/usr/bin/env node

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Port + profile can be overridden by env so the emailer can run its own browser
// (CDP 9324 / .browser-profile-email) alongside a texting browser (9323).
const PORT = parseInt(process.env.CDP_PORT, 10) || 9323;
const envProfile = process.env.PROFILE_DIR;
const PROFILE_DIR = envProfile
  ? (path.isAbsolute(envProfile) ? envProfile : path.join(__dirname, envProfile))
  : path.join(__dirname, '.browser-profile');

async function startBrowser() {
  try { execSync(`lsof -ti :${PORT} | xargs kill -9 2>/dev/null`, { stdio: 'ignore' }); } catch (_) {}
  await new Promise(r => setTimeout(r, 1000));

  const lockFile = path.join(PROFILE_DIR, 'SingletonLock');
  if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

  try {
    const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: [
        `--remote-debugging-port=${PORT}`,
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check'
      ],
      viewport: { width: 1920, height: 1080 }
    });

    const page = browser.pages()[0] || await browser.newPage();
    try { await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }); } catch (_) {}

    await new Promise(() => {});
  } catch (_) {
    process.exit(0);
  }
}

startBrowser().catch(() => process.exit(0));