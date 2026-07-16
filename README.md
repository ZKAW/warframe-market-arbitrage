# Warframe Market Terminal

## Setup

```bash
bun install
bun dev
```

Open http://localhost:3000. The first full scrape can take a few
minutes depending on how much of the market it has to walk (each item
request is deliberately rate-limited); the UI shows a "first scrape is
still running" state until then.

## Tuning

Optional - copy `.env.local.example` to `.env.local` to adjust scrape
interval, rate-limit backoff, the profit/ratio thresholds for each tab,
and the `PORT` the dashboard listens on (default 3000).

## Type checking

```bash
bun run typecheck
```

## Production

```bash
bun run build
bun start
```
