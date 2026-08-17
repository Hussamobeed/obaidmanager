export type PasswordType = "same" | "empty";

export interface GeneratorSettings {
  beginNumber: string;
  numLength: number;
  numCount: number;
  customer: string;
  comment: string;
  profile: string;
  passwordType: PasswordType;
}

export interface PdfLayoutSettings {
  backgroundImageDataUrl: string | null;
  backgroundFit: "contain" | "cover" | "stretch";
  useBorder: boolean;
  borderWidth: number;
  borderColor: string;
  columns: number;
  rows: number;
  boxSpacing: number;

  // Card number (always shown)
  textSize: number;
  textPositionX: number;
  textPositionY: number;
  font: string;
  fontWeight: "normal" | "bold";
  textColor: string;
  textAlign: "left" | "center" | "right";
  textRotation: number;

  // Serial number styling (whether it's shown is chosen at generation time)
  serialNumberSize: number;
  serialPositionX: number;
  serialPositionY: number;
  serialColor: string;

  // Date styling (whether it's shown is chosen at generation time)
  dateSize: number;
  datePositionX: number;
  datePositionY: number;
  dateColor: string;

  // Optional custom text styling (whether it's shown, and its content, are
  // chosen at generation time — only its look is fixed here)
  customTextSize: number;
  customTextPositionX: number;
  customTextPositionY: number;
  customTextColor: string;
}

/** Per-generation choices: what to include and its content — NOT how it looks. */
export interface PrintOptions {
  useSerialNumber: boolean;
  serialStartNumber: number;
  useDatePrinting: boolean;
  useCustomText: boolean;
  customText: string;
}

export interface GenerationResult {
  numbers: string[];
  script: string;
}

export interface RouterPublic {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  sslEnabled: boolean;
  description: string | null;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RouterInput {
  name: string;
  host: string;
  port: number;
  username: string;
  password: string;
  sslEnabled: boolean;
  description?: string;
  isDefault?: boolean;
}

export interface SyncResult {
  routerId: string;
  customers: { name: string }[];
  profiles: { name: string }[];
  syncedAt: string;
}

export interface CachedSyncData {
  customers: { name: string }[];
  profiles: { name: string }[];
  last_synced_at: string | null;
}

export interface PrintTemplate {
  id: string;
  name: string;
  profile: string | null;
  layout: PdfLayoutSettings;
  created_at: string;
}

export interface LibraryFile {
  id: string;
  name: string;
  file_type: "txt" | "pdf" | "xlsx" | "mikrotik-script";
  customer: string | null;
  profile: string | null;
  prefix: string | null;
  number_count: number | null;
  created_at: string;
}
