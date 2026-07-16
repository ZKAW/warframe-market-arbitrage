import { useMemo, useState, type ReactNode } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface Column<T> {
  key: string;
  label: string;
  align?: 'right';
  render?: (row: T) => ReactNode;
  sortAccessor?: (row: T) => number | string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined | null;
  emptyMessage: string;
  defaultSortKey?: string;
  defaultSortDir?: SortDirection;
}

export default function DataTable<T extends { set?: string; item?: string }>({
  columns,
  rows,
  emptyMessage,
  defaultSortKey,
  defaultSortDir = 'desc',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSortKey);
  const [sortDir, setSortDir] = useState<SortDirection>(defaultSortDir);

  const sortedRows = useMemo(() => {
    if (!rows || !sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return rows;

    const accessor =
      col.sortAccessor ??
      ((row: T) => (row as Record<string, unknown>)[col.key] as number | string);

    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const sign = sortDir === 'asc' ? 1 : -1;

    return [...rows].sort((a, b) => {
      const av = accessor(a);
      const bv = accessor(b);
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * sign;
      }
      return collator.compare(String(av), String(bv)) * sign;
    });
  }, [rows, columns, sortKey, sortDir]);

  if (!sortedRows || sortedRows.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  const handleSort = (key: string) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      if (key !== defaultSortKey) setSortDir('desc');
    }
  };

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => {
              const active = col.key === sortKey;
              return (
                <th
                  key={col.key}
                  className={col.align === 'right' ? 'num sortable' : 'sortable'}
                  aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={() => handleSort(col.key)}
                >
                  <span className="th-label">
                    {col.label}
                    <span className="sort-indicator">
                      {active ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sortedRows.map((row, i) => (
            <tr key={row.set || row.item || i}>
              {columns.map((col) => (
                <td key={col.key} className={col.align === 'right' ? 'num' : ''}>
                  {col.render
                    ? col.render(row)
                    : ((row as Record<string, unknown>)[col.key] as ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
