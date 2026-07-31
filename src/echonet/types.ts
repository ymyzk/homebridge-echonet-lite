// ECHONET Lite object code: [class group code, class code, instance code].
export type EOJ = [number, number, number];

// The ECHONET Lite objects that answered a discovery scan at one address. Each
// becomes a device here.
export interface DiscoveredObjects {
  address: string;
  eojList: EOJ[];
}
