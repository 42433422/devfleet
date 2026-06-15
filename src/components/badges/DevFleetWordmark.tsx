/** DevFleet 官方横版标识 — 对齐 Trae Solo 徽章规格 (约 92×12) */
export default function DevFleetWordmark({ variant = 'light' }: { variant?: 'light' | 'dark' }) {
  const main = variant === 'light' ? '#FFFFFF' : '#000000';
  const accent = '#32F08C';

  return (
    <svg
      width="92"
      height="12"
      viewBox="0 0 92 12"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className="devfleet-wordmark"
    >
      <path
        d="M14.835 11.212H2.648V9.128H0.563V0.788H14.835V11.212ZM2.648 9.128H12.75V2.873H2.648V9.128ZM7.861 5.969L6.387 7.443L4.913 5.969L6.387 4.494L7.861 5.969ZM12.031 5.968L10.556 7.442L9.082 5.968L10.556 4.494L12.031 5.968Z"
        fill={accent}
      />
      <text
        x="17.5"
        y="9.35"
        fill={main}
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="8.6"
        fontWeight="600"
        letterSpacing="0.01em"
      >
        Dev
      </text>
      <text
        x="33.5"
        y="9.35"
        fill={accent}
        fontFamily="Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
        fontSize="8.6"
        fontWeight="600"
        letterSpacing="0.01em"
      >
        Fleet
      </text>
    </svg>
  );
}
