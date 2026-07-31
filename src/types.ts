import type { PlatformConfig } from "homebridge";

import type { EOJ } from "./echonet/types.js";

export interface ELPlatformConfig extends PlatformConfig {
  enableRefreshSwitch?: boolean;
}

// Stored in accessory.context, which Homebridge serializes into its own accessory
// cache. This is the only place the identity of a device is persisted.
export interface ELAccessoryContext {
  address: string;
  eoj: EOJ;
}
