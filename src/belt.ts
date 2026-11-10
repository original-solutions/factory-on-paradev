export interface BeltV1 {
  readonly v: 1;
  readonly updatedAt: string; // ISO 8601
  readonly runner: {
    readonly host: string;
    readonly version: string;
    readonly paradevCli: string;
    readonly claimsPaused: boolean;
    readonly paradevOnline: boolean;
    readonly lastPassAt: string | null;
  };
  readonly counts: {
    readonly triage: number; readonly building: number; readonly prOpen: number;
    readonly needsInfo: number; readonly stuck: number; readonly finished7d: number;
  };
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly repo: string;
    readonly issue: number;
    readonly title: string | null;   // at most 120 chars
    readonly state: "proposed" | "ready" | "triage" | "needs-info" | "building" | "pr-open" | "stuck" | null;
    readonly step: string | null;    // at most 120 chars
    readonly reason: string | null;  // at most 300 chars
    readonly prUrl: string | null;
    readonly startedTs: string | null;
    readonly finished: boolean;
    readonly totalMs: number | null;
    readonly workspaceId: string | null;
  }>;
  readonly attention: ReadonlyArray<{
    readonly id: string; readonly kind: string; readonly text: string; readonly since: string;
  }>;
}

/** UTF-8 byte length of the payload as stored: `JSON.stringify(payload)`. */
export function beltBytes(payload: BeltV1): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}
