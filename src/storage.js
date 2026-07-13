const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'seen.json');

function load() {
  try {
    if (!fs.existsSync(DATA_FILE)) return {};
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function save(data) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

/**
 * Returns true if this id is new (not seen before) for the given scraper key.
 * Automatically marks it as seen.
 */
function isNew(scraperKey, id) {
  const data = load();
  if (!data[scraperKey]) data[scraperKey] = [];
  if (data[scraperKey].includes(id)) return false;
  data[scraperKey].push(id);
  // Keep only the last 500 IDs per scraper
  if (data[scraperKey].length > 500) {
    data[scraperKey] = data[scraperKey].slice(-500);
  }
  save(data);
  return true;
}

module.exports = { isNew };
