import CornerPillBadge from '@/components/badges/CornerPillBadge';
import DevFleetWordmark from '@/components/badges/DevFleetWordmark';
import TraeSoloWordmark from '@/components/badges/TraeSoloWordmark';
import { CodexWordmark, CursorCubeLogo, ClaudeStarLogo } from '@/components/badges/PartnerWordmarks';

/** 右下角：每个品牌独立胶囊，自下而上排列，互不合并 */
export default function SupportedToolsCorner() {
  return (
    <div className="devfleet-corner-stack" aria-label="DevFleet 与支持的工具">
      <CornerPillBadge dismissKey="devfleet" to="/integration" title="DevFleet — MCP 接入" width={130}>
        <DevFleetWordmark variant="light" />
      </CornerPillBadge>

      <CornerPillBadge dismissKey="trae" to="/integration" title="Trae — MCP 接入" width={130}>
        <TraeSoloWordmark />
      </CornerPillBadge>

      <CornerPillBadge dismissKey="codex" to="/integration" title="Codex — MCP 接入" width={130}>
        <CodexWordmark />
      </CornerPillBadge>

      <CornerPillBadge dismissKey="cursor" to="/integration" title="Cursor — MCP 接入" width={56}>
        <CursorCubeLogo />
      </CornerPillBadge>

      <CornerPillBadge dismissKey="claude" to="/integration" title="Claude Code — MCP 接入" width={56}>
        <ClaudeStarLogo />
      </CornerPillBadge>
    </div>
  );
}
