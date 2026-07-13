const puppeteer = require('puppeteer');
const { execSync } = require('child_process');

let chromiumPath = null;

function getChromiumPath() {
  if (chromiumPath) return chromiumPath;
  try {
    chromiumPath = execSync('which chromium', { encoding: 'utf8' }).trim();
    return chromiumPath;
  } catch {
    return null; // use puppeteer's bundled chrome
  }
}

const LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
];

/**
 * Launch a puppeteer browser using system Chromium when available.
 */
async function launchBrowser() {
  const opts = { headless: true, args: LAUNCH_ARGS };
  const path = getChromiumPath();
  if (path) opts.executablePath = path;
  return puppeteer.launch(opts);
}

module.exports = { launchBrowser };
