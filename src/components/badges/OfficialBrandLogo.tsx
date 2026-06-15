import traeOfficial from '@/assets/badges/trae-official.svg';
import codexOfficial from '@/assets/badges/codex-official.svg';
import claudeOfficialLight from '@/assets/badges/claude-official-light.svg';
import cursorOfficial from '@/assets/badges/cursor-official.svg';

const brandAssets = {
  trae: { src: traeOfficial, alt: 'Trae', className: 'devfleet-official-brand' },
  codex: { src: codexOfficial, alt: 'Codex', className: 'devfleet-official-brand' },
  cursor: { src: cursorOfficial, alt: 'Cursor', className: 'devfleet-official-brand' },
  claude: { src: claudeOfficialLight, alt: 'Claude', className: 'devfleet-official-brand' },
} as const;

export type OfficialBrand = keyof typeof brandAssets;

export function OfficialBrandLogo({ brand }: { brand: OfficialBrand }) {
  const { src, alt, className } = brandAssets[brand];
  return <img src={src} alt={alt} className={className} height={12} draggable={false} />;
}
