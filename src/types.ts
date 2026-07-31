import type { PlatformConfig } from "homebridge";

// ECHONET Lite object code: [class group code, class code, instance code].
export type EOJ = [number, number, number];

// The ECHONET Lite objects that answered a discovery scan at one address. Each
// becomes a device here.
export interface DiscoveredObjects {
  address: string;
  eojList: EOJ[];
}

export interface ELPlatformConfig extends PlatformConfig {
  enableRefreshSwitch?: boolean;
}

// Stored in accessory.context, which Homebridge serializes into its own accessory
// cache. This is the only place the identity of a device is persisted.
export interface ELAccessoryContext {
  address: string;
  eoj: EOJ;
}
