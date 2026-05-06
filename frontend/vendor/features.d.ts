import type { Sample } from './types.js';
export interface KeystrokeFeature {
    code: string;
    hold_time: number;
    flight_time: number | null;
    down_down: number | null;
    up_up: number | null;
}
export interface AggregateFeatures {
    mean_hold: number;
    std_hold: number;
    mean_flight: number;
    std_flight: number;
    mean_down_down: number;
    std_down_down: number;
    total_duration: number;
    typing_speed: number;
    keystroke_count: number;
}
export interface FeatureMeta {
    session_id: string;
    user_id?: string;
    sample_index?: number;
    impostor_of?: string;
    password_length: number;
    quality_score: number;
    flags: readonly string[];
}
export interface FeatureVector {
    keystrokes: readonly KeystrokeFeature[];
    aggregates: AggregateFeatures;
    meta: FeatureMeta;
}
export declare function extractFeatures(sample: Sample & {
    meta?: unknown;
}): FeatureVector;
