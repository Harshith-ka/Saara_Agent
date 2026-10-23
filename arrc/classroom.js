// Google Classroom by browser automation. Google's Classroom API only lets an app turn in work
// for assignments that the same app created, so for real (teacher-made) assignments ARRC drives a
// dedicated Chrome window that the owner signed in to once. The window is a normal Chrome launch
// (so Google sign-in works) with remote debugging bound to 127.0.0.1 for Playwright to attach.
//
// Submission is two-step on purpose: prepare() picks the assignment and the file and J reads them
// back on the call; confirm() only runs after the owner says yes, within 10 minutes.
// CLASSROOM_SUBMIT controls how far confirm() goes: dry (default: open the picker, upload nothing),
// attach (attach the file, don't turn in), live (attach and turn in).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findFiles, describe } from './files.js';

const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find((p) => fs.existsSync(p));
const PORT = 9333;
const BASE = 'https://classroom.google.com';
const PENDING_MS = 10 * 60_000;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const STOP = new Set(['the', 'a', 'an', 'and', 'of', 'for', 'to', 'my', 'assignment', 'submit', 'it', 'in', 'on', 'report', 'format', 'classroom', 'please']);

export function createClassroom({ root, env }) {
  const profile = path.join(root, '.classroom-profile');
  let browser = null;
  let pending = null;
  let chain = Promise.resolve(); // one browser job at a time
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const mode = () => (['attach', 'live'].includes(env.CLASSROOM_SUBMIT) ? env.CLASSROOM_SUBMIT : 'dry');

  // ---------- browser ----------
  async function debuggerUp() {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) }); return r.ok; } catch { return false; }
  }
  async function ensureBrowser() {
    if (browser?.isConnected()) return browser;
    if (!(await debuggerUp())) {
      if (!CHROME) throw new Error('Chrome is not installed');
      const p = spawn(CHROME, [
        `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
        '--no-first-run', '--no-default-browser-check', `${BASE}/`,
      ], { detached: true, stdio: 'ignore' });
      p.unref();
      for (let i = 0; i < 40 && !(await debuggerUp()); i++) await new Promise((r) => setTimeout(r, 250));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    return browser;
  }
  async function page() {
    const ctx = (await ensureBrowser()).contexts()[0];
    return ctx.pages().find((p) => p.url().includes('classroom.google.com')) || ctx.pages()[0] || ctx.newPage();
  }
  async function open(url) {
    const p = await page();
    await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    if (/accounts\.google\.com|edu\.google\.com/.test(p.url())) throw new Error('The Classroom window is signed out. Sign in once in the ARRC Chrome window.');
    await p.waitForTimeout(2500);
    return p;
  }

  // ---------- reading ----------
  function parseDue(text, now = new Date()) {
    const m = String(text).match(/Due\s+(Today|Tomorrow|Yesterday|[A-Z][a-z]{2}\s+\d{1,2}(?:,\s*\d{4})?)(?:,\s*(\d{1,2}):(\d{2})\s*([AP]M))?/i);
    if (!m) return null;
    const d = new Date(now);
    const day = m[1].toLowerCase();
    if (day === 'tomorrow') d.setDate(d.getDate() + 1);
    else if (day === 'yesterday') d.setDate(d.getDate() - 1);
    else if (day !== 'today') {
      const [, mon, dd, yyyy] = m[1].match(/([A-Za-z]{3})\s+(\d{1,2})(?:,\s*(\d{4}))?/);
      d.setMonth(MONTHS.indexOf(mon.toLowerCase()), Number(dd));
      if (yyyy) d.setFullYear(Number(yyyy));
      else if (d.getTime() < now.getTime() - 180 * 86_400_000) d.setFullYear(d.getFullYear() + 1);
    }
    let h = m[2] ? Number(m[2]) % 12 : 23; const min = m[3] ? Number(m[3]) : 59;
    if (m[4]?.toUpperCase() === 'PM') h += 12;
    d.setHours(h, min, 0, 0);
    return d;
  }

  // Everything on the student's "Assigned" and "Missing" to-do lists, with due dates from each page.
  const listOpen = () => serial(async () => {
    const out = [];
    for (const tab of ['not-turned-in', 'missing']) {
      const p = await open(`${BASE}/a/${tab}/all`);
      // The to-do list renders 3-5 s after load; an empty tab simply times out here.
      await p.waitForSelector('a[href*="/a/"][href$="/details"]', { timeout: 12_000 }).catch(() => {});
      for (const b of await p.getByRole('button', { name: /^Expand$/ }).all()) await b.click().catch(() => {});
      await p.waitForTimeout(800);
      const rows = await p.$$eval('a[href*="/a/"][href$="/details"]', (as) => as.map((a) => ({
        href: a.getAttribute('href'),
        lines: a.innerText.split('\n').map((s) => s.trim()).filter(Boolean),
      })));
      for (const r of rows) {
        if (!out.some((o) => o.href === r.href)) out.push({ href: r.href, url: BASE + r.href, missing: tab === 'missing' });
      }
    }
    // Title, course and due time come from each assignment's own page; list rows can be collapsed text.
    for (const a of out) {
      const p = await open(a.url);
      await p.getByText('Your work', { exact: true }).first().waitFor({ timeout: 15_000 }).catch(() => {});
      await p.waitForFunction(() => !/^Classroom$/.test(document.title), null, { timeout: 10_000 }).catch(() => {});
      const info = await p.evaluate(() => {
        const lines = document.body.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
        const i = lines.indexOf('Classroom');
        return { title: document.title.replace(/\s*-\s*Classroom\s*$/, ''), course: i >= 0 ? lines[i + 1] : '', text: document.body.innerText };
      });
      const due = parseDue(info.text);
      Object.assign(a, { title: info.title || 'Untitled', course: info.course, due: due ? due.toISOString() : null, dueText: info.text.match(/Due\s+[^\n]+/)?.[0] || 'has no due date' });
    }
    cache = { list: out, at: Date.now() };
    try { fs.writeFileSync(cacheFile, JSON.stringify(cache)); } catch {}
    return out;
  });

  // The full read takes ~30 s, longer than a voice tool may wait, so calls use a cached list that
  // the monitor refreshes in the background.
  // Saved to disk so a restart answers instantly; a stale copy (over 12 h) is ignored.
  const cacheFile = path.join(root, 'classroom-cache.json');
  let cache = { list: [], at: 0 };
  try { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); if (Date.now() - c.at < 12 * 3600_000) cache = c; } catch {}
  const CACHE_MS = 30 * 60_000;
  // Only one full read at a time: callers that arrive mid-read share it instead of queueing another.
  let inflight = null;
  const readOnce = () => inflight || (inflight = listOpen().finally(() => { inflight = null; }));
  async function openList({ fresh = false } = {}) {
    if (fresh || !cache.at) return readOnce();
    if (Date.now() - cache.at > CACHE_MS) readOnce().catch(() => {});
    return cache.list;
  }

  // How J says an assignment out loud: no course codes, no "and Report Format" style tails.
  const spoken = (title) => String(title).replace(/\s+and\s+report\s+format$/i, '').replace(/\b[A-Z]{2}\s?\d{4}\b/g, '').replace(/\s{2,}/g, ' ').trim();
  const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));
  function bestAssignment(list, query) {
    const q = words(query);
    if (!q.length) return list.filter((a) => a.due).sort((a, b) => a.due.localeCompare(b.due))[0] || list[0];
    return list.map((a) => {
      const hay = `${a.title} ${a.course}`.toLowerCase().replace(/[^a-z0-9]+/g, ' ');
      const flat = hay.replace(/\s/g, '');
      return { a, s: q.reduce((n, w) => n + (hay.split(' ').includes(w) ? 3 : flat.includes(w) ? 2 : 0), 0) };
    }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s)[0]?.a || null;
  }

  // ---------- submitting ----------
  // A file must clearly belong to the assignment: the owner named it, or its name carries the
  // course code or most of the assignment's distinctive title words. Otherwise J asks instead of guessing.
  function pickFile(a, fileQ) {
    if (fileQ) return findFiles(fileQ, 1)[0] || null;
    const code = (a.course.match(/[A-Z]{2}\s?\d{4}/)?.[0] || '').replace(/\s/, '').toLowerCase();
    const sig = words(a.title).filter((w) => w.length > 3 && !/^\d+$/.test(w));
    const need = Math.max(1, Math.ceil(sig.length * 0.5));
    const seen = new Set();
    const candidates = [`${code} ${a.title}`, a.title, ...sig].flatMap((q) => findFiles(q, 5)).filter((f) => !seen.has(f.full) && seen.add(f.full));
    const scored = candidates.map((f) => {
      const flat = path.basename(f.full).toLowerCase().replace(/[^a-z0-9]/g, '');
      const hits = sig.filter((w) => flat.includes(w)).length;
      return { f, hits, ok: hits >= need || (code && flat.includes(code) && hits >= 1) };
    }).filter((x) => x.ok).sort((x, y) => y.hits - x.hits || y.f.mtime - x.f.mtime);
    return scored[0]?.f || null;
  }
  async function prepare(input) {
    const [assignmentQ = '', fileQ = ''] = String(input || '').split('|').map((s) => s.trim().replace(/^none$/i, ''));
    if (job && job.state !== 'running') job = null; // a new request starts fresh, no stale results
    const list = await openList();
    if (!list.length) return 'You have nothing pending in Classroom right now.';
    const a = bestAssignment(list, assignmentQ);
    if (!a) return `I couldn't find a pending Classroom assignment matching ${assignmentQ}. Pending ones: ${list.map((x) => x.title).join(', ')}.`;
    const file = pickFile(a, fileQ);
    if (!file) return `${a.title} for ${a.course} ${/^due/i.test(a.dueText) ? 'is ' : ''}${a.dueText.toLowerCase()}, but I couldn't find a file on the laptop that clearly matches it. Tell me the file name and I'll use that.`;
    pending = { at: Date.now(), assignment: a, file: file.full };
    const d = describe(file);
    const short = d.file.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
    // Attach-only can't submit anything, so J goes straight ahead and the call flows naturally.
    // Live mode really turns work in, so J still asks for a clear yes first.
    if (mode() !== 'live') return `Found his report for ${spoken(a.title)}, last edited ${d.when}. You can go ahead: tell Boss you found his report and are uploading it now, then call confirm_submission. Do not read out the file name.`;
    return `For ${a.title} in ${a.course}, ${a.dueText.toLowerCase()}, I found the file ${d.file}, last edited ${d.when}. Ask Boss: should I turn it in?`;
  }

  const submitOnce = async () => {
    if (!pending || Date.now() - pending.at > PENDING_MS) { pending = null; return 'There is nothing waiting to be submitted. Tell me which assignment first.'; }
    const { assignment: a, file } = pending;
    const name = path.basename(file);
    const p = await open(a.url);
    await p.bringToFront().catch(() => {}); // the owner (and the camera) can watch the upload happen
    const main = await p.evaluate(() => document.body.innerText);
    if (/Turned in|Handed in/i.test(main) && !/Assigned|Missing/i.test(main.split('Your work')[1] || '')) { pending = null; return `${a.title} is already turned in.`; }

    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Classroom renders a hidden duplicate of each attachment; only the visible "Remove <file>" counts.
    const attached = () => p.locator(`[aria-label="Remove ${name.replace(/"/g, '\\"')}"]`).filter({ visible: true });
    const already = await attached().count() > 0;
    if (already && mode() === 'attach') { pending = null; return `${name} is already attached to ${a.title}. It is not turned in yet.`; }
    if (!already) {
    await p.getByRole('button', { name: /Add or create/ }).last().click();
    await p.getByRole('menuitem', { name: /File/ }).filter({ hasText: /^.*File$/ }).first().click();
    let picker = null;
    for (let i = 0; i < 40 && !picker; i++) { picker = p.frames().find((f) => f.url().includes('/picker')); if (!picker) await p.waitForTimeout(250); }
    if (!picker) throw new Error('The Classroom file picker did not open');
    await picker.getByRole('tab', { name: /Upload/ }).click().catch(() => {});
    const browse = picker.getByRole('button', { name: /^Browse$/ });
    await browse.waitFor({ timeout: 15_000 });

    if (mode() === 'dry') {
      await picker.getByRole('button', { name: /Close picker/ }).click().catch(() => p.keyboard.press('Escape'));
      pending = null;
      return `Practice run: I opened ${a.title} and got the upload ready for ${name}, but I did not upload or turn it in, because live submission is switched off on the laptop.`;
    }

    // Hand the file straight to the picker's hidden file input. Clicking Browse opens a native
    // Windows dialog that a CDP-attached browser can't always intercept, which hangs the upload.
    const input = picker.locator('input[type="file"]').first();
    if (await input.count()) {
      await input.setInputFiles(file);
    } else {
      const [chooser] = await Promise.all([p.waitForEvent('filechooser', { timeout: 15_000 }), browse.click({ timeout: 10_000 })]);
      await chooser.setFiles(file);
    }
    await attached().waitFor({ timeout: 120_000 }); // Classroom shows "Remove <file>" once it is attached under "Your work"
    await p.waitForTimeout(1000);
    }

    if (mode() === 'attach') {
      pending = null;
      return `Done. His report is uploaded to ${spoken(a.title)} in Classroom. It is not turned in yet, so he can check it and press Turn in himself.`;
    }

    await p.getByRole('button', { name: /^Turn in$/ }).first().click();
    const dialog = p.getByRole('dialog');
    await dialog.getByRole('button', { name: /^Turn in$/ }).click({ timeout: 15_000 });
    await p.getByText(/Turned in|Handed in/i).first().waitFor({ timeout: 30_000 });
    pending = null;
    return `Done. ${name} is turned in for ${a.title} in ${a.course}. Classroom shows it as turned in.`;
  };
  // If the Classroom tab is closed or reloaded mid-upload, reconnect and try once more.
  const doSubmit = () => serial(async () => {
    const keep = pending;
    try { return await submitOnce(); } catch (e) {
      if (!/closed|detached|Target page/i.test(e.message) || !keep) throw e;
      browser = null;
      pending = { ...keep, at: Date.now() };
      return await submitOnce();
    }
  });

  // The upload can take longer than a voice tool may wait, so it runs in the background and the
  // agent asks for the outcome with submission_status.
  let job = null;
  function confirm() {
    if (job?.state === 'running') return 'I am already submitting it. Ask me in a few seconds if it is done.';
    if (!pending || Date.now() - pending.at > PENDING_MS) { pending = null; return 'There is nothing waiting to be submitted. Tell me which assignment first.'; }
    const title = pending.assignment.title;
    job = { state: 'running', title, started: Date.now(), result: '' };
    doSubmit()
      .then((r) => { job = { ...job, state: 'done', result: r }; })
      .catch((e) => { job = { ...job, state: 'failed', result: `I couldn't submit ${title}: ${e.message.split(/\r?\n/)[0].slice(0, 160)}. Please check Classroom.` }; });
    const doing = mode() === 'live' ? 'Uploading and turning in' : 'Uploading';
    return `On it. ${doing} his report now. It takes about half a minute. Check back with submission_status.`;
  }
  function submissionStatus() {
    if (!job) return 'I have not submitted anything on this call.';
    if (job.state === 'running') return `Still submitting ${job.title}, ${Math.round((Date.now() - job.started) / 1000)} seconds so far.`;
    return job.result;
  }
  const lastJob = () => job;

  async function spokenDue() {
    const list = await openList();
    if (!list.length) return 'Nothing pending in Classroom.';
    return list.slice(0, 5).map((a) => `${a.title} for ${a.course}, ${a.missing ? 'missing' : a.dueText.toLowerCase()}`).join('. ') + '.';
  }

  return { ensureBrowser, listOpen, openList, prepare, confirm, submissionStatus, lastJob, spokenDue, mode, parseDue };
}
