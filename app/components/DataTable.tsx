import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Info, RotateCcw } from 'lucide-react';
import Button from './Button';

export type SortDirection = 'asc' | 'desc';

export interface SortEntry {
  key: string;
  dir: SortDirection;
}

export interface Column<T> {
  key: string;
  label: string;
  align?: 'right';
  render?: (row: T) => ReactNode;
  sortAccessor?: (row: T) => number | string;
  // Optional explanatory text shown as a title/tooltip beside the header
  // label. Use for columns whose meaning isn't obvious from the name alone.
  headerTooltip?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined | null;
  emptyMessage: string;
  defaultSortKey?: string;
  defaultSortDir?: SortDirection;
  // Render the interactive tag-filter chip bar. Only enabled on tabs whose
  // rows carry meaningful tags (arbitrage); ducats stays filter-free.
  enableTagFilter?: boolean;
  // Silently restrict rows to those whose `tags` include this value. Used to
  // lock ducats to prime items without rendering any filter UI.
  fixedTag?: string;
  // Column key whose render/value becomes the card title on mobile.
  cardPrimary: string;
  // Column key whose render/value becomes the highlighted metric on mobile.
  cardHighlight: string;
}

const SORT_ICON_PROPS = {
  className: 'sort-icon',
  'aria-hidden': true,
  size: 14,
  strokeWidth: 2,
} as const;


// Each click cycles one column: not-sorted -> asc -> desc -> not-sorted.
// Columns accumulate, so clicking a second column adds a tiebreaker instead of
// replacing the first (e.g. sort by Profit, then click Updated to break ties
// by freshness). Cycle a column to its neutral state to drop it from the stack.
function nextSort(stack: SortEntry[], key: string): SortEntry[] {
  const existing = stack.find((e) => e.key === key);
  if (!existing) return [...stack, { key, dir: 'asc' }];
  if (existing.dir === 'asc') {
    return stack.map((e) => (e.key === key ? { ...e, dir: 'desc' } : e));
  }
  return stack.filter((e) => e.key !== key);
}
export default function DataTable<T extends { set?: string; item?: string; tags?: string[] }>({
  columns,
  rows,
  emptyMessage,
  defaultSortKey,
  defaultSortDir = 'desc',
  enableTagFilter = false,
  fixedTag,
  cardPrimary,
  cardHighlight,
}: DataTableProps<T>) {
  const defaultStack = useMemo<SortEntry[]>(
    () => (defaultSortKey ? [{ key: defaultSortKey, dir: defaultSortDir }] : []),
    [defaultSortKey, defaultSortDir],
  );
  const [sortStack, setSortStack] = useState<SortEntry[]>(() => defaultStack);

  const sortedRows = useMemo(() => {
    if (!rows || sortStack.length === 0) return rows;
    const accessors = new Map(
      columns.map((c) => [
        c.key,
        (c.sortAccessor as ((row: T) => number | string) | undefined) ??
          ((row: T) => (row as Record<string, unknown>)[c.key] as number | string),
      ]),
    );
    const active = sortStack.filter((e) => accessors.has(e.key));
    if (active.length === 0) return rows;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    return [...rows].sort((a, b) => {
      for (const { key, dir } of active) {
        const accessor = accessors.get(key)!;
        const av = accessor(a);
        const bv = accessor(b);
        const sign = dir === 'asc' ? 1 : -1;
        if (typeof av === 'number' && typeof bv === 'number') {
          const cmp = (av - bv) * sign;
          if (cmp !== 0) return cmp;
        } else {
          const cmp = collator.compare(String(av), String(bv)) * sign;
          if (cmp !== 0) return cmp;
        }
      }
      return 0;
    });
  }, [rows, columns, sortStack]);

  const allTags = useMemo(() => {
    if (!enableTagFilter || !rows) return [];
    const counts = new Map<string, number>();
    for (const row of rows) {
      const tags = (row as { tags?: string[] }).tags;
      if (!tags) continue;
      for (const tag of tags) {
        // 'set' is universal on arbitrage rows (every entry is a _set), so the
        // chip would never narrow anything - hide it.
        if (tag === 'set') continue;
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }, [rows, enableTagFilter]);

  const [activeTags, setActiveTags] = useState<Set<string>>(() => new Set());

  // Drop any selected tags that disappeared from the current dataset
  // (e.g. tab switched, or a scrape removed every item carrying that tag)
  // so the filter never silently zeroes out the table.
  useEffect(() => {
    if (activeTags.size === 0) return;
    const present = new Set(allTags.map((t) => t.tag));
    for (const tag of activeTags) {
      if (!present.has(tag)) {
        setActiveTags(new Set([...activeTags].filter((t) => present.has(t))));
        return;
      }
    }
  }, [allTags, activeTags]);

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const filteredRows = useMemo(() => {
    const base = sortedRows ?? [];
    const afterFixed = fixedTag
      ? base.filter((row) => (row as { tags?: string[] }).tags?.includes(fixedTag) ?? false)
      : base;
    if (activeTags.size === 0) return afterFixed;
    return afterFixed.filter((row) => {
      const tags = (row as { tags?: string[] }).tags;
      if (!tags) return false;
      for (const tag of activeTags) {
        if (!tags.includes(tag)) return false;
      }
      return true;
    });
  }, [sortedRows, activeTags, fixedTag]) ?? [];

  if (!sortedRows || sortedRows.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }


  const handleSort = (key: string) => {
    setSortStack((prev) => nextSort(prev, key));
  };

  const handleKeyDown = (key: string) => (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleSort(key);
    }
  }

  const stackMatchesDefault =
    sortStack.length === defaultStack.length &&
    sortStack.every((e, i) => defaultStack[i]?.key === e.key && defaultStack[i]?.dir === e.dir);

  const handleReset = () => setSortStack(defaultStack);

  const showRanks = sortStack.length > 1;

  const renderCell = (col: Column<T>, row: T): ReactNode =>
    col.render
      ? col.render(row)
      : ((row as Record<string, unknown>)[col.key] as ReactNode);

  const primaryCol = columns.find((c) => c.key === cardPrimary);
  const highlightCol = columns.find((c) => c.key === cardHighlight);
  const detailCols = columns.filter(
    (c) => c.key !== cardPrimary && c.key !== cardHighlight,
  );
  // Order for the mobile sort bar: name first, then the highlighted metric,
  // then the remaining fields — matching the desktop header left-to-right.
  const cardSortCols = [primaryCol, highlightCol, ...detailCols].filter(
    (c): c is Column<T> => Boolean(c),
  );

  const sortInfo = (key: string) => {
    const rank = sortStack.findIndex((e) => e.key === key);
    return { dir: rank >= 0 ? sortStack[rank].dir : undefined, rank };
  };

  // Sort affordance for a mobile card field. Mirrors a desktop <th>: tappable
  // to cycle the column's sort direction, showing the current direction icon
  // and a rank badge when several columns are stacked.
  const cardSortButton = (col: Column<T>): ReactNode => {
    const { dir, rank } = sortInfo(col.key);
    return (
      <button
        type="button"
        className="card-sort"
        aria-pressed={dir ? 'true' : 'false'}
        aria-sort={dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
        aria-label={`Sort by ${col.label}`}
        onClick={() => handleSort(col.key)}
        onKeyDown={handleKeyDown(col.key)}
      >
        <span className="card-sort-label" title={col.headerTooltip}>
          {col.label}
        </span>
        {dir === 'asc' ? (
          <ArrowUp {...SORT_ICON_PROPS} />
        ) : dir === 'desc' ? (
          <ArrowDown {...SORT_ICON_PROPS} />
        ) : (
          <ArrowUpDown {...SORT_ICON_PROPS} />
        )}
        {showRanks && rank >= 0 && (
          <span className="sort-rank" aria-hidden="true">
            {rank + 1}
          </span>
        )}
      </button>
    );
  };
  return (
    <div className="table-wrap">
      {allTags.length > 0 && (
        <div className="tag-filter">
          <span className="tag-filter-label" id="tag-filter-label">
            Tags
          </span>
          <div className="tag-chips" role="group" aria-labelledby="tag-filter-label">
            {allTags.map(({ tag, count }) => {
              const pressed = activeTags.has(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className="tag-chip"
                  aria-pressed={pressed}
                  onClick={() => toggleTag(tag)}
                >
                  <span className="tag-chip-name">{tag}</span>
                  <span className="tag-chip-count">{count}</span>
                </button>
              );
            })}
            {activeTags.size > 0 && (
              <button type="button" className="tag-clear" onClick={() => setActiveTags(new Set())}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}
      <div className="table-toolbar">
        <Button
          variant="ghost"
          onClick={handleReset}
          disabled={stackMatchesDefault}
          aria-label="Reset sort to default"
          icon={<RotateCcw size={13} strokeWidth={2} aria-hidden="true" />}
        >
          Reset sort
        </Button>
      </div>
      {filteredRows.length === 0 ? (
        <div className="empty-state">
          {activeTags.size > 0 ? (
            <>
              No rows match the selected tag filters.
              <button type="button" className="link-button" onClick={() => setActiveTags(new Set())}>
                Clear filters
              </button>
            </>
          ) : (
            emptyMessage
          )}
        </div>
      ) : (
        <>
          <table className="data-table">
            <thead>
              <tr>
                {columns.map((col) => {
                  const rank = sortStack.findIndex((e) => e.key === col.key);
                  const dir = rank >= 0 ? sortStack[rank].dir : undefined;
                  return (
                    <th
                      key={col.key}
                      className={col.align === 'right' ? 'num sortable' : 'sortable'}
                      data-sort={dir ?? 'none'}
                      data-sort-rank={rank >= 0 ? rank + 1 : undefined}
                      tabIndex={0}
                      aria-sort={
                        dir ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                      onClick={() => handleSort(col.key)}
                      onKeyDown={handleKeyDown(col.key)}
                    >
                      <span className="th-label">
                        {col.label}
                        {col.headerTooltip && (
                          <span
                            className="th-info"
                            title={col.headerTooltip}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Info size={12} strokeWidth={2} aria-hidden="true" />
                          </span>
                        )}
                        {dir === 'asc' ? (
                          <ArrowUp {...SORT_ICON_PROPS} />
                        ) : dir === 'desc' ? (
                          <ArrowDown {...SORT_ICON_PROPS} />
                        ) : (
                          <ArrowUpDown {...SORT_ICON_PROPS} />
                        )}
                        {showRanks && rank >= 0 && (
                          <span className="sort-rank" aria-hidden="true">
                            {rank + 1}
                          </span>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((row, i) => (
                <tr key={row.set || row.item || i}>
                  {columns.map((col) => (
                    <td key={col.key} className={col.align === 'right' ? 'num' : ''}>
                      {renderCell(col, row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="card-list" aria-label="Data rows">
            <li className="card-sort-bar" aria-label="Sort by">
              {cardSortCols.map((col) => (
                <span key={col.key}>{cardSortButton(col)}</span>
              ))}
            </li>
            {filteredRows.map((row, i) => (
              <li className="card" key={row.set || row.item || i}>
                <div className="card-row">
                  <div className="card-title">
                    {primaryCol ? renderCell(primaryCol, row) : null}
                  </div>
                  {highlightCol && (
                    <div className="card-highlight">
                      <span className="card-highlight-label">{highlightCol.label}</span>
                      <span className="card-highlight-value">
                        {renderCell(highlightCol, row)}
                      </span>
                    </div>
                  )}
                </div>
                <dl className="card-meta">
                  {detailCols.map((col) => (
                    <div className="card-meta-item" key={col.key}>
                      <dt title={col.headerTooltip}>{col.label}</dt>
                      <dd>{renderCell(col, row)}</dd>
                    </div>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
