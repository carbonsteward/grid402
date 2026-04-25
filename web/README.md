# Grid402 — web (`grid402.climatebrain.xyz`)

The map MVP, x402 docs, and landing page.

**Stack:** Astro + React islands + Tailwind v4 + MDX, deployed to Cloudflare Pages.

## Local dev

```bash
cp .env.example .env       # set PUBLIC_GRID402_API=http://localhost:3402
pnpm install
pnpm dev                   # → http://localhost:4321
```

In another terminal, run the API so the live map can fetch:

```bash
cd ../api && pnpm dev      # → http://localhost:3402
```

## Build

```bash
pnpm build                 # → dist/ (static client + Cloudflare worker for SSR)
pnpm preview               # serve the built output locally
```

## Pages structure

| Route | File | Type |
|---|---|---|
| `/` | `src/pages/index.astro` | Landing + LiveMap (React island) |
| `/docs` | `src/pages/docs/index.astro` | Docs index |
| `/docs/quickstart` | `src/pages/docs/quickstart.mdx` | MDX |
| `/docs/x402` | `src/pages/docs/x402.mdx` | MDX |
| `/docs/endpoints` | `src/pages/docs/endpoints.mdx` | MDX |
| `/docs/isos` | `src/pages/docs/isos.mdx` | MDX |

## Deploy to Cloudflare Pages

1. Push to `main` on `carbonsteward/grid402`.
2. In Cloudflare dashboard → Pages → Create application → Connect to GitHub.
3. Select `carbonsteward/grid402`. Set:
   - **Build command:** `cd web && pnpm install && pnpm build`
   - **Build output:** `web/dist/client`
   - **Root directory:** `/` (monorepo)
   - **Env vars:** `PUBLIC_GRID402_API=https://grid402.climatebrain.xyz/api`
4. Add custom domain: `grid402.climatebrain.xyz` (zone already in your CF account).
5. The API itself deploys separately (Cloudflare Worker or Railway) and is routed at `grid402.climatebrain.xyz/api/*` via either CF route rules or a Pages Function rewrite.
