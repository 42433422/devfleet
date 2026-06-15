import { useState } from 'react';
import CornerPillBadge from '@/components/badges/CornerPillBadge';
import { OfficialBrandLogo, type OfficialBrand } from '@/components/badges/OfficialBrandLogo';

const STORAGE_KEY = 'devfleet_partner_badges_dismissed';

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

const PARTNER_BADGES: { key: OfficialBrand; title: string }[] = [
  { key: 'trae', title: 'Trae — MCP 接入' },
  { key: 'codex', title: 'Codex — MCP 接入' },
  { key: 'cursor', title: 'Cursor — MCP 接入' },
  { key: 'claude', title: 'Claude Code — MCP 接入' },
];

/** 右下角 4 个独立工具胶囊，均使用官方品牌资源 */
export default function SupportedToolsCorner() {
  const [dismissed, setDismissed] = useState(
    () => typeof window !== 'undefined' && localStorage.getItem(STORAGE_KEY) === '1',
  );

  if (dismissed) return null;

  return (
    <div className="devfleet-corner-stack" aria-label="支持的 AI 开发工具">
      {PARTNER_BADGES.map((badge) => (
        <CornerPillBadge key={badge.key} to="/integration" title={badge.title}>
          <OfficialBrandLogo brand={badge.key} />
        </CornerPillBadge>
      ))}

      <button
        type="button"
        className="devfleet-corner-stack-dismiss"
        onClick={() => {
          localStorage.setItem(STORAGE_KEY, '1');
          setDismissed(true);
        }}
        aria-label="隐藏工具角标"
      >
        <DismissIcon />
      </button>
    </div>
  );
}
