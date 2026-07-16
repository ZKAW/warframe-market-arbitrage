'use client';

import { useCallback, useEffect, useState } from 'react';
import DataTable, { type Column, type SortDirection } from './components/DataTable';
import Button from './components/Button';
import type { ArbitrageEntry, DucatEntry } from '../lib/types';

const REFRESH_MS = 15000;

type Status = 'loading' | 'ok' | 'error';

interface TabConfig<T> {
  label: string;
  endpoint: string;
  emptyMessage: string;
  columns: Column<T>[];
  defaultSortKey: string;
  defaultSortDir: SortDirection;
  enableTagFilter?: boolean;
  fixedTag?: string;
}

const relativeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000_000],
  ['month', 2_592_000_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1_000],
];

// Floor future diffs (server clock skew or a just-written timestamp) to 0 so
// the display never reads "in N seconds" - this measures elapsed time since
// the last update, never a future moment.
function relativeParts(ms: number) {
  const elapsed = Math.max(0, ms);
  for (const [unit, size] of RELATIVE_UNITS) {
    if (elapsed >= size) return relativeFormatter.format(-Math.round(elapsed / size), unit);
  }
  return relativeFormatter.format(0, 'second');
}

// Elapsed time since `iso`. Ticks every second so the seconds counter is live.
function RelativeTime({ iso }: { iso: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  const absolute = new Date(iso).toLocaleString();
  return (
    <time dateTime={iso} title={absolute}>
      {relativeParts(now - new Date(iso).getTime())}
    </time>
  );
}

// Header status line. Ticks every second so the "X ago" suffix counts seconds.
function HeaderUpdatedTime({ fetched }: { fetched: Date }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);
  return (
    <span>
      updated {fetched.toLocaleTimeString()} ({relativeParts(now - fetched.getTime())})
    </span>
  );
}

const TABS = {
  arbitrage: {
    label: 'Arbitrage',
    endpoint: '/api/arbitrage',
    emptyMessage: 'No profitable sets right now. Check back later.',
    columns: [
      {
        key: 'set',
        label: 'Set',
        render: (r) => (
          <a href={r.market_url} target="_blank" rel="noreferrer">
            {r.set}
          </a>
        ),
      },
      {
        key: 'arbitrage_value',
        label: 'Profit',
        align: 'right',
        render: (r) => `+${r.arbitrage_value}p`,
        sortAccessor: (r) => r.arbitrage_value,
      },
      {
        key: 'set_price',
        label: 'Set price',
        align: 'right',
        render: (r) => `${r.set_price}p`,
        sortAccessor: (r) => r.set_price,
      },
      {
        key: 'total_part_price',
        label: 'Parts cost',
        align: 'right',
        render: (r) => `${r.total_part_price}p`,
        sortAccessor: (r) => r.total_part_price,
      },
      { key: 'last_updated', label: 'Updated', align: 'right', render: (r) => <RelativeTime iso={r.last_updated} />, sortAccessor: (r) => new Date(r.last_updated).getTime() },
    ],
    defaultSortKey: 'arbitrage_value',
    defaultSortDir: 'desc',
    enableTagFilter: true,
    fixedTag: undefined,
  } satisfies TabConfig<ArbitrageEntry>,
  ducats: {
    label: 'Ducats',
    endpoint: '/api/ducats',
    emptyMessage: 'No ducat deals clearing the bar right now.',
    columns: [
      {
        key: 'item',
        label: 'Item',
        render: (r) => (
          <a href={r.market_url} target="_blank" rel="noreferrer">
            {r.item}
          </a>
        ),
      },
      { key: 'ducats', label: 'Ducats', align: 'right' },
      {
        key: 'platinum_price',
        label: 'Price',
        align: 'right',
        render: (r) => `${r.platinum_price}p`,
        sortAccessor: (r) => r.platinum_price,
      },
      { key: 'ducat_per_platinum', label: 'Ducat/p', align: 'right' },
      { key: 'platinum_per_ducat', label: 'p/Ducat', align: 'right' },
      { key: 'last_updated', label: 'Updated', align: 'right', render: (r) => <RelativeTime iso={r.last_updated} />, sortAccessor: (r) => new Date(r.last_updated).getTime() },
    ],
    defaultSortKey: 'ducat_per_platinum',
    defaultSortDir: 'desc',
    enableTagFilter: undefined,
    fixedTag: 'prime',
  } satisfies TabConfig<DucatEntry>,
} as const;

type TabKey = keyof typeof TABS;
type Row = ArbitrageEntry | DucatEntry;

export default function Home() {
  const [active, setActive] = useState<TabKey>('arbitrage');
  const [rows, setRows] = useState<Row[]>([]);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<Status>('loading');
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const tab = TABS[active];

  const load = useCallback(async () => {
    try {
      const res = await fetch(tab.endpoint, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Request failed');
      setRows(Array.isArray(body.data) ? body.data : []);
      setReady(Boolean(body.ready));
      setStatus('ok');
      setLastFetched(new Date());
    } catch {
      setStatus('error');
    }
  }, [tab.endpoint]);

  useEffect(() => {
    setStatus('loading');
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <main>
      <header className="topbar">
        <h1>
          warframe.market <span>terminal</span>
        </h1>
        <div className={`pulse pulse-${status}`}>
          <span className="dot" />
          {status === 'ok' && lastFetched ? (
            <HeaderUpdatedTime fetched={lastFetched} />
          ) : (
            status
          )}
        </div>
      </header>

      <nav className="tabs">
        {(Object.entries(TABS) as [TabKey, { label: string }][]).map(([key, t]) => (
          <Button
            key={key}
            variant="tab"
            isActive={key === active}
            onClick={() => setActive(key)}
          >
            {t.label}
          </Button>
        ))}
      </nav>

      {status === 'error' ? (
        <div className="empty-state error">Something went wrong loading this data. Retrying shortly.</div>
      ) : status === 'ok' && !ready && rows.length === 0 ? (
        <div className="empty-state">First scrape is still running - this can take a few minutes.</div>
      ) : (
        // The active tab's columns are typed to its own row shape (ArbitrageEntry
        // or DucatEntry) for safety while authoring TABS above; here we render
        // whichever is active against the matching slice of `rows`, so we widen
        // to the shared Row union at this single boundary.
        <DataTable
          key={active}
          columns={tab.columns as unknown as Column<Row>[]}
          rows={rows}
          emptyMessage={tab.emptyMessage}
          fixedTag={tab.fixedTag}
          defaultSortKey={tab.defaultSortKey}
          defaultSortDir={tab.defaultSortDir}
          enableTagFilter={tab.enableTagFilter}
        />
      )}
    </main>
  );
}
