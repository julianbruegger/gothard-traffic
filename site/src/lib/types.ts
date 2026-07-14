export type RoadStatus = 'open' | 'congested' | 'restricted' | 'closed' | 'unknown';

export interface PortalStatus {
  queueKm: number | null;
  waitMinutes: number | null;
  cause: string | null;
  closures?: string[];
}

export interface PassStatus {
  status: RoadStatus;
  note: string | null;
}

export interface GotthardData {
  updated: string | null;
  source: string;
  tunnel: {
    status: RoadStatus;
    north: PortalStatus;
    south: PortalStatus;
  };
  pass: PassStatus;
}

export interface HistoryPoint {
  t: string;
  northQueueKm: number | null;
  southQueueKm: number | null;
  northWaitMinutes: number | null;
  southWaitMinutes: number | null;
}
