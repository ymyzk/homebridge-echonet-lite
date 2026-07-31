import { toHex } from "./utils.js";

// Manufacturer codes (EPC 0x8A) as assigned by the ECHONET Consortium, taken
// from its published member list:
// https://echonet.jp/wp/wp-content/uploads/pdf/General/Echonet/ManufacturerCode/list_code.pdf
//
// The list holds several hundred members, most of them meters, inverters and
// system integrators that this plugin has no handler for. Only the vendors whose
// lighting and air conditioners a user is plausibly running are named here;
// anything else falls back to the code itself, which is still enough to look up.
// The names are the English ones the vendors trade under rather than literal
// translations of the registered Japanese company names, since this is what
// HomeKit shows the user.
const MANUFACTURER_NAMES = new Map<number, string>([
  [0x000001, "Hitachi"],
  [0x000005, "Sharp"],
  [0x000006, "Mitsubishi Electric"],
  [0x000008, "Daikin"],
  [0x00000b, "Panasonic"],
  [0x000016, "Toshiba"],
  // Formerly Toshiba Carrier, renamed in 2024.
  [0x000017, "Japan Carrier"],
  [0x00001b, "Toshiba Lighting & Technology"],
  [0x000022, "Hitachi Global Life Solutions"],
  [0x000025, "LIXIL"],
  [0x00002f, "Aiphone"],
  [0x00003b, "Kyocera"],
  [0x00004e, "Fujitsu"],
  [0x000054, "Noritz"],
  [0x000059, "Rinnai"],
  [0x000064, "Omron Social Solutions"],
  [0x000067, "Corona"],
  [0x000069, "Toshiba Lifestyle"],
  [0x000082, "Purpose"],
  [0x000088, "Chofu Seisakusho"],
  // Registered as General since 2026; sold as Fujitsu General.
  [0x00008a, "Fujitsu General"],
  [0x000091, "NEC Platforms"],
  [0x000105, "Mitsubishi Electric Lighting"],
  [0x000127, "Paloma"],
  // Formerly Hitachi-Johnson Controls Air Conditioning, renamed in 2025.
  [0x0000cc, "Bosch Home Comfort Japan"],
  [0x0000e8, "Koizumi Lighting"],
  [0x0000f5, "Odelic"],
]);

// The name to show for a manufacturer code, falling back to the code as the spec
// writes it, e.g. "0x00000b", for a vendor missing from the table above.
export function manufacturerName(code: number): string {
  return MANUFACTURER_NAMES.get(code) ?? toHex(code, 6);
}
