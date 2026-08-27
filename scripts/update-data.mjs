#!/usr/bin/env node
/**
 * Met à jour src/data/consumption.json avec les nuits manquantes (19h -> 7h,
 * fuseau Europe/Paris) depuis l'API Enphase v4.
 *
 * - Rafraîchit le token OAuth (le refresh token tourne à chaque appel : le
 *   nouveau est réécrit dans .env en local, et dans refresh_token.txt pour
 *   que la GitHub Action mette à jour le secret).
 * - Récupère la télémétrie du compteur de consommation par pas de 15 min,
 *   agrégée ici en pas horaire (12 créneaux : 19h..23h, 0h..6h).
 *
 * Variables d'environnement requises (voir .env.example) :
 *   ENPHASE_API_KEY, ENPHASE_CLIENT_ID, ENPHASE_CLIENT_SECRET,
 *   ENPHASE_REFRESH_TOKEN, ENPHASE_SYSTEM_ID, START_DATE (backfill initial)
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const API = 'https://api.enphaseenergy.com';
const DATA_FILE = new URL('../src/data/consumption.json', import.meta.url);
const ENV_FILE = new URL('../.env', import.meta.url);
const TZ = 'Europe/Paris';
const NIGHT_START_H = 19; // 19h00
const NIGHT_HOURS = 12;   // -> 07h00 le lendemain
const FETCH_DELAY_MS = Number(process.env.FETCH_DELAY_MS ?? 6500); // ~10 req/min max

// ---------- .env ----------
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const env = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`Variable manquante : ${name}`); process.exit(1); }
  return v;
};
const API_KEY = env('ENPHASE_API_KEY');
const CLIENT_ID = env('ENPHASE_CLIENT_ID');
const CLIENT_SECRET = env('ENPHASE_CLIENT_SECRET');
const SYSTEM_ID = env('ENPHASE_SYSTEM_ID');

// ---------- Dates / fuseau Europe/Paris (sans dépendance) ----------
const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hour12: false,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
/** Décalage (minutes à l'est d'UTC) de Paris à l'instant ms. */
function tzOffsetMin(ms) {
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms) / 60000;
}
/** Epoch (secondes) de l'heure locale Paris donnée. */
function parisEpoch(y, m, d, h = 0) {
  let ms = Date.UTC(y, m - 1, d, h);
  for (let i = 0; i < 2; i++) ms = Date.UTC(y, m - 1, d, h) - tzOffsetMin(ms) * 60000;
  return ms / 1000;
}
const toYMD = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parseYMD = (s) => s.split('-').map(Number); // [y, m, d]
function addDays(s, n) {
  const [y, m, d] = parseYMD(s);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return toYMD(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}
/** Date du jour à Paris, format YYYY-MM-DD, et heure locale. */
function parisNow() {
  const p = Object.fromEntries(dtf.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: toYMD(+p.year, +p.month, +p.day), hour: +p.hour % 24 };
}

// ---------- OAuth ----------
async function refreshTokens() {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const url = `${API}/oauth/token?grant_type=refresh_token&refresh_token=${encodeURIComponent(env('ENPHASE_REFRESH_TOKEN'))}`;
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
  if (!res.ok) throw new Error(`Échec refresh token (${res.status}) : ${await res.text()}`);
  const json = await res.json();
  persistRefreshToken(json.refresh_token);
  return json.access_token;
}
function persistRefreshToken(token) {
  if (!token) return;
  // Pour la GitHub Action (mise à jour du secret) — gitignoré.
  writeFileSync(new URL('../refresh_token.txt', import.meta.url), token + '\n');
  // En local : réécrit le .env pour le prochain lancement.
  if (existsSync(ENV_FILE)) {
    const src = readFileSync(ENV_FILE, 'utf8');
    if (/^ENPHASE_REFRESH_TOKEN=/m.test(src)) {
      writeFileSync(ENV_FILE, src.replace(/^ENPHASE_REFRESH_TOKEN=.*$/m, `ENPHASE_REFRESH_TOKEN=${token}`));
    }
  }
  console.log('Nouveau refresh token enregistré.');
}

// ---------- Télémétrie ----------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let firstFetch = true;
/**
 * Intervalles 15 min du compteur de conso pour la journée civile Paris `ymd`.
 * Retourne une Map end_at(s) -> enwh.
 */
async function fetchDay(accessToken, ymd, intervalMap) {
  if (!firstFetch) await sleep(FETCH_DELAY_MS);
  firstFetch = false;
  const [y, m, d] = parseYMD(ymd);
  const startAt = parisEpoch(y, m, d, 0);
  const url = `${API}/api/v4/systems/${SYSTEM_ID}/telemetry/consumption_meter?start_at=${startAt}&granularity=day`;
  const res = await fetch(url, { headers: { key: API_KEY, Authorization: `Bearer ${accessToken}` } });
  if (res.status === 429) {
    console.warn(`429 sur ${ymd}, pause 65 s puis nouvel essai…`);
    await sleep(65000);
    return fetchDay(accessToken, ymd, intervalMap);
  }
  if (!res.ok) throw new Error(`Télémétrie ${ymd} : ${res.status} ${await res.text()}`);
  const json = await res.json();
  for (const it of json.intervals ?? []) {
    if (typeof it.enwh === 'number') intervalMap.set(it.end_at, it.enwh);
  }
  console.log(`Journée ${ymd} : ${(json.intervals ?? []).length} intervalles.`);
}

/** Assemble la nuit commençant le soir de `ymd` à partir des intervalles 15 min. */
function buildNight(ymd, intervalMap) {
  const next = addDays(ymd, 1);
  // 13 bornes horaires locales : 19h, 20h, ... 23h, 0h, ... 7h (le lendemain).
  const bounds = [];
  for (let i = 0; i <= NIGHT_HOURS; i++) {
    const hh = NIGHT_START_H + i;
    const day = hh < 24 ? ymd : next;
    const [y, m, d] = parseYMD(day);
    bounds.push(parisEpoch(y, m, d, hh % 24));
  }
  const hourlyWh = [];
  let found = 0, expected = 0;
  for (let i = 0; i < NIGHT_HOURS; i++) {
    let sum = 0;
    for (let t = bounds[i] + 900; t <= bounds[i + 1]; t += 900) {
      expected++;
      if (intervalMap.has(t)) { sum += intervalMap.get(t); found++; }
    }
    hourlyWh.push(Math.round(sum));
  }
  const wh = hourlyWh.reduce((a, b) => a + b, 0);
  const coverage = expected ? Math.round((found / expected) * 100) / 100 : 0;
  return { date: ymd, wh, coverage, hourlyWh };
}

// ---------- Main ----------
async function main() {
  let data = { systemId: Number(SYSTEM_ID), timezone: TZ, updatedAt: null, nights: [] };
  if (existsSync(DATA_FILE)) data = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
  const byDate = new Map(data.nights.map(n => [n.date, n]));

  // Dernière nuit complète : celle d'hier soir si on a dépassé 7h ce matin,
  // sinon celle d'avant-hier.
  const now = parisNow();
  const lastComplete = addDays(now.date, now.hour >= 7 ? -1 : -2);

  // Première nuit à (re)calculer : après la dernière nuit stockée avec une
  // couverture pleine (une nuit incomplète est re-récupérée).
  let first;
  if (data.nights.length === 0) {
    first = process.env.START_DATE || lastComplete;
  } else {
    const nights = [...data.nights].sort((a, b) => a.date.localeCompare(b.date));
    let lastGood = null;
    for (const n of nights) { if (n.coverage >= 0.99) lastGood = n.date; }
    first = addDays(lastGood ?? nights.at(-1).date, lastGood ? 1 : 0);
  }
  if (first > lastComplete) {
    console.log('Données déjà à jour, rien à faire.');
    return;
  }

  const nightDates = [];
  for (let d0 = first; d0 <= lastComplete; d0 = addDays(d0, 1)) nightDates.push(d0);
  // Journées civiles nécessaires : chaque nuit couvre son jour (soir) et le suivant (matin).
  const days = [...new Set(nightDates.flatMap(d0 => [d0, addDays(d0, 1)]))].sort();
  console.log(`Nuits à récupérer : ${nightDates.length} (${first} -> ${lastComplete}), soit ${days.length} appels API.`);

  const accessToken = await refreshTokens();
  const intervalMap = new Map();
  for (const day of days) await fetchDay(accessToken, day, intervalMap);

  for (const d0 of nightDates) byDate.set(d0, buildNight(d0, intervalMap));

  data.systemId = Number(SYSTEM_ID);
  data.timezone = TZ;
  data.updatedAt = new Date().toISOString();
  data.nights = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  writeFileSync(DATA_FILE, JSON.stringify(data));
  console.log(`OK : ${data.nights.length} nuits dans src/data/consumption.json.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
