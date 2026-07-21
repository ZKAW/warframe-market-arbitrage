'use client';

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

interface TooltipProps {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}

type Placement = 'above' | 'below';

interface BubblePosition {
  top?: number;
  bottom?: number;
  right: number;
  placement: Placement;
}

const MIN_SPACE_ABOVE = 110;

export default function Tooltip({ label, children, className }: TooltipProps) {
  const id = useId();
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<BubblePosition | null>(null);

  const measure = () => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const right = window.innerWidth - rect.right;
    if (rect.top >= MIN_SPACE_ABOVE) {
      setPos({ bottom: window.innerHeight - rect.top + 7, right, placement: 'above' });
    } else {
      setPos({ top: rect.bottom + 7, right, placement: 'below' });
    }
  };

  useLayoutEffect(() => {
    if (open) measure();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
    };
  }, [open]);

  const bubbleClass = ['tooltip-bubble', `tooltip-bubble-${pos?.placement ?? 'above'}`, className]
    .filter(Boolean)
    .join(' ');

  return (
    <span
      ref={triggerRef}
      className="tooltip-wrap"
      tabIndex={0}
      aria-describedby={id}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {children}
      {open && pos
        ? createPortal(
            <span
              role="tooltip"
              id={id}
              className={bubbleClass}
              style={{ top: pos.top, bottom: pos.bottom, right: pos.right }}
            >
              {label}
            </span>,
            document.body
          )
        : null}
    </span>
  );
}
