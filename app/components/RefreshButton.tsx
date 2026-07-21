'use client';

import { useEffect, useState } from 'react';
import { RotateCw, Check, Loader2 } from 'lucide-react';
import type { RefreshLifecycleStatus } from "@/lib/types";

type DisplayStatus = RefreshLifecycleStatus | 'idle';

interface RefreshButtonProps {
  status: DisplayStatus;
  onRequest: () => void;
}

const TITLES: Record<DisplayStatus, string> = {
  idle: 'Refresh this row now, ahead of its normal schedule',
  queued: 'Queued — waiting for a free worker',
  'in-progress': 'Fetching the latest price…',
  done: 'Refreshed with the latest price',
};

// How long the checkmark stays up before the button resets to idle and can
// be clicked again. Purely a display decision - the server's own request
// record has a longer TTL (lib/refresh.ts) this doesn't need to match.
const DONE_DISPLAY_MS = 4000;

export default function RefreshButton({ status, onRequest }: RefreshButtonProps) {
  const [display, setDisplay] = useState<DisplayStatus>(status);

  useEffect(() => {
    setDisplay(status);
    if (status !== 'done') return;
    const id = setTimeout(() => setDisplay('idle'), DONE_DISPLAY_MS);
    return () => clearTimeout(id);
  }, [status]);

  const busy = display === 'queued' || display === 'in-progress';

  return (
    <button
      type="button"
      className={`refresh-btn refresh-btn-${display}`}
      disabled={busy}
      title={TITLES[display]}
      aria-label={TITLES[display]}
      onClick={(e) => {
        e.stopPropagation();
        onRequest();
      }}
    >
      {display === 'done' ? (
        <Check size={13} strokeWidth={2.5} aria-hidden="true" />
      ) : busy ? (
        <Loader2 size={13} strokeWidth={2} className="refresh-spin" aria-hidden="true" />
      ) : (
        <RotateCw size={13} strokeWidth={2} aria-hidden="true" />
      )}
    </button>
  );
}
