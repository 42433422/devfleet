import type { ReactElement } from 'react';
import type { DevTool } from '@/lib/devTools';

/** Trae 官方标识（浅色，用于深色胶囊背景） */
export function TraeBrandMark() {
  return (
    <svg width="36" height="12" viewBox="0 0 36 12" fill="none" aria-hidden>
      <path
        d="M14.595 11.212H2.085V9.128H0V0.788H14.595V11.212ZM2.085 9.128H12.51V2.873H2.085V9.128ZM7.298 5.969L5.824 7.443L4.35 5.969L5.824 4.494L7.298 5.969ZM11.468 5.968L9.994 7.442L8.52 5.968L9.994 4.494L11.468 5.968Z"
        fill="white"
      />
      <path
        d="M20.642 3.371H17.705V10.686H15.706V3.371H12.768V1.505H20.642V3.371ZM27.999 3.368H22.941V8.816H27.999V10.684H20.941V1.501H27.999V3.368ZM16.739 1.501C19.016 1.501 19.698 2.261 19.698 4.434C19.698 6.004 19.25 6.724 17.987 7.145L19.709 10.682H17.51L15.92 7.381H13.783V10.682H11.82V1.501H16.739ZM13.785 5.609H16.458C17.127 5.609 17.633 5.383 17.633 4.792V4.146C17.633 3.555 17.127 3.329 16.458 3.329H13.785V5.609Z"
        fill="white"
      />
    </svg>
  );
}

/** Cursor 官方立方体标识 */
export function CursorBrandMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2L2 7L12 12L22 7L12 2Z"
        fill="white"
        fillOpacity="0.95"
      />
      <path
        d="M2 17L12 22L22 17V12L12 17L2 12V17Z"
        fill="white"
        fillOpacity="0.55"
      />
      <path
        d="M2 12L12 17L22 12L12 7L2 12Z"
        fill="white"
        fillOpacity="0.75"
      />
    </svg>
  );
}

/** Codex CLI 标识 */
export function CodexBrandMark() {
  return (
    <svg width="38" height="12" viewBox="0 0 38 12" fill="none" aria-hidden>
      <rect x="0.5" y="1" width="10" height="10" rx="2" stroke="#10B981" strokeWidth="1.2" />
      <path d="M3.2 4.2H7.8M3.2 6H6.4M3.2 7.8H7.2" stroke="#10B981" strokeWidth="1.1" strokeLinecap="round" />
      <path
        d="M14.5 1.6H17.1V10.4H14.5V1.6ZM22.2 3.4H19.4V10.4H17.5V3.4H14.7V1.6H22.2V3.4ZM27.8 1.6C29.6 1.6 30.2 2.2 30.2 3.9C30.2 5.1 29.9 5.7 28.9 6L30.2 10.4H28.4L27.2 6.6H25.2V10.4H23.4V1.6H27.8ZM25.2 5.1H27.4C28 5.1 28.4 4.9 28.4 4.4V3.7C28.4 3.2 28 3 27.4 3H25.2V5.1ZM31.1 7.2H32.2L31.65 5.4L31.1 7.2ZM33.7 10.4H31.8L31.2 8.6H28.3L27.8 10.4H26L28.5 1.6H30.5L33.7 10.4Z"
        fill="#10B981"
      />
    </svg>
  );
}

/** Claude 官方星形标识 */
export function ClaudeBrandMark() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 2.5C12.2 2.5 12.4 2.6 12.5 2.8L14.1 6.1L17.7 6.7C18 6.75 18.2 7 18.15 7.3C18.1 7.45 18 7.6 17.85 7.7L15.1 9.9L15.9 13.5C15.95 13.8 15.75 14.05 15.45 14.1C15.3 14.12 15.15 14.08 15.05 14L12 12.1L8.95 14C8.7 14.15 8.4 14.08 8.25 13.85C8.18 13.75 8.15 13.62 8.17 13.5L8.95 9.9L6.2 7.7C6 7.55 5.95 7.25 6.1 7.05C6.18 6.95 6.3 6.88 6.42 6.85L10 6.1L11.55 2.8C11.65 2.6 11.82 2.5 12 2.5Z"
        fill="#E07A5F"
      />
    </svg>
  );
}

const marks: Record<DevTool, () => ReactElement> = {
  trae: TraeBrandMark,
  codex: CodexBrandMark,
  cursor: CursorBrandMark,
  claude_code: ClaudeBrandMark,
};

export function ToolBrandMark({ tool }: { tool: DevTool }) {
  const Mark = marks[tool];
  return (
    <span className="devfleet-tool-brand" data-tool={tool}>
      <Mark />
    </span>
  );
}
