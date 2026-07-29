import type { PlatformConfig } from "homebridge";

// ECHONET Lite object code: [class group code, class code, instance code].
export type EOJ = [number, number, number];

export interface DiscoveredDevice {
  address: string;
  eoj: EOJ[];
}

export interface ELPlatformConfig extends PlatformConfig {
  enableRefreshSwitch?: boolean;
}

export interface PersistedAccessoryInfo {
  address: string;
  eoj: EOJ;
}

export interface PersistedStorage {
  // Keyed by accessory UUID.
  accessories: Record<string, PersistedAccessoryInfo>;
}
