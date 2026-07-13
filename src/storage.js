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

/**
 * Bulk version of isNew for a whole scrape result.
 *
 * The FIRST time a given scraperKey is ever seen (no prior state on disk),
 * every id found is recorded as seen but NONE are treated as "new" — this
 * prevents the bot from dumping a backlog of old articles (weeks/months of
 * history a page happens to list) as if they just happened. Only items
 * discovered on later runs, after this baseline exists, are reported as new.
 */
function filterNew(scraperKey, items, getId) {
  const data = load();
  const isFirstRun = !data[scraperKey];
  if (!data[scraperKey]) data[scraperKey] = [];

  const seenSet = new Set(data[scraperKey]);
  const fresh = [];

  for (const item of items) {
    const id = getId(item);
    if (!id || seenSet.has(id)) continue;
    seenSet.add(id);
    data[scraperKey].push(id);
    if (!isFirstRun) fresh.push(item);
  }

  if (data[scraperKey].length > 500) {
    data[scraperKey] = data[scraperKey].slice(-500);
  }
  save(data);

  if (isFirstRun && items.length > 0) {
    console.log(`[storage] First run for "${scraperKey}" — seeded ${items.length} existing item(s) as seen, none posted`);
  }

  return fresh;
}

module.exports = { isNew, filterNew };
