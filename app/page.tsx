'use client';

import { useCallback, useEffect, useState } from 'react';
import DataTable, { type Column, type SortDirection } from './components/DataTable';
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
      { key: 'last_updated', label: 'Updated', align: 'right' },
    ],
    defaultSortKey: 'arbitrage_value',
    defaultSortDir: 'desc',
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
      { key: 'last_updated', label: 'Updated', align: 'right' },
    ],
    defaultSortKey: 'ducat_per_platinum',
    defaultSortDir: 'desc',
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
          {status === 'ok' && lastFetched
            ? `updated ${lastFetched.toLocaleTimeString()}`
            : status}
        </div>
      </header>

      <nav className="tabs">
        {(Object.entries(TABS) as [TabKey, { label: string }][]).map(([key, t]) => (
          <button
            key={key}
            className={key === active ? 'active' : ''}
            onClick={() => setActive(key)}
          >
            {t.label}
          </button>
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
          columns={tab.columns as unknown as Column<Row>[]}
          rows={rows}
          emptyMessage={tab.emptyMessage}
          defaultSortKey={tab.defaultSortKey}
          defaultSortDir={tab.defaultSortDir}
        />
      )}
    </main>
  );
}
