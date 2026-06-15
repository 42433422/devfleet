import type { ReactNode } from 'react';
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

interface CornerPillBadgeProps {
  to: string;
  title: string;
  children: ReactNode;
}

/** 单个独立胶囊角标 — 与 Trae Solo 同款规格 */
export default function CornerPillBadge({ to, title, children }: CornerPillBadgeProps) {
  return (
    <Link to={to} className="devfleet-pill-badge" title={title} aria-label={title}>
      <span className="devfleet-pill-badge-logo">{children}</span>
      <ShareIcon />
    </Link>
  );
}
