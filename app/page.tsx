'use client';

import { useEffect, useState } from 'react';
import DataTable, { type Column, type SortDirection } from './components/DataTable';
import Button from './components/Button';
import Tooltip from './components/Tooltip';
import type { ArbitrageEntry, DucatEntry } from '../lib/types';


type Status = 'loading' | 'ok' | 'error';

interface PipelinePayload {
  data: ArbitrageEntry[] | DucatEntry[];
  ready: boolean;
  lastCycleCompletedAt: string | null;
}

interface SnapshotPayload {
  arbitrage: PipelinePayload;
  ducats: PipelinePayload;
}

interface SliceState<T extends Row> {
  rows: T[];
  ready: boolean;
  fetched: Date | null;
  // ISO timestamp of the last completed scrape cycle for this pipeline,
  // or null if no full cycle has finished yet. Ticks via the regular
  // RelativeTime 1s clock so "X ago" stays live.
  lastCycleCompletedAt: string | null;
}
function emptySlice<T extends Row>(): SliceState<T> {
  return { rows: [], ready: false, fetched: null, lastCycleCompletedAt: null };
}
interface TabConfig<T> {
  label: string;
  emptyMessage: string;
  columns: Column<T>[];
  defaultSortKey: string;
  defaultSortDir: SortDirection;
  enableTagFilter?: boolean;
  fixedTag?: string;
  cardPrimary: string;
  cardHighlight: string;
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

// Header status line. Ticks every second so "X ago" stays live.
// Shows the active pipeline's last update (when an SSE event last
// arrived) plus, once a full cycle has ever completed, when that
// cycle finished. While no cycle has completed yet, says so plainly.
function HeaderUpdatedTime({
  fetched,
  lastCycleCompletedAt,
}: {
  fetched: Date;
  lastCycleCompletedAt: string | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  // If the condition is true, it renders the separator and text. 
  // If false, it evaluates to false and React renders nothing.
  const cyclePart = !lastCycleCompletedAt && (
    <>
      <span className="pulse-sep">·</span>
      cycle still running
    </>
  );

  return (
    <span>
      updated {relativeParts(now - fetched.getTime())}
      {cyclePart}
    </span>
  );
}

// "Min. profit" = 48h volume-weighted average sale price minus parts cost.
// `arbitrage_value` (Profit) uses the single cheapest live sell order for
// the set, which is sometimes a misplaced/outlier listing far under what
// the set actually trades for. avg_price is a much better estimate of what
// a buyer would really pay, so avg_price - parts cost is a floor on the
// profit a flip could realistically clear.
function computeMinProfit(r: ArbitrageEntry): number | null {
  if (r.avg_price == null) return null;
  return r.avg_price - r.total_part_price;
}

type ProfitTier = 'red' | 'orange' | 'green';

// red: the real (average-price) profit is negative - the listed set price
//   is likely a fluke; flipping at real market rates would lose money.
// green: the real profit floor matches or beats the headline Profit - a
//   trustworthy, possibly even better, opportunity.
// orange: real profit is positive but below the headline number - still
//   profitable, just not as good as Profit alone suggests.
function minProfitTier(minProfit: number, profit: number): ProfitTier {
  if (minProfit < 0) return 'red';
  if (minProfit >= profit) return 'green';
  return 'orange';
}

const TABS = {
  arbitrage: {
    label: 'Arbitrage',
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
        key: 'min_profit',
        label: 'Min. profit',
        align: 'right',
        headerTooltip:
          'Profit if the set sells at the 48h average price instead of the current listing (avg price − parts cost). A single cheap sell order can make the Profit column look better than it really is.',
        render: (r) => {
          const minProfit = computeMinProfit(r);
          if (minProfit == null) return '—';
          const tier = minProfitTier(minProfit, r.arbitrage_value);
          const text = `${minProfit >= 0 ? '+' : ''}${Math.round(minProfit)}p`;
          const value = <span className={`min-profit min-profit-${tier}`}>{text}</span>;
          if (tier !== 'red') return value;
          return (
            <Tooltip label="Caution: at the real 48h average price this set would sell at a loss. The current listing is probably a mispriced outlier, not a real profit opportunity.">
              {value}
            </Tooltip>
          );
        },
        sortAccessor: (r) => computeMinProfit(r) ?? -1_000_000,
      },
      {
        key: 'set_price',
        label: 'Set price',
        align: 'right',
        render: (r) => `${r.set_price}p`,
        sortAccessor: (r) => r.set_price,
      },
      {
        key: 'avg_price',
        label: 'Avg price',
        align: 'right',
        render: (r) => (r.avg_price == null ? '—' : `${Math.round(r.avg_price)}p`),
        sortAccessor: (r) => (r.avg_price == null ? -1 : r.avg_price),
      },
      {
        key: 'total_part_price',
        label: 'Parts cost',
        align: 'right',
        render: (r) => `${r.total_part_price}p`,
        sortAccessor: (r) => r.total_part_price,
      },
      {
        key: 'quantity',
        label: 'Qty',
        align: 'right',
        render: (r) => (r.quantity == null ? '—' : `${r.quantity}`),
        sortAccessor: (r) => (r.quantity == null ? -1 : r.quantity),
      },
      {
        key: 'volume',
        label: 'Vol (48h)',
        align: 'right',
        render: (r) => (r.volume == null ? '—' : `${r.volume}`),
        sortAccessor: (r) => (r.volume == null ? -1 : r.volume),
      },
      { key: 'last_updated', label: 'Updated', align: 'right', render: (r) => <RelativeTime iso={r.last_updated} />, sortAccessor: (r) => new Date(r.last_updated).getTime() },
    ],
    defaultSortKey: 'arbitrage_value',
    defaultSortDir: 'desc',
    enableTagFilter: true,
    fixedTag: undefined,
    cardPrimary: 'set',
    cardHighlight: 'arbitrage_value',
  } satisfies TabConfig<ArbitrageEntry>,
  ducats: {
    label: 'Ducats',
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
      { key: 'ducat_per_platinum', label: 'Ducat/p', align: 'right' },
      { key: 'ducats', label: 'Ducats', align: 'right' },
      {
        key: 'platinum_price',
        label: 'Price',
        align: 'right',
        render: (r) => `${r.platinum_price}p`,
        sortAccessor: (r) => r.platinum_price,
      },
      {
        key: 'quantity',
        label: 'Qty',
        align: 'right',
        render: (r) => `${r.quantity}`,
        sortAccessor: (r) => r.quantity,
      },
      { key: 'platinum_per_ducat', label: 'p/Ducat', align: 'right' },
      { key: 'last_updated', label: 'Updated', align: 'right', render: (r) => <RelativeTime iso={r.last_updated} />, sortAccessor: (r) => new Date(r.last_updated).getTime() },
    ],
    defaultSortKey: 'ducat_per_platinum',
    defaultSortDir: 'desc',
    enableTagFilter: undefined,
    fixedTag: 'prime',
    cardPrimary: 'item',
    cardHighlight: 'ducat_per_platinum',
  } satisfies TabConfig<DucatEntry>,
} as const;

type TabKey = keyof typeof TABS;
type Row = ArbitrageEntry | DucatEntry;

export default function Home() {
  const [active, setActive] = useState<TabKey>('arbitrage');
  const [arbitrage, setArbitrage] = useState<SliceState<ArbitrageEntry>>(emptySlice);
  const [ducats, setDucats] = useState<SliceState<DucatEntry>>(emptySlice);
  const [status, setStatus] = useState<Status>('loading');

  const tab = TABS[active];
  const slice = active === 'arbitrage' ? arbitrage : ducats;

  useEffect(() => {
    const stream = new EventSource('/api/stream');

    const onSnapshot = (e: MessageEvent<string>) => {
      const payload = JSON.parse(e.data) as SnapshotPayload;
      const now = new Date();
      setArbitrage({
        rows: payload.arbitrage.data as ArbitrageEntry[],
        ready: payload.arbitrage.ready,
        fetched: now,
        lastCycleCompletedAt: payload.arbitrage.lastCycleCompletedAt,
      });
      setDucats({
        rows: payload.ducats.data as DucatEntry[],
        ready: payload.ducats.ready,
        fetched: now,
        lastCycleCompletedAt: payload.ducats.lastCycleCompletedAt,
      });
      setStatus('ok');
    };

    const onArbitrage = (e: MessageEvent<string>) => {
      const payload = JSON.parse(e.data) as PipelinePayload;
      setArbitrage({
        rows: payload.data as ArbitrageEntry[],
        ready: payload.ready,
        fetched: new Date(),
        lastCycleCompletedAt: payload.lastCycleCompletedAt,
      });
      setStatus('ok');
    };

    const onDucats = (e: MessageEvent<string>) => {
      const payload = JSON.parse(e.data) as PipelinePayload;
      setDucats({
        rows: payload.data as DucatEntry[],
        ready: payload.ready,
        fetched: new Date(),
        lastCycleCompletedAt: payload.lastCycleCompletedAt,
      });
      setStatus('ok');
    };

    // EventSource fires onerror on transient drops AND on a hard close; it
    // auto-reconnects, so only surface the error state if we have nothing
    // to show yet. Once we've had data, keep showing the stale snapshot
    // while the stream reconnects in the background.
    const onError = () => {
      if (!arbitrage.fetched && !ducats.fetched) setStatus('error');
    };

    stream.addEventListener('snapshot', onSnapshot);
    stream.addEventListener('arbitrage', onArbitrage);
    stream.addEventListener('ducats', onDucats);
    stream.addEventListener('error', onError);

    return () => {
      stream.removeEventListener('snapshot', onSnapshot);
      stream.removeEventListener('arbitrage', onArbitrage);
      stream.removeEventListener('ducats', onDucats);
      stream.removeEventListener('error', onError);
      stream.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onError reads
    // stale slice state, but the intent is "no data yet"; re-subscribing on
    // every fetch would thrash the stream. The once-per-mount subscription
    // is correct.
  }, []);

  return (
    <main>
      <header className="topbar">
        <h1>
          warframe.market <span>terminal</span>
        </h1>
        <div className={`pulse pulse-${status}`}>
          <span className="dot" />
          {status === 'ok' && slice.fetched ? (
            <HeaderUpdatedTime fetched={slice.fetched} lastCycleCompletedAt={slice.lastCycleCompletedAt} />
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
      ) : status === 'ok' && !slice.ready && slice.rows.length === 0 ? (
        <div className="empty-state">First scrape is still running - this can take a few minutes.</div>
      ) : (
        // The active tab's columns are typed to its own row shape (ArbitrageEntry
        // or DucatEntry) for safety while authoring TABS above; here we render
        // whichever is active against the matching slice of `rows`, so we widen
        // to the shared Row union at this single boundary.
        <DataTable
          key={active}
          columns={tab.columns as unknown as Column<Row>[]}
          rows={slice.rows}
          emptyMessage={tab.emptyMessage}
          fixedTag={tab.fixedTag}
          defaultSortKey={tab.defaultSortKey}
          defaultSortDir={tab.defaultSortDir}
          enableTagFilter={tab.enableTagFilter}
          cardPrimary={tab.cardPrimary}
          cardHighlight={tab.cardHighlight}
        />
      )}
    </main>
  );
}
