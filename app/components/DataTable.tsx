import type { ReactNode } from 'react';

export interface Column<T> {
  key: string;
  label: string;
  align?: 'right';
  render?: (row: T) => ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[] | undefined | null;
  emptyMessage: string;
}

export default function DataTable<T extends { set?: string; item?: string }>({
  columns,
  rows,
  emptyMessage,
}: DataTableProps<T>) {
  if (!rows || rows.length === 0) {
    return <div className="empty-state">{emptyMessage}</div>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} className={col.align === 'right' ? 'num' : ''}>
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
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
