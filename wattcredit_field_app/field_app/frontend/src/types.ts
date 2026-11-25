export interface Cred { pub: JsonWebKey; priv: JsonWebKey }

export interface ShiftBlock {
  plugId: string; seq: number; tStart: number; tEnd: number;
  workMin: number; idleMin: number; otherMin: number;
  creditedMwh: number; vrmsDv: number; irmsCa: number; trips: number;
  prevHash: string; hash: string; sig: string;
}

export interface PlugRec {
  id: string; pub: JsonWebKey; entrepreneurId: string;
  lastSeq: number; lastHash: string; lastSync: number | null;
}

export type OutboxType = 'telemetry_block' | 'daily_sale' | 'tamper_alert';
export interface OutboxRow {
  id: string; n: number; type: OutboxType; payload: any;
  state: 'pending' | 'sent' | 'rejected';
  attempts: number; lastError: string; createdAt: number; sentAt?: number; bytes: number;
}

export interface SaleRec {
  id: string; entrepreneurId: string; plugId: string; at: number;
  source: 'keypad' | 'voice';
  amountPaise: number | null;                    // null until the server transcribes a voice note
  audio?: { mime: string; b64: string; ms: number };
  status: 'local' | 'synced' | 'transcribed' | 'needs_review' | 'confirmed' | 'pending_transcription' | 'transcription_failed';
  transcript?: string;
}

export interface Entrepreneur { id: string; name: string; village: string; plugId: string; trade: string }
