// ActuSpec TypeScript types — mirrors Python models

export interface TelemetryRow {
  _time: string;
  'feedback_position_%': number;
  'setpoint_position_%'?: number;
  'motor_torque_Nmm': number;
  'internal_temperature_deg_C': number;
  'power_W'?: number;
  'rotation_direction'?: number;
  test_number?: number;
}

export interface TorqueProfile {
  [positionBin: string]: number | null;
}

export interface RunResult {
  trace: TelemetryRow[];
  baseline_profile: TorqueProfile;
  current_profile: TorqueProfile;
  score: number;
  diagnostics: string[];
  commissioning: CommissioningResult | null;
  error: string | null;
}

export interface CommissioningResult {
  score: number;
  verdict: 'PASS' | 'MARGINAL' | 'FAIL';
  checks: Record<string, CommissioningCheck>;
  diagnostics: string[];
}

export interface CommissioningCheck {
  label: string;
  value: number;
  unit: string;
  threshold: number;
  passed: boolean;
  penalty: number;
}

export interface FleetScore {
  test_number: string | number;
  score: number;
}

export interface AppConfig {
  health_green: number;
  health_amber: number;
  comm_pass: number;
  comm_marginal: number;
  tn_baseline: number;
  tn_field_min: number;
  tn_field_max: number;
  tn_commission_min: number;
  tn_commission_max: number;
  tn_default: number;
  default_mode: string;
  network_name?: string;
  influx_url?: string;
  seq_free_stroke: number[];
  seq_step_delay?: number;
  comm_thresholds: {
    range: number;
    torque_cv: number;
    tracking: number;
    temp: number;
  };
}

export type AppMode = 'live' | 'replay';
export type ActiveTab = 'dashboard' | 'baseline' | 'health' | 'comm';
export type RunState = 'idle' | 'commanding' | 'collecting' | 'analyzing' | 'done' | 'error';
