export type ISODate = string;
export type LocalDateTime = string;
export type ShiftCategory = "Early" | "Middle" | "Late" | "Night" | "Custom";
export type DayStatus =
  "Work" | "Rest" | "Holiday" | "Sick" | "OtherLeave" | "Unknown";
export type Origin = "entered" | "suggested" | "needed";
export interface Routine {
  id: string;
  name: string;
  minutes: number | null;
  includes: string[];
  essential: boolean;
}
export interface Settings {
  name: string;
  role: string;
  safetyCritical: boolean;
  timezone: string;
  timezoneConfirmed: boolean;
  dateFormat: "UK" | "ISO" | "LONG" | "LONG_ISO";
  clockFormat: "24" | "12";
  firstDay: "Monday" | "Sunday" | "Saturday";
  travelMode: string;
  outboundMin: number | null;
  outboundMax: number | null;
  returnMinutes: number | null;
  arrivalBuffer: number | null;
  routines: Routine[];
  additionalPrepConfirmed: boolean;
  sleepTarget: number | null;
  latency: number | null;
  windDown: number | null;
  postWorkMinutes: number | null;
  earlyBed: string | null;
  earlyWake: string | null;
  lateBed: string | null;
  lateWake: string | null;
  restBed: string | null;
  restWake: string | null;
  consistentWake: boolean;
  caffeine: boolean;
  caffeineBeforeBed?: number;
  freeMinutes: number;
  theme: "light" | "dark" | "system";
  remindersEnabled: boolean;
  reminderKinds: string[];
  origins: Record<string, Origin>;
  onboardingStep: number;
  onboardingComplete: boolean;
  onboardingRotaPending?: boolean;
}
export interface ShiftTemplate {
  id: string;
  name: string;
  duty: string;
  category: ShiftCategory;
  start: string;
  end: string;
}
export interface RotaEntry {
  id: string;
  date: ISODate;
  duty: string;
  category: ShiftCategory;
  status: DayStatus;
  start: LocalDateTime | null;
  end: LocalDateTime | null;
  timezone: string;
  disambiguation?: "earlier" | "later";
  actualEnd?: LocalDateTime | null;
  overtimeMinutes: number;
  leaveApproval?: "requested" | "confirmed";
  location: string;
  notes: string;
  breakMinutes: number | null;
  paidMinutes: number | null;
  patternId?: string;
  exception?: boolean;
}
export interface PatternDay {
  templateId?: string;
  status: DayStatus;
}
export interface RepeatingPattern {
  id: string;
  name: string;
  startDate: ISODate;
  days: PatternDay[];
  until: ISODate;
}
export type TaskState =
  "pending" | "accepted" | "completed" | "skipped" | "deferred";
export interface Task {
  id: string;
  title: string;
  kind: "fixed" | "essential" | "flexible" | "optional";
  minutes: number;
  deadline: LocalDateTime;
  earliest: LocalDateTime;
  windowStart: string;
  windowEnd: string;
  priority: number;
  recurrence: "none" | "daily" | "weekly";
  location: string;
  travelMinutes: number;
  movable: boolean;
  splittable: boolean;
  locked: boolean;
  scheduledStart: LocalDateTime | null;
  state: TaskState;
  occurrenceStates?: Record<ISODate, TaskState>;
  linkedShiftId?: string;
}
export interface SleepLog {
  id: string;
  date: ISODate;
  bedtime: LocalDateTime;
  wake: LocalDateTime;
  estimatedMinutes: number | null;
  awakenings: number | null;
  rested: string;
}
export interface ReminderRecord {
  id: string;
  at: number;
  title: string;
  body: string;
  kind: string;
  entryId?: string;
}
export interface AppState {
  schemaVersion: 1;
  settings: Settings;
  entries: RotaEntry[];
  templates: ShiftTemplate[];
  patterns: RepeatingPattern[];
  tasks: Task[];
  sleepLogs: SleepLog[];
}
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };
export const uid = (prefix = "id") =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
