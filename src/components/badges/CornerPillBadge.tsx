import type { ReactNode } from 'react';
import { useState } from 'react';
import { Link } from 'react-router-dom';

function ShareIcon() {
  return (
    <svg width="15" height="14" viewBox="0 0 15 14" fill="none" aria-hidden className="devfleet-pill-badge-share">
      <path
        d="M5.68693 2.33333H2.77026V11.6667H12.1036V8.75M8.6036 2.33333H12.1036V5.83333M6.8536 7.58333L11.5203 2.91666"
        stroke="currentColor"
        strokeWidth="1.05"
        strokeLinecap="square"
      />
    </svg>
  );
}

function DismissIcon() {
  return (
    <svg width="16" height="15" viewBox="0 0 16 15" fill="none" aria-hidden>
      <path
        d="M0.437012 7.5C0.437012 3.35786 3.79488 0 7.93701 0C12.0791 0 15.437 3.35786 15.437 7.5C15.437 11.6421 12.0791 15 7.93701 15C3.79488 15 0.437012 11.6421 0.437012 7.5Z"
        fill="#2A2D31"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M7.93698 1.34036C11.3391 1.34036 14.0966 4.09792 14.0966 7.5C14.0966 10.9021 11.3391 13.6596 7.93698 13.6596C4.53491 13.6596 1.77734 10.9021 1.77734 7.5C1.77734 4.09792 4.53491 1.34036 7.93698 1.34036Z"
        fill="white"
      />
      <path
        d="M7.93717 6.70886L9.40826 5.23776L9.80383 4.84128L10.5959 5.63334L10.1994 6.02891L8.72831 7.5L10.1994 8.9711L10.5959 9.36667L9.80383 10.1587L9.40826 9.76224L7.93717 8.29115L6.46607 9.76224L6.0705 10.1587L5.27844 9.36667L5.67493 8.9711L7.14602 7.5L5.67493 6.02891L5.27844 5.63334L6.0705 4.84128L6.46607 5.23776L7.93717 6.70886Z"
        fill="black"
      />
    </svg>
  );
}

interface CornerPillBadgeProps {
  dismissKey: string;
  to: string;
  title: string;
  width?: number;
  children: ReactNode;
}

/** 单个独立胶囊角标 — 与 Trae Solo 同款，各自可关闭 */
export default function CornerPillBadge({ dismissKey, to, title, width = 130, children }: CornerPillBadgeProps) {
  const storageKey = `devfleet_badge_dismissed_${dismissKey}`;
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(storageKey) === '1',
  );

  if (dismissed) return null;

  const dismiss = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    localStorage.setItem(storageKey, '1');
    setDismissed(true);
  };

  return (
    <div className="devfleet-pill-badge-wrap">
      <Link
        to={to}
        className="devfleet-pill-badge"
        style={{ width }}
        title={title}
        aria-label={title}
      >
        <span className="devfleet-pill-badge-logo">{children}</span>
        <ShareIcon />
      </Link>
      <button type="button" className="devfleet-pill-badge-dismiss" onClick={dismiss} aria-label={`隐藏 ${title}`}>
        <DismissIcon />
      </button>
    </div>
  );
}
