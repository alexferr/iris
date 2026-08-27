# 🌙 Iris — Consommation nocturne Enphase

Site statique [Astro](https://astro.build) affichant la consommation électrique
de la maison entre **19h et 7h** chaque nuit (énergie + coût), à partir de
l'API **Enphase v4**. Hébergé sur GitHub Pages, mis à jour une fois par jour
par une GitHub Action — pas de base de données, les données vivent dans
[src/data/consumption.json](src/data/consumption.json).

## Fonctionnement

- `scripts/update-data.mjs` rafraîchit le token OAuth, récupère la télémétrie
  du compteur de consommation (pas de 15 min), l'agrège **par heure**
  (12 créneaux : 19h → 6h) sur le fuseau Europe/Paris, et complète le JSON
  avec les nuits manquantes.
- La page `src/pages/index.astro` lit ce JSON au build : barres par nuit,
  moyenne glissante 7 nuits, profil horaire au survol, KPIs énergie et coût
  (prix du kWh modifiable, mémorisé dans le navigateur).
- Le workflow `update-data.yml` tourne chaque matin à 06:15 UTC, commit le
  JSON, redéploie le site et fait tourner le refresh token Enphase
  (il change à chaque utilisation).

## Mise en place

1. Créer une application sur <https://developer-v4.enphase.com> et récupérer
   API key, client ID et client secret.
2. `cp .env.example .env` puis remplir les identifiants.
3. `node scripts/get-tokens.mjs` → ouvrir l'URL affichée, autoriser, puis
   `node scripts/get-tokens.mjs <code>` (écrit le refresh token dans `.env`).
4. `npm install` puis `npm run update-data` (respecte la limite de ~10 appels
   API/min : un gros rattrapage prend du temps).
5. `npm run dev` pour vérifier en local.

## Déploiement GitHub Pages

1. Adapter `site` et `base` dans [astro.config.mjs](astro.config.mjs) au nom
   du compte / repo.
2. Dans les réglages du repo : **Pages → Source → GitHub Actions**.
3. Secrets d'Actions à créer : `ENPHASE_API_KEY`, `ENPHASE_CLIENT_ID`,
   `ENPHASE_CLIENT_SECRET`, `ENPHASE_REFRESH_TOKEN`, `ENPHASE_SYSTEM_ID`,
   et `GH_PAT` (fine-grained PAT limité à ce repo avec la permission
   **Secrets : read and write**, pour la rotation du refresh token).

## Format des données

```json
{
  "systemId": 5734152,
  "timezone": "Europe/Paris",
  "updatedAt": "2026-08-26T06:15:00.000Z",
  "nights": [
    { "date": "2025-08-25", "wh": 4363, "coverage": 0.98,
      "hourlyWh": [331, 746, 359, 338, 349, 269, 277, 284, 292, 287, 276, 555] }
  ]
}
```

`date` est le soir où commence la nuit ; `coverage` est la part d'intervalles
15 min réellement reçus (une nuit incomplète est re-récupérée au passage
suivant et grisée sur le graphique).
