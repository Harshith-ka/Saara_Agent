// Web lookups: Saara reads real pages in her own Chrome window and answers on the call.
// Movie showtimes come from BookMyShow, food from Swiggy, prices from Amazon and Flipkart, and
// anything else from Google's answer. It is read-only: it never books, orders or pays.
// open_result puts the page on the owner's own screen so they can finish there themselves.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = 9334; // Classroom uses 9333; this is a separate window and profile
const QUICK_MS = 9000; // a voice tool can't wait long, so slower lookups finish in the background
const BMS = 'https://in.bookmyshow.com';
// BookMyShow's own slugs for its main cities. Any other place is treated as an area inside HOME_CITY.
const BMS_CITIES = {
  hyderabad: 'hyderabad', mumbai: 'mumbai', delhi: 'delhi-ncr', 'delhi ncr': 'delhi-ncr', 'new delhi': 'delhi-ncr', bengaluru: 'bengaluru',
  bangalore: 'bengaluru', chennai: 'chennai', kolkata: 'kolkata', pune: 'pune', ahmedabad: 'ahmedabad', kochi: 'kochi', chandigarh: 'chandigarh',
};
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const STOP = new Set(['the', 'a', 'an', 'movie', 'film', 'tickets', 'ticket', 'show', 'shows', 'showtimes', 'for', 'of', 'in', 'at', 'near', 'me',
  'price', 'prices', 'cost', 'on', 'and', 'to', 'is', 'available', 'order', 'food', 'from', 'today', 'tonight', 'tomorrow', 'buy', 'best', ...DAYS]);

// Words that many restaurant names share; they never identify one place on their own.
const GENERIC = new Set(['biryani', 'restaurant', 'restaurants', 'kitchen', 'cafe', 'hotel', 'foods', 'house', 'point', 'centre', 'center', 'dhaba',
  'bar', 'grill', 'express', 'family', 'veg', 'pizza', 'burger', 'chicken', 'mandi', 'bakery', 'sweets', 'tiffins', 'mess']);
// Model variants: a listing with one the owner didn't ask for is a different product.
const VARIANTS = new Set(['plus', 'pro', 'max', 'mini', 'ultra', 'lite', 'fe', 'neo', 'prime', 'air', 'se']);
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
const parts = (input) => clean(input).split('|').map((s) => s.trim().replace(/^none$/i, ''));
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));
const rupees = (n) => `${Math.round(n).toLocaleString('en-IN')} rupees`;
const money = (s) => Number(String(s || '').replace(/[^\d.]/g, '')) || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// How well a listing's title matches what the owner asked for, from 0 to 1. Numbers must all
// match, so "iPhone 16" never matches an iPhone 17 and "Jailer 2" never matches Jailer.
const match = (query, title) => {
  const q = words(query), t = words(title);
  if (!q.length || q.some((w) => /\d/.test(w) && !t.includes(w))) return 0;
  return q.filter((w) => t.includes(w)).length / q.length;
};

export function createWeb({ root, env, openUrl }) {
  const profile = path.join(root, '.web-profile');
  let browser = null;
  let chain = Promise.resolve(); // one lookup at a time
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const home = () => clean(env.HOME_CITY) || 'Hyderabad';

  // ---------- browser ----------
  async function debuggerUp() {
    try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; }
  }
  async function ensureBrowser() {
    if (browser?.isConnected()) return browser;
    if (!(await debuggerUp())) {
      if (!CHROME) throw new Error('Chrome is not installed');
      // Minimized, but with background throttling off so pages still load at full speed.
      spawn(CHROME, [
        `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', '--no-first-run',
        '--no-default-browser-check', '--start-minimized', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows', 'about:blank',
      ], { detached: true, stdio: 'ignore' }).unref();
      for (let i = 0; i < 40 && !(await debuggerUp()); i++) await sleep(250);
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    return browser;
  }
  async function tab(i) {
    const ctx = (await ensureBrowser()).contexts()[0];
    while (ctx.pages().length <= i) await ctx.newPage();
    return ctx.pages()[i];
  }
  async function visit(url, i = 0) {
    const p = await tab(i);
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    return p;
  }

  // ---------- place and day ----------
  const geo = new Map();
  async function locate(place) {
    for (const q of place ? [`${place}, ${home()}`, place] : [clean(env.HOME_AREA) || home()]) {
      if (geo.has(q)) return geo.get(q);
      try {
        const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(q)}`,
          { headers: { 'User-Agent': 'Saara-laptop-assistant/1.0' }, signal: AbortSignal.timeout(6000) });
        const hit = (await r.json())[0];
        if (hit) { const loc = { lat: Number(hit.lat), lng: Number(hit.lon), name: place || clean(env.HOME_AREA) || home() }; geo.set(q, loc); return loc; }
      } catch {}
    }
    return null;
  }
  function dayOf(text, now = new Date()) {
    const t = String(text || '').toLowerCase();
    const d = new Date(now);
    if (/day after tomorrow/.test(t)) d.setDate(d.getDate() + 2);
    else if (/tomorrow/.test(t)) d.setDate(d.getDate() + 1);
    else {
      const i = DAYS.findIndex((n) => new RegExp(`\\b(${n}|${n.slice(0, 3)})\\b`).test(t));
      if (i >= 0) d.setDate(d.getDate() + ((i - d.getDay() + 7) % 7));
    }
    return d;
  }
  const dateCode = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const spokenDay = (d) => {
    const diff = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
    return diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : `on ${d.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`;
  };

  // ---------- movies: BookMyShow ----------
  async function movies(input) {
    const [movieQ = '', placeQ = '', dayQ = ''] = parts(input);
    if (!words(movieQ).length) return { text: 'Which movie should I check?' };
    const city = BMS_CITIES[placeQ.toLowerCase()] || BMS_CITIES[home().toLowerCase()] || 'hyderabad';
    const cityName = city === 'delhi-ncr' ? 'Delhi' : city[0].toUpperCase() + city.slice(1);
    const area = BMS_CITIES[placeQ.toLowerCase()] ? '' : placeQ;
    const day = dayOf(`${dayQ} ${movieQ}`);

    const p = await visit(`${BMS}/explore/movies-${city}`);
    await p.waitForSelector(`a[href*="/movies/${city}/"]`, { timeout: 12_000 }).catch(() => {});
    const listed = await p.$$eval(`a[href*="/movies/${city}/"]`, (as) => as.map((a) => ({ href: a.href, name: (a.innerText.split('\n')[0] || '').trim() })));
    const films = listed.filter((m, i) => /\/ET\d+$/.test(m.href) && m.name && listed.findIndex((x) => x.href === m.href) === i);
    if (!films.length) throw new Error('BookMyShow did not load');
    const film = films.map((m) => ({ m, s: match(movieQ, m.name) - words(m.name).length * 0.01 })).filter((x) => x.s >= 0.5).sort((a, b) => b.s - a.s)[0]?.m;
    if (!film) return { text: `I couldn't find ${movieQ} showing in ${cityName} on BookMyShow. Showing now: ${films.slice(0, 6).map((m) => m.name).join(', ')}.` };

    const url = `${film.href.replace(/\/(ET\d+)$/, '/buytickets/$1')}/${dateCode(day)}`;
    await visit(url);
    await p.waitForFunction(() => Object.keys(window.__INITIAL_STATE__?.showtimesFunctionalApi?.queries || {}).some((k) => k.startsWith('fetchPrimaryDynamic')), null, { timeout: 15_000 }).catch(() => {});
    // Every cinema is a "venue-card" in the page's state, with each show's seat classes, prices and how full they are.
    const venues = await p.evaluate(() => {
      const out = [];
      const walk = (o, d) => {
        if (!o || typeof o !== 'object' || d > 14) return;
        if (o.type === 'venue-card' && o.additionalData?.venueName) {
          if (out.some((v) => v.name === o.additionalData.venueName)) return;
          out.push({
            name: o.additionalData.venueName,
            shows: (o.showtimesSections || []).flatMap((s) => s.showtimes || []).map((s) => ({
              time: s.additionalData?.showTime || s.title, at: s.additionalData?.showDateTime || '',
              cats: (s.customGestureCTA?.additionalData?.bottomSheetData?.widgets || []).map((w) => w.variableData)
                .filter((v) => v?.seatCost).map((v) => ({ cost: Number(String(v.seatCost).replace(/[^\d.]/g, '')), status: String(v.seatAvalibility || '') })),
            })),
          });
          return;
        }
        for (const k of Object.keys(o)) walk(o[k], d + 1);
      };
      walk(window.__INITIAL_STATE__?.showtimesFunctionalApi?.queries, 0);
      return out;
    });
    const when = spokenDay(day);
    if (!venues.length) return { text: `${film.name} has no shows in ${cityName} ${when} on BookMyShow.`, url, what: `${film.name} on BookMyShow` };

    const soon = Date.now() + 10 * 60_000;
    const start = (s) => new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12)).getTime();
    const shows = venues.flatMap((v) => v.shows.map((s) => {
      const open = s.cats.filter((c) => !/sold/i.test(c.status));
      return { venue: v.name.replace(/:\s*/, ' ').replace(/,\s*(Hyderabad|Mumbai|Bengaluru|Chennai|Pune|Kolkata)$/i, ''), time: s.time,
        from: open.length ? Math.min(...open.map((c) => c.cost)) : null, full: s.cats.length > 0 && !open.length,
        filling: open.length > 0 && open.every((c) => /almost|fast|filling/i.test(c.status)), at: s.at ? start(s.at) : 0 };
    })).filter((s) => !s.full && (!s.at || s.at > soon));
    const near = words(area);
    const local = near.length ? shows.filter((s) => near.some((w) => s.venue.toLowerCase().includes(w))) : shows;
    const pool = local.length ? local : shows;
    if (!pool.length) return { text: `${film.name} is sold out or has no more shows in ${cityName} ${when}.`, url, what: `${film.name} on BookMyShow` };
    // When a day's shows are over, BookMyShow quietly shows the next day instead; say the day it really is.
    const firstAt = Math.min(...pool.map((s) => s.at).filter(Boolean));
    const shownWhen = Number.isFinite(firstAt) ? spokenDay(new Date(firstAt)) : when;
    const moved = shownWhen !== when ? `No more shows ${when}. ` : '';

    // One line per cinema: its cheapest seat and its next few show times.
    const times = (venue) => pool.filter((s) => s.venue === venue).sort((a, b) => a.at - b.at).slice(0, 3).map((s) => s.time.replace(/^0/, ''));
    const list = (t) => (t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}` : t[0]);
    const say = (s) => `${s.venue} at ${list(times(s.venue))}${s.from ? `, from ${rupees(s.from)}` : ''}${s.filling ? ', almost full' : ''}`;
    const byPrice = (a, b) => (a.from ?? 1e9) - (b.from ?? 1e9) || a.at - b.at;
    const best = [...pool].sort(byPrice).filter((s, i, all) => all.findIndex((x) => x.venue === s.venue) === i).slice(0, 3);
    const earliest = [...pool].sort((a, b) => a.at - b.at)[0];
    const where = near.length && local.length ? ` near ${area}` : '';
    let text = `${moved}${film.name} ${shownWhen}${where} in ${cityName}: ${pool.length} show${pool.length === 1 ? '' : 's'} with seats at ${new Set(pool.map((s) => s.venue)).size} cinemas. `;
    if (near.length && !local.length) text = `${moved}No shows near ${area}, but across ${cityName} ${shownWhen} there are ${pool.length}. `;
    text += `Cheapest is ${say(best[0])}.`;
    if (best.length > 1) text += ` Also ${best.slice(1).map(say).join(', and ')}.`;
    if (!best.some((s) => s.venue === earliest.venue)) text += ` The earliest is at ${earliest.venue}, ${earliest.time.replace(/^0/, '')}${earliest.from ? `, from ${rupees(earliest.from)}` : ''}.`;
    return { text: `${text} I can open it on the laptop if you want to book.`, url, what: `${film.name} on BookMyShow` };
  }

  // ---------- food: Swiggy ----------
  async function food(input) {
    const [what = '', placeQ = ''] = parts(input);
    if (!words(what).length) return { text: 'Which dish or restaurant should I check?' };
    const loc = (await locate(placeQ)) || (await locate(''));
    if (!loc) return { text: `I couldn't find ${placeQ || 'your area'} on the map.` };
    const p = await tab(0);
    if (!p.url().startsWith('https://www.swiggy.com')) {
      await visit('https://www.swiggy.com/');
      await p.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
    }
    // Swiggy's own search data, fetched from inside its page so it carries the site's normal cookies.
    // Swiggy's home page sometimes redirects itself right after loading, so one retry covers that.
    const search = () => p.evaluate(async ({ lat, lng, q }) => {
      const r = await fetch(`/dapi/restaurants/search/v3?lat=${lat}&lng=${lng}&str=${encodeURIComponent(q)}&submitAction=ENTER`);
      if (!r.ok) return { error: r.status };
      const cards = (await r.json()).data?.cards || [];
      const groups = cards.find((c) => c.groupedCard)?.groupedCard?.cardGroupMap || {};
      const rest = (i) => ({ name: i.name, area: i.areaName || i.locality || '', open: !!i.availability?.opened, next: i.availability?.nextOpenTimeMessage || '',
        eta: (i.sla?.slaString || '').toLowerCase(), delivers: !/UNSERVICEABLE/.test(i.sla?.serviceability || ''), rating: Number(i.avgRating) || 0 });
      return {
        intent: cards.find((c) => c.card?.card?.meta?.queryIntent)?.card.card.meta.queryIntent || '', // RESTAURANT or DISH
        restaurants: (groups.RESTAURANT?.cards || []).map((c) => c.card?.card?.info).filter((i) => i?.name).map(rest),
        dishes: (groups.DISH?.cards || []).map((c) => c.card?.card).filter((c) => c?.restaurant && c?.dishes).slice(0, 20)
          .flatMap((c) => c.dishes.map((d) => ({ dish: d.info?.name || '', price: (d.info?.price || d.info?.defaultPrice || 0) / 100, inStock: d.info?.inStock !== 0, ...rest(c.restaurant.info) }))),
      };
    }, { lat: loc.lat, lng: loc.lng, q: what });
    const data = await search().catch(async (e) => {
      if (!/context was destroyed|navigat/i.test(e.message)) throw e;
      await p.waitForLoadState('load', { timeout: 10_000 }).catch(() => {});
      await sleep(800);
      return search();
    });
    if (data.error) throw new Error(`Swiggy answered ${data.error}`);
    const url = `https://www.swiggy.com/search?query=${encodeURIComponent(what)}`;
    const live = (r) => r.open && r.delivers;
    const rated = (r) => (r.rating ? `, rated ${r.rating}` : '');

    // A restaurant name: say whether that place is open and delivering here.
    // Every distinctive word must be in the name, so "Paradise Biryani" never matches Behrouz Biryani.
    const own = words(what).filter((w) => !GENERIC.has(w));
    const named = own.length ? data.restaurants.filter((r) => own.every((w) => words(r.name).includes(w))) : [];
    if (named.length) {
      const r = named.find(live) || named[0];
      if (!live(r)) {
        const why = !r.delivers ? `doesn't deliver to ${loc.name} right now` : `is closed right now${r.next ? `. ${r.next}` : ''}`;
        return { text: `${r.name} in ${r.area} ${why}.`, url, what: `${r.name} on Swiggy` };
      }
      const other = named.filter((x) => x !== r && live(x))[0];
      return { text: `Yes, ${r.name} in ${r.area} is open and delivering to ${loc.name}, about ${r.eta}${rated(r)}.${other ? ` The ${other.area} branch is open too, ${other.eta}.` : ''}`, url, what: `${r.name} on Swiggy` };
    }

    if (data.intent === 'RESTAURANT' || !data.dishes.length) {
      return { text: `I couldn't find ${what} on Swiggy for ${loc.name}. It may not deliver there, or it isn't listed right now.`, url, what: `${what} on Swiggy` };
    }

    // A dish: the best-rated places that have it in stock and deliver right now.
    const ok = data.dishes.filter((d) => d.inStock && live(d));
    if (!ok.length) return { text: `${what} isn't available for delivery to ${loc.name} right now. The places that have it are closed or out of stock.`, url, what: `${what} on Swiggy` };
    const seen = new Set();
    const picks = [...ok].sort((a, b) => b.rating - a.rating || a.price - b.price).filter((d) => !seen.has(d.name) && seen.add(d.name)).slice(0, 3);
    const cheap = ok.filter((d) => d.rating >= 4).sort((a, b) => a.price - b.price)[0];
    const say = (d) => `${d.dish} from ${d.name}, ${d.area}, ${rupees(d.price)}, ${d.eta}${rated(d)}`;
    let text = `Yes, ${what} is available near ${loc.name}. Top rated: ${say(picks[0])}.`;
    if (picks.length > 1) text += ` Also ${picks.slice(1).map(say).join(', and ')}.`;
    if (cheap && !picks.includes(cheap)) text += ` Cheapest good one: ${say(cheap)}.`;
    return { text, url, what: `${what} on Swiggy` };
  }

  // ---------- prices: Amazon and Flipkart, side by side ----------
  async function amazon(q) {
    const p = await visit(`https://www.amazon.in/s?k=${encodeURIComponent(q)}`, 0);
    await p.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10_000 }).catch(() => {});
    const items = await p.$$eval('[data-component-type="s-search-result"]', (rs) => rs.slice(0, 16).map((r) => {
      const lines = (r.querySelector('[data-cy="title-recipe"]')?.innerText || r.querySelector('h2')?.innerText || '').split('\n').map((s) => s.trim());
      return { title: lines.sort((a, b) => b.length - a.length)[0] || '', price: r.querySelector('.a-price .a-offscreen')?.textContent || '',
        sponsored: /^sponsored/i.test(r.innerText.trim()), url: r.dataset.asin ? `https://www.amazon.in/dp/${r.dataset.asin}` : '' };
    }));
    return pick(q, items.map((i) => ({ ...i, price: money(i.price) })));
  }
  async function flipkart(q) {
    const p = await visit(`https://www.flipkart.com/search?q=${encodeURIComponent(q)}`, 1);
    await p.waitForSelector('a[href*="/p/itm"]', { timeout: 10_000 }).catch(() => {});
    const cards = await p.evaluate(() => [...new Set([...document.querySelectorAll('a[href*="/p/itm"]')].map((a) => a.closest('[data-id]')))]
      .filter(Boolean).slice(0, 16).map((c) => ({ lines: c.innerText.split('\n').map((s) => s.trim()).filter(Boolean), url: c.querySelector('a[href*="/p/itm"]').href.split('&')[0] })));
    return pick(q, cards.filter((c) => !c.lines.some((l) => /^currently unavailable$|^sold out$/i.test(l))).map((c) => ({
      title: c.lines.find((l) => l.length > 6 && !/^(bestseller|add to compare|sponsored|trending|hot deal|only few left)$/i.test(l) && !/^₹/.test(l)) || '',
      price: money(c.lines.find((l) => /^₹[\d,]+/.test(l))?.match(/^₹([\d,]+)/)?.[1]), sponsored: c.lines.some((l) => /^sponsored$/i.test(l)), url: c.url,
    })));
  }
  // The closest-matching listing with a price: no variant the owner didn't ask for (Plus, Pro…),
  // few extra words, and not an ad.
  const pick = (q, items) => {
    const asked = words(q);
    return items.filter((i) => i.title && i.price && !words(i.title).some((w) => VARIANTS.has(w) && !asked.includes(w)))
      .map((i, n) => ({ ...i, s: match(q, i.title) - words(shortTitle(i.title)).filter((w) => !asked.includes(w)).length * 0.02 - (i.sponsored ? 0.05 : 0) - n * 0.001 }))
      .filter((i) => i.s >= 0.4).sort((a, b) => b.s - a.s)[0] || null;
  };
  // "boAt Airdopes 141, Up to 50 Hours…" → "boAt Airdopes 141"; commas inside "(Black, 128 GB)" are kept.
  const shortTitle = (t) => t.replace(/\(([^)]*)\)/g, (m) => m.replace(/,/g, '')).split(/[:|,]/)[0].split(/\s+/).slice(0, 10).join(' ');

  async function prices(input) {
    const q = clean(input);
    if (!words(q).length) return { text: 'Which product should I compare?' };
    const [az, fk] = await Promise.all([amazon(q).catch(() => null), flipkart(q).catch(() => null)]);
    if (!az && !fk) return { text: `I couldn't find ${q} with a price on Amazon or Flipkart.` };
    const one = (site, i) => `${site} has ${shortTitle(i.title)} at ${rupees(i.price)}`;
    if (!az || !fk) { const [site, i] = az ? ['Amazon', az] : ['Flipkart', fk]; return { text: `${one(site, i)}. I couldn't find a matching listing on the other site.`, url: i.url, what: `${q} on ${site}` }; }
    const [lo, loSite] = az.price <= fk.price ? [az, 'Amazon'] : [fk, 'Flipkart'];
    const gap = Math.abs(az.price - fk.price);
    const verdict = gap ? `${loSite} is cheaper by ${rupees(gap)}.` : 'Same price on both.';
    return { text: `${one('Amazon', az)}, and ${one('Flipkart', fk)}. ${verdict} Check that it's the same model before buying.`, url: lo.url, what: `${q} on ${loSite}` };
  }

  // ---------- anything else: Google's answer ----------
  async function answer(input) {
    const q = clean(input);
    if (!q) return { text: 'What should I look up?' };
    const url = `https://www.google.com/search?hl=en&gl=in&q=${encodeURIComponent(q)}`;
    const p = await visit(url);
    if (/\/sorry\//.test(p.url())) return { text: "Google wants a robot check first. Solve it once in Saara's web window on the laptop, then ask me again.", url, what: 'the Google results' };
    await p.waitForSelector('#center_col, #rso', { timeout: 8000 }).catch(() => {});
    const raw = await p.evaluate(() => (document.querySelector('#center_col') || document.body).innerText);
    const keep = [];
    for (const l of raw.split('\n').map((s) => s.trim())) {
      if (/^(People also ask|Top stories|Related searches|Videos|Images|Things to know|Discussions and forums|What people are saying|Short videos)/i.test(l)) { if (keep.length) break; continue; }
      // Drop links, site names, chart labels and buttons; keep the sentences and figures.
      if (l.length < 8 || /^https?:\/\//.test(l) || / › /.test(l) || (l.split(' ').length <= 2 && !/\d/.test(l) && l.length < 20)) continue;
      if (/^[\d,.\s₹%+-]+$/.test(l)) continue; // bare chart axis numbers
      if (/^(Web results|AI Overview|Sponsored|Disclaimer|Feedback|Translate this page|Show more|Read more)\b/i.test(l)) continue;
      keep.push(l.replace(/\s*·\s*(Disclaimer)?/g, ', ').replace(/(\.\s*)+$|,\s*$|\s*\.\.\.?$/g, ''));
      if (keep.join(' ').length > 650) break;
    }
    if (!keep.length) return { text: `Google had no clear answer for ${q}. I can open the results on the laptop.`, url, what: 'the Google results' };
    return { text: `From Google: ${keep.join('. ').replace(/\.\./g, '.').slice(0, 700)}`, url, what: 'the Google results' };
  }

  // ---------- jobs: answer within the call, or finish in the background ----------
  const KINDS = { movies: ['movie times', movies], food: ['Swiggy', food], prices: ['prices', prices], answer: ['Google', answer] };
  let job = null;
  let last = null; // the page behind the latest answer, for open_result
  async function lookup(kind, input) {
    const [label, fn] = KINDS[kind];
    const me = { label, state: 'running', started: Date.now(), result: '' };
    job = me;
    const run = serial(() => fn(input)).then((r) => {
      me.state = 'done'; me.result = r.text;
      if (r.url) last = { url: r.url, what: r.what || label };
      return r.text;
    }, (e) => {
      if (/closed|detached|Target page|disconnected/i.test(e.message)) browser = null; // the window was closed; reopen it next time
      me.state = 'failed'; me.result = `I couldn't check ${label} right now, the site didn't load properly. Try again in a minute.`;
      console.log(`Web lookup (${kind}) failed:`, e.message.split(/\r?\n/)[0]);
      return me.result;
    });
    const quick = await Promise.race([run, sleep(QUICK_MS).then(() => null)]);
    return quick ?? `Still checking ${label}, the site is slow. Call lookup_result in about ten seconds.`;
  }
  function lookupResult() {
    if (!job) return 'I have not checked anything on the web yet.';
    if (job.state === 'running') return `Still checking ${job.label}, ${Math.round((Date.now() - job.started) / 1000)} seconds so far. Call lookup_result again in a few seconds.`;
    return job.result;
  }
  async function openResult() {
    if (!last) return 'There is nothing to open yet. Ask me to check something first.';
    if (!(await openUrl(last.url))) return "I tried, but the browser didn't open it. Check that Chrome is working on the laptop.";
    return `Opened ${last.what} on the laptop screen. Booking and payment are up to you, I never pay for anything.`;
  }

  return { lookup, lookupResult, openResult, dayOf };
}
