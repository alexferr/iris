#!/usr/bin/env node
/**
 * Obtention initiale des tokens OAuth Enphase v4.
 *
 * 1. Sans argument : affiche l'URL d'autorisation à ouvrir dans le navigateur.
 *    Connecte-toi avec ton compte Enlighten et autorise l'application ;
 *    la page de redirection affiche un `code`.
 * 2. Relance avec ce code : node scripts/get-tokens.mjs <code>
 *    Le refresh token est écrit dans .env.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const ENV_FILE = new URL('../.env', import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
  }
}
const CLIENT_ID = process.env.ENPHASE_CLIENT_ID;
const CLIENT_SECRET = process.env.ENPHASE_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Renseigne ENPHASE_CLIENT_ID et ENPHASE_CLIENT_SECRET dans .env d\'abord.');
  process.exit(1);
}
const REDIRECT = 'https://api.enphaseenergy.com/oauth/redirect_uri';
const code = process.argv[2];

if (!code) {
  console.log('Ouvre cette URL, autorise l\'application, puis récupère le paramètre `code` affiché :\n');
  console.log(`https://api.enphaseenergy.com/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT)}\n`);
  console.log('Puis : node scripts/get-tokens.mjs <code>');
  process.exit(0);
}

const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
const url = `https://api.enphaseenergy.com/oauth/token?grant_type=authorization_code&redirect_uri=${encodeURIComponent(REDIRECT)}&code=${encodeURIComponent(code)}`;
const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${basic}` } });
if (!res.ok) {
  console.error(`Échec (${res.status}) : ${await res.text()}`);
  process.exit(1);
}
const json = await res.json();
console.log('Access token obtenu (valable ~1 jour).');
if (existsSync(ENV_FILE)) {
  const src = readFileSync(ENV_FILE, 'utf8');
  writeFileSync(ENV_FILE, /^ENPHASE_REFRESH_TOKEN=/m.test(src)
    ? src.replace(/^ENPHASE_REFRESH_TOKEN=.*$/m, `ENPHASE_REFRESH_TOKEN=${json.refresh_token}`)
    : src + `\nENPHASE_REFRESH_TOKEN=${json.refresh_token}\n`);
  console.log('Refresh token écrit dans .env — tu peux lancer `npm run update-data`.');
} else {
  console.log(`Refresh token : ${json.refresh_token}`);
}
