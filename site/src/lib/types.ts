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

/** An announced, not-yet-active tunnel closure (e.g. a night-time special transport). */
export interface ClosureWindow {
  from: string;
  to: string | null;
  cause: string | null;
}

export interface GotthardData {
  updated: string | null;
  source: string;
  tunnel: {
    status: RoadStatus;
    north: PortalStatus;
    south: PortalStatus;
    plannedClosures?: ClosureWindow[];
  };
  pass: PassStatus;
}

export interface HistoryPoint {
  t: string;
  northQueueKm: number | null;
  southQueueKm: number | null;
  northWaitMinutes: number | null;
  southWaitMinutes: number | null;
  /** Tunnel road status at this sample. Absent in older records (treated as unknown). */
  status?: RoadStatus;
}
