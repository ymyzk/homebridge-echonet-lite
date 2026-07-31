// ECHONET Lite property code (EPC), e.g. 0x80. Only meaningful together with a
// device class: 0xB0 is the illuminance level of a lighting object and the
// operation mode of an air conditioner.
export type EPC = number;

// ECHONET Lite object code: [class group code, class code, instance code].
export type EOJ = [number, number, number];

// The ECHONET Lite objects that answered a discovery scan at one address. Each
// becomes a device here.
export interface DiscoveredObjects {
  address: string;
  eojList: EOJ[];
}
