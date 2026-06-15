import traeOfficial from '@/assets/badges/trae-official.svg';
import codexTemplateOfficial from '@/assets/badges/codex-template-official.png';
import claudeOfficialLight from '@/assets/badges/claude-official-light.svg';
import cursorOfficial from '@/assets/badges/cursor-official.svg';

const brandAssets = {
  trae: { src: traeOfficial, alt: 'Trae', className: 'devfleet-official-brand' },
  cursor: { src: cursorOfficial, alt: 'Cursor', className: 'devfleet-official-brand' },
  claude: { src: claudeOfficialLight, alt: 'Claude', className: 'devfleet-official-brand' },
} as const;

export type OfficialBrand = keyof typeof brandAssets | 'codex';

export function OfficialBrandLogo({ brand }: { brand: OfficialBrand }) {
  if (brand === 'codex') {
    return (
      <span className="devfleet-codex-brand" aria-label="Codex">
        <img src={codexTemplateOfficial} alt="" className="devfleet-codex-brand-icon" draggable={false} />
        <span>Codex</span>
      </span>
    );
  }

  const { src, alt, className } = brandAssets[brand];
  return <img src={src} alt={alt} className={className} height={12} draggable={false} />;
}
