import { useId, type ReactNode } from 'react';

interface TooltipProps {
  label: string;
  children: ReactNode;
}

// Lightweight hover/focus tooltip. No JS positioning - it anchors above
// the trigger, which is fine for the table-cell / card contexts it's used
// in (there's always header/row space above).
export default function Tooltip({ label, children }: TooltipProps) {
  const id = useId();
  return (
    <span className="tooltip-wrap" tabIndex={0} aria-describedby={id}>
      {children}
      <span role="tooltip" id={id} className="tooltip-bubble">
        {label}
      </span>
    </span>
  );
}
