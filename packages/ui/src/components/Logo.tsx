/** Mokie mark: a torii gate whose pillars and inner V form an "M". Dark parts follow the text color. */
export function MokieMark({ size = 28, accent = '#E03131' }: { size?: number; accent?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label="Mokie">
      <path d="M6 22 Q50 12 94 22 L92 31 Q50 23 8 31 Z" fill={accent} />
      <g fill="currentColor">
        <rect x="16" y="40" width="68" height="8" rx="2" />
        <rect x="46" y="28" width="8" height="12" />
        <rect x="24" y="28" width="10" height="62" rx="2" />
        <rect x="66" y="28" width="10" height="62" rx="2" />
      </g>
      <path d="M34 48 L50 70 L66 48" fill="none" stroke="currentColor" strokeWidth="9" strokeLinejoin="round" />
    </svg>
  );
}
