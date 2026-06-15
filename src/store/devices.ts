import { create } from 'zustand';
import { api } from '@/lib/api';

export type DeviceStatus = 'online' | 'offline' | 'connecting';
export type ToolName = 'codex' | 'trae' | 'cursor' | 'claude_code';
export type ToolState = 'running' | 'idle' | 'not_installed';

export interface ToolStatus {
  toolName: ToolName;
  status: ToolState;
  currentTask?: string;
}

export interface Device {
  id: string;
  name: string;
  status: DeviceStatus;
  tools: ToolStatus[];
  lastSeen: string;
  activated?: boolean;
  isPrimary?: boolean;
}

interface DevicesState {
  devices: Device[];
  currentDevice: Device | null;
  loading: boolean;
  error: string | null;
  fetchDevices: () => Promise<void>;
  bindDevice: (name: string) => Promise<{ bindCode: string; deviceId?: string; expiresAt?: string }>;
  connectDevice: (id: string) => Promise<void>;
  disconnectDevice: (id: string) => Promise<void>;
  deleteDevice: (id: string) => Promise<void>;
  setPrimaryDevice: (id: string) => Promise<void>;
  updateToolStatus: (deviceId: string, toolStatus: ToolStatus[]) => void;
  updateDeviceStatus: (deviceId: string, status: DeviceStatus) => void;
  setCurrentDevice: (device: Device | null) => void;
  clearError: () => void;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试';

export const useDevicesStore = create<DevicesState>((set) => ({
  devices: [],
  currentDevice: null,
  loading: false,
  error: null,

  fetchDevices: async () => {
    set({ loading: true, error: null });
    try {
      const result = await api<{ devices: Device[] }>('/api/devices');
      const devices = result?.devices || [];
      set({ devices, loading: false });
    } catch (error) {
      set({ loading: false, error: errorMessage(error) });
    }
  },

  bindDevice: async (name: string) => {
    // Only get bindCode, don't add device to list until activated
    const res = await api<{ bindCode: string; deviceId?: string; expiresAt?: string }>('/api/devices/bind', {
      method: 'POST',
      body: { name },
    });
    return { bindCode: res.bindCode, deviceId: res.deviceId, expiresAt: res.expiresAt };
  },

  connectDevice: async (id: string) => {
    const result = await api<{ device: Device }>(`/api/devices/${id}/connect`, { method: 'POST' });
    set((s) => ({
      devices: s.devices.map((d) => (d.id === id ? result.device : d)),
      error: null,
    }));
  },

  disconnectDevice: async (id: string) => {
    const result = await api<{ device: Device }>(`/api/devices/${id}/disconnect`, { method: 'POST' });
    set((s) => ({
      devices: s.devices.map((d) => (d.id === id ? result.device : d)),
      error: null,
    }));
  },

  deleteDevice: async (id: string) => {
    await api(`/api/devices/${id}`, { method: 'DELETE' });
    set((s) => ({
      devices: s.devices.filter((d) => d.id !== id),
      currentDevice: s.currentDevice?.id === id ? null : s.currentDevice,
      error: null,
    }));
  },

  setPrimaryDevice: async (id: string) => {
    await api(`/api/devices/${id}/primary`, { method: 'POST' });
    set((s) => ({
      devices: s.devices.map((d) => ({
        ...d,
        isPrimary: d.id === id,
      })),
      error: null,
    }));
  },

  updateToolStatus: (deviceId: string, toolStatus: ToolStatus[]) => {
    set((s) => ({
      devices: s.devices.map((d) => (d.id === deviceId ? { ...d, tools: toolStatus } : d)),
    }));
  },

  updateDeviceStatus: (deviceId: string, status: DeviceStatus) => {
    set((s) => ({
      devices: s.devices.map((d) =>
        d.id === deviceId ? { ...d, status, lastSeen: new Date().toISOString() } : d
      ),
    }));
  },

  setCurrentDevice: (device) => set({ currentDevice: device }),
  clearError: () => set({ error: null }),
}));
