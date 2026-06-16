export interface DeviceCapabilities {
  node_version?: string;
  docker?: boolean;
  docker_version?: string;
  gpu?: boolean;
  gpu_name?: string;
  platform?: string;
  arch?: string;
  updated_at?: string;
}

export function parseCapabilities(raw: unknown): DeviceCapabilities | undefined {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as DeviceCapabilities;
    } catch {
      return undefined;
    }
  }
  if (typeof raw === 'object') return raw as DeviceCapabilities;
  return undefined;
}

export function formatCapabilitiesSummary(caps?: DeviceCapabilities): string {
  if (!caps) return '能力未上报';
  const parts: string[] = [];
  if (caps.node_version) parts.push(`Node ${caps.node_version}`);
  parts.push(caps.docker ? `Docker${caps.docker_version ? ` ${caps.docker_version}` : ''}` : '无 Docker');
  parts.push(caps.gpu ? (caps.gpu_name || 'GPU') : '无 GPU');
  return parts.join(' · ');
}
