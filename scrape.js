/**
 * scrape.js
 *
 * Pulls upcoming fete listings from IslandETickets and writes them into
 * fetes.json in the exact shape the site (index.html) expects:
 *   {id, y, m, d, name, promoter, venue, cat, price, desc, img}
 * Note: m is zero-indexed, same as JS Date (January = 0).
 *
 * HONEST NOTE FOR WHOEVER RUNS THIS: this scraper reads the live HTML of
 * IslandETickets' homepage and individual event pages. It was built by
 * inspecting the page's actual content, not their internal source code —
 * if they redesign their site, the patterns below may need adjusting.
 * If the output looks wrong (empty, garbled names, wrong dates), that's
 * the first place to look. Nothing here breaks the live site if it fails —
 * see the "safety net" note near the bottom.
 *
 * Requires Node 18+ (built-in fetch). No external dependencies.
 */

const fs = require('fs');

const SOURCE_HOME = 'https://islandetickets.com/';
const OUTPUT_FILE = 'fetes.json';
const MAX_EVENTS = 80;        // cap how many event pages we fetch per run, to be a polite scraper
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

// Turn "Sat 6th February , 2027" -> {y:2027, m:1, d:6}   (used on individual event pages)
function parseLongDate(text){
  const m = text.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s*,?\s*(\d{4})/);
  if(!m) return null;
  const day = parseInt(m[1], 10);
  const monthIdx = MONTHS.indexOf(m[2].slice(0,3).toLowerCase());
  const year = parseInt(m[3], 10);
  if(monthIdx === -1) return null;
  return { y: year, m: monthIdx, d: day };
}

// Guess a category from the event name + description, since the source
// site doesn't tag categories the way our app does.
function inferCategory(name, desc){
  const text = (name + ' ' + desc).toLowerCase();
  if(/\bcooler\b/.test(text)) return 'cooler';
  if(/all[\s-]?inclusive/.test(text)) return 'allincl';
  if(/\b(launch|reveal)\b/.test(text)) return 'launch';
  if(/\b(cruise|boat ?ride|raft ?up|sail)\b/.test(text)) return 'boat';
  if(/\bfree\b/.test(text)) return 'free';
  return 'other';
}

// ---------- geo filter: sites like this often list diaspora Carnival ----------
// ---------- events too (Toronto, Brooklyn, Miami, London, etc). We only ----------
// ---------- want events actually happening in Trinidad & Tobago. ----------

// Known T&T areas/venue keywords — expand this list as you spot real local
// venues that get missed.
const TT_KEYWORDS = [
  'trinidad', 'tobago', 'port of spain', 'san fernando', 'chaguanas',
  'arima', 'point fortin', 'chaguaramas', 'diego martin', 'trincity',
  'movietowne', 'woodbrook', 'st. james', 'st james', 'arouca', 'couva',
  'siparia', 'penal', 'sangre grande', 'tunapuna', 'valsayn', 'maraval',
  'petit valley', 'westmoorings', 'carenage', 'laventille', 'barataria',
  'curepe', 'st augustine', 'queen\'s park savannah', 'skinner park',
  'camp ogden', 'ariapita', 'woodford square', 'nelson mandela park'
];

// Common diaspora/foreign markers — if any of these show up, it's almost
// certainly NOT a Trinidad event, regardless of what else matches.
const FOREIGN_KEYWORDS = [
  'toronto', 'brampton', 'mississauga', 'scarborough', 'ajax', 'ontario',
  'brooklyn', 'new york', 'nyc', 'queens', 'manhattan', 'bronx',
  'miami', 'orlando', 'florida', 'atlanta', 'houston', 'texas',
  'london', 'uk', 'united kingdom', 'birmingham', 'manchester',
  'caribana', 'notting hill'
];

function isTrinidadEvent(venue){
  const text = venue.toLowerCase();
  if(FOREIGN_KEYWORDS.some(kw => text.includes(kw))) return false;
  if(TT_KEYWORDS.some(kw => text.includes(kw))) return true;
  // Ambiguous — venue name doesn't clearly match either list. We include
  // it by default (better to catch a real local fete than silently drop
  // it), but flag it so you can check the run log and, if it turns out
  // to be foreign, add its city to FOREIGN_KEYWORDS above.
  console.warn(`  ? Couldn't confirm location for venue "${venue}" — included by default, please verify.`);
  return true;
}

// ---------- step 1: pull the list of upcoming events from the homepage ----------

async function getEventList(){
  const html = await fetchText(SOURCE_HOME);

  // The homepage groups events under month headings, then lists each
  // event as a link whose text looks like:
  //   "12th King's Conference 2026 Hosted by Men of Purpose @ Venue 10:00am - 4:00pm"
  // We walk the raw HTML in order, tracking which month heading we've
  // most recently passed, so each event inherits the right month/year.

  const monthHeadingRe = /(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{4})/g;
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
    if(currentYear === null) continue; // haven't seen a month heading yet, skip

    // marker.raw looks like: "12th Some Event Name Hosted by Promoter @ Venue 7:00pm - 11:00pm Generic placeholder image"
    const dayMatch = marker.raw.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+/);
    if(!dayMatch) continue;
    const day = parseInt(dayMatch[1], 10);
    let rest = marker.raw.slice(dayMatch[0].length);

    // strip the trailing "Generic placeholder image" / similar alt-text noise
    rest = rest.replace(/\s*(Generic placeholder image)?\s*$/i, '');

    const detailMatch = rest.match(/^(.*?)\s+Hosted by\s+(.*?)\s+@\s+(.*?)\s+\d{1,2}:\d{2}(?:am|pm)\s*-\s*\d{1,2}:\d{2}(?:am|pm)/i);
    if(!detailMatch) continue;

    const [, name, promoter, venue] = detailMatch;
    if(!name || !marker.url) continue;

    if(!isTrinidadEvent(venue.trim())){
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

    if(events.length >= MAX_EVENTS) break;
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

    // If the event page states a fuller date, prefer it (catches cases
    // where the homepage's day-only listing loses track of the month).
    const fullDate = parseLongDate(stripTags(html));

    return {
      ...basicEvent,
      ...(fullDate || {}),
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

  // SAFETY NET: if something went badly wrong upstream (site down, page
  // redesigned, zero events parsed) don't overwrite a working fetes.json
  // with an empty one — better to keep yesterday's data live than to
  // blank the whole calendar.
  if(fetes.length === 0){
    console.error('No events parsed — leaving the existing fetes.json untouched.');
    process.exit(1);
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(fetes, null, 2));
  console.log(`Wrote ${fetes.length} events to ${OUTPUT_FILE}`);
}

main().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
