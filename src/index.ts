import type { API } from "homebridge";

import { ELPlatform } from "./platform.js";
import { PLATFORM_NAME } from "./settings.js";

// Called by Homebridge to register the platform plugin.
export default (api: API) => {
  api.registerPlatform(PLATFORM_NAME, ELPlatform);
};
