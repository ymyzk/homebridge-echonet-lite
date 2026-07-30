import fs from "node:fs";
import path from "node:path";

import type { API } from "homebridge";

import { parseAccessoryContext } from "./accessory-context.js";
import { PLATFORM_NAME } from "./settings.js";
import type { ELAccessoryContext } from "./types.js";

interface LegacyStorage {
  // Keyed by accessory UUID.
  accessories: Record<string, unknown>;
}

// Releases before 2.0 kept the address/EOJ of each accessory in their own JSON
// file next to HAP's persist data. It is read once to back-fill accessory
// contexts on upgrade; nothing writes to it any more.
export function readLegacyStorage(api: API): Map<string, ELAccessoryContext> {
  const filePath = path.join(api.user.storagePath(), "persist", `${PLATFORM_NAME}.json`);
  const contexts = new Map<string, ELAccessoryContext>();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as LegacyStorage;
    for (const [uuid, value] of Object.entries(parsed?.accessories ?? {})) {
      const context = parseAccessoryContext(value);
      if (context) {
        contexts.set(uuid, context);
      }
    }
  } catch {
    // No legacy file (i.e. a fresh install) or it is unreadable; nothing to migrate.
  }
  return contexts;
}
