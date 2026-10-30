/**
 * scrape.js
 *
 * Pulls upcoming fete listings from IslandETickets and writes them into
 * fetes.json in the exact shape the site (index.html) expects:
 *   {id, y, m, d, name, promoter, venue, cat, price, desc, img}
 * Note: m is zero-indexed, same as JS Date (January = 0).
 *
 * Requires Node 18+ (built-in fetch). No external dependencies.
 */

const fs = require('fs');

const SOURCE_HOME = 'https://islandetickets.com/';
const OUTPUT_FILE = 'fetes.json';
const MAX_EVENTS = 1000;      // safety ceiling only. The homepage lists ~450+ events running
                               // into late 2027, and events are in date order, so a low cap
                               // silently chops off the NEWEST dates (Carnival 2027). Keep this
                               // well above the real total.
const REQUEST_DELAY_MS = 400; // small pause between requests so we don't hammer the site

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// ---------- small helpers ----------

function sleep(ms){ return new Promise(res => setTimeout(res, ms)); }

function stripTags(html){
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url){
  const res = await fetch(url, {
    headers: { 'User-Agent': 'FeteSideBot/1.0 (+fete calendar aggregator)' }
  });
  if(!res.ok) throw new Error(`Request failed (${res.status}) for ${url}`);
  return await res.text();
}

// Pulls the date directly from the event's own page via its JSON-LD
// structured data ("startDate"). More reliable than the homepage's
// month headings.
function extractStructuredDate(html){
  const m = html.match(/"startDate"\s*:\s*"(\d{4})-(\d{2})-(\d{2})/);
  if(!m) return null;
  return { y: parseInt(m[1],10), m: parseInt(m[2],10) - 1, d: parseInt(m[3],10) };
}

// Guess a category from the event name + description.
function inferCategory(name, desc){
  const text = (name + ' ' + desc).toLowerCase();
  if(/\bcooler\b/.test(text)) return 'cooler';
  if(/all[\s-]?inclusive/.test(text)) return 'allincl';
  if(/\b(launch|reveal)\b/.test(text)) return 'launch';
  if(/\b(cruise|boat ?ride|raft ?up|sail)\b/.test(text)) return 'boat';
  if(/\bfree\b/.test(text)) return 'free';
  return 'other';
}

// ---------- geo filter: only keep events in Trinidad & Tobago ----------

const TT_KEYWORDS = [
  'trinidad', 'tobago', 'port of spain', 'san fernando', 'chaguanas',
  'arima', 'point fortin', 'chaguaramas', 'diego martin', 'trincity',
  'movietowne', 'woodbrook', 'st. james', 'st james', 'arouca', 'couva',
  'siparia', 'penal', 'sangre grande', 'tunapuna', 'valsayn', 'maraval',
  'petit valley', 'westmoorings', 'carenage', 'laventille', 'barataria',
  'curepe', 'st augustine', 'st. augustine', 'queen\'s park savannah',
  'queens park savannah', 'skinner park', 'camp ogden', 'ariapita',
  'woodford square', 'nelson mandela park', 'harbour master', 'harbor master',
  'ocean pelican', 'chaquacabana', 'centre of excellence',
  'center of excellence', 'hart\'s cut', 'harts cut', 'anchorage',
  'valpark', 'x lounge', 'vice nightclub', 'queen\'s hall',
  'queens hall', 'napa', 'sapa', 'hasely crawford', 'performing arts (napa)',
  'performing arts (sapa)', 'gasparillo', 'cocorite', 'debe', 'talparo',
  'cumuto', 'longdenville', 'mayaro', 'st. anns', 'st anns', 'moka',
  'mt. lambert', 'toco', 'cunupia', 'macoya', 'cascadia', 'la romaine',
  'gulf city', 'crown point', 'scarborough', 'bacolet', 'buccoo',
  'pigeon point', 'lowlands', 'mount irvine', 'bon accord'
];

const FOREIGN_KEYWORDS = [
  'toronto', 'brampton', 'mississauga', 'scarborough, on', 'ajax, on', 'ontario',
  'brooklyn', 'new york', 'nyc', 'queens,', 'manhattan', 'bronx',
  'miami', 'orlando', 'florida', 'fort lauderdale', 'davie, fl', 'davie fl',
  'atlanta', 'houston', 'texas', 'boston', 'rowes wharf', 'new orleans',
  'bayou classic', 'south beach', 'biscayne',
  'london', 'united kingdom', 'birmingham', 'manchester',
  'caribana', 'notting hill',
  'barbados', 'providenciales', 'turks and caicos', 'turks & caicos'
];

// Checks the VENUE first (ground truth), then falls back to the NAME.
function isTrinidadEvent(name, venue){
  const venueText = venue.toLowerCase();
  if(FOREIGN_KEYWORDS.some(kw => venueText.includes(kw))) return false;
  if(TT_KEYWORDS.some(kw => venueText.includes(kw))) return true;

  const nameText = name.toLowerCase();
  if(FOREIGN_KEYWORDS.some(kw => nameText.includes(kw))) return false;
  if(TT_KEYWORDS.some(kw => nameText.includes(kw))) return true;

  console.warn(`  ? Couldn't confirm location for "${name}" @ "${venue}" — included by default, please verify.`);
  return true;
}

// ---------- step 1: pull the list of upcoming events from the homepage ----------

async function getEventList(){
  const html = await fetchText(SOURCE_HOME);

  const monthHeadingRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*[^0-9<]{0,15}(\d{4})/g;
  const eventLinkRe = /<a[^>]+href="([^"]*\/event\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/g;

  const markers = [];
  let m;
  while((m = monthHeadingRe.exec(html))){
    const monthIdx = MONTHS.indexOf(m[1].slice(0,3).toLowerCase());
    markers.push({ index: m.index, type: 'month', y: parseInt(m[2],10), m: monthIdx });
  }
  while((m = eventLinkRe.exec(html))){
    markers.push({ index: m.index, type: 'event', url: m[1], raw: stripTags(m[2]) });
  }
  markers.sort((a,b) => a.index - b.index);

  const events = [];
  let currentYear = null, currentMonth = null;

  for(const marker of markers){
    if(marker.type === 'month'){
      currentYear = marker.y;
      currentMonth = marker.m;
      continue;
    }
    if(currentYear === null) continue;

    const dayMatch = marker.raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+/);
    if(!dayMatch) continue;
    const day = parseInt(dayMatch[1], 10);
    let rest = marker.raw.slice(dayMatch[0].length);

    rest = rest.replace(/\s*(Generic placeholder image)?\s*$/i, '');

    const detailMatch = rest.match(/^(.*?)\s+Hosted by\s+(.*?)\s+@\s+(.*?)\s+\d{1,2}:\d{2}(?:am|pm)\s*-\s*\d{1,2}:\d{2}(?:am|pm)/i);
    if(!detailMatch) continue;

    const [, name, promoter, venue] = detailMatch;
    if(!name || !marker.url) continue;

    if(!isTrinidadEvent(name.trim(), venue.trim())){
      console.log(`  x Skipping non-Trinidad event: "${name.trim()}" @ ${venue.trim()}`);
      continue;
    }

    events.push({
      url: marker.url.startsWith('http') ? marker.url : new URL(marker.url, SOURCE_HOME).href,
      name: name.trim(),
      promoter: promoter.trim(),
      venue: venue.trim(),
      y: currentYear,
      m: currentMonth,
      d: day
    });

    if(events.length >= MAX_EVENTS){
      console.warn(`!! Hit MAX_EVENTS (${MAX_EVENTS}) — later events were NOT scraped. Raise the cap.`);
      break;
    }
  }

  return events;
}

// ---------- step 2: visit each event's own page for the flyer image + description ----------

async function enrichEvent(basicEvent){
  try{
    const html = await fetchText(basicEvent.url);

    const imgMatch = html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i)
                   || html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/i);
    const descMatch = html.match(/Description\s*<\/h[1-6]>\s*([\s\S]{0,600}?)(?:##|<h[1-6])/i);
    const priceMatch = html.match(/\$\s?[\d,]+(\.\d{2})?\s?(USD|TTD)?/i);

    const structuredDate = extractStructuredDate(html);
    if(structuredDate){
      console.log(`    date confirmed from event page: ${structuredDate.y}-${structuredDate.m+1}-${structuredDate.d}`);
    } else {
      console.warn(`    ! no structured date found on page — keeping homepage-derived date (${basicEvent.y}-${basicEvent.m+1}-${basicEvent.d}), please spot-check this one`);
    }

    return {
      ...basicEvent,
      ...(structuredDate || {}),
      img: imgMatch ? imgMatch[1] : null,
      desc: descMatch ? stripTags(descMatch[1]).slice(0, 300) : '',
      price: priceMatch ? priceMatch[0] : 'See ticket link'
    };
  }catch(err){
    console.error(`  ! Couldn't enrich ${basicEvent.name}:`, err.message);
    return { ...basicEvent, img: null, desc: '', price: 'See ticket link' };
  }
}

// ---------- main ----------

async function main(){
  console.log('Fetching event list from', SOURCE_HOME);
  const basicEvents = await getEventList();
  console.log(`Found ${basicEvents.length} candidate events on the homepage.`);

  const enriched = [];
  for(const [i, ev] of basicEvents.entries()){
    console.log(`(${i+1}/${basicEvents.length}) ${ev.name}`);
    const full = await enrichEvent(ev);
    enriched.push(full);
    await sleep(REQUEST_DELAY_MS);
  }

  const fetes = enriched.map((ev, idx) => ({
    id: idx + 1,
    y: ev.y,
    m: ev.m,
    d: ev.d,
    name: ev.name,
    promoter: ev.promoter,
    venue: ev.venue,
    cat: inferCategory(ev.name, ev.desc || ''),
    price: ev.price,
    desc: ev.desc || '',
    img: ev.img || `https://picsum.photos/seed/fete${idx+1}/500/650`,
    ticketUrl: ev.url
  }));

  // SAFETY NET: never overwrite a working fetes.json with an empty one.
  if(fetes.length === 0){
    console.error('No events parsed — leaving the existing fetes.json untouched.');
    process.exit(1);
  }

  // Keep the file in date order, then re-number ids.
  fetes.sort((a,b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d));
  fetes.forEach((f, i) => { f.id = i + 1; });

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fetes, null, 2));
  console.log(`Wrote ${fetes.length} events to ${OUTPUT_FILE}`);

  // Per-month coverage report — check this in the Actions log.
  const counts = {};
  for(const f of fetes){
    const key = `${f.y}-${String(f.m+1).padStart(2,'0')}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  console.log('Events per month:');
  Object.keys(counts).sort().forEach(k => console.log(`  ${k}: ${counts[k]}`));
}

main().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
