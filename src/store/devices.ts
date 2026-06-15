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
  fetchDevices: () => Promise<void>;
  bindDevice: (name: string) => Promise<{ bindCode: string }>;
  connectDevice: (id: string) => Promise<void>;
  disconnectDevice: (id: string) => Promise<void>;
  deleteDevice: (id: string) => Promise<void>;
  setPrimaryDevice: (id: string) => Promise<void>;
  updateToolStatus: (deviceId: string, toolStatus: ToolStatus[]) => void;
  updateDeviceStatus: (deviceId: string, status: DeviceStatus) => void;
  setCurrentDevice: (device: Device | null) => void;
}

export const useDevicesStore = create<DevicesState>((set, get) => ({
  devices: [],
  currentDevice: null,

  fetchDevices: async () => {
    try {
      const result = await api<{ devices: Device[] }>('/api/devices');
      const devices = result?.devices || [];
      set({ devices });
    } catch {
      set({ devices: [] });
    }
  },

  bindDevice: async (name: string) => {
    // Only get bindCode, don't add device to list until activated
    const res = await api<{ bindCode: string }>('/api/devices/bind', {
      method: 'POST',
      body: { name },
    });
    return { bindCode: res.bindCode || 'DEV-' + Math.random().toString(36).slice(2, 8).toUpperCase() };
  },

  connectDevice: async (id: string) => {
    try {
      await api(`/api/devices/${id}/connect`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to connect device:', err);
    }
    set((s) => ({
      devices: s.devices.map((d) => (d.id === id ? { ...d, status: 'connecting' } : d)),
    }));
  },

  disconnectDevice: async (id: string) => {
    try {
      await api(`/api/devices/${id}/disconnect`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to disconnect device:', err);
    }
    set((s) => ({
      devices: s.devices.map((d) => (d.id === id ? { ...d, status: 'offline' } : d)),
    }));
  },

  deleteDevice: async (id: string) => {
    try {
      await api(`/api/devices/${id}`, { method: 'DELETE' });
      set((s) => ({
        devices: s.devices.filter((d) => d.id !== id),
        currentDevice: s.currentDevice?.id === id ? null : s.currentDevice,
      }));
    } catch (err) {
      console.error('Failed to delete device:', err);
    }
  },

  setPrimaryDevice: async (id: string) => {
    // Optimistically update UI
    set((s) => ({
      devices: s.devices.map((d) => ({
        ...d,
        isPrimary: d.id === id ? true : false,
      })),
    }));
    try {
      await api(`/api/devices/${id}/primary`, { method: 'POST' });
    } catch (err) {
      console.error('Failed to set primary device:', err);
    }
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
}));
