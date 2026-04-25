// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
// Pure static output deployed to Cloudflare Pages.
// API runs as Pages Functions (web/functions/api/**).
export default defineConfig({
  site: 'https://grid402.climatebrain.xyz',
  output: 'static',
  integrations: [react(), mdx()],
  vite: {
    plugins: [tailwindcss()],
  },
});
