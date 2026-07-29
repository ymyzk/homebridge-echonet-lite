import fs from "node:fs";
import path from "node:path";

import type { API, Logging } from "homebridge";

import { PLATFORM_NAME } from "./settings.js";
import type { PersistedAccessoryInfo, PersistedStorage } from "./types.js";

// Persists the address/EOJ of registered accessories so they can be restored
// on later boots without a discovery scan.
export class AccessoryStorage {
  private readonly filePath: string;
  private data: PersistedStorage = { accessories: {} };

  constructor(
    api: API,
    private readonly log: Logging,
  ) {
    this.filePath = path.join(api.user.storagePath(), "persist", `${PLATFORM_NAME}.json`);
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as PersistedStorage;
      if (parsed !== null && typeof parsed === "object" && typeof parsed.accessories === "object") {
        this.data = parsed;
      }
    } catch {
      // First run or unreadable file; start empty.
    }
  }

  get(uuid: string): PersistedAccessoryInfo | undefined {
    return this.data.accessories[uuid];
  }

  set(uuid: string, info: PersistedAccessoryInfo): void {
    this.data.accessories[uuid] = info;
    this.save();
  }

  private save(): void {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data));
    } catch (e) {
      this.log.error(`Failed to write settings: ${e}`);
    }
  }
}
