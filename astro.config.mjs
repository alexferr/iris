import { defineConfig } from 'astro/config';

// Adapter `site` et `base` au nom d'utilisateur / repo GitHub.
export default defineConfig({
  site: 'https://alexferr.github.io',
  base: '/iris',
});
