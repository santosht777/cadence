import type { Capture, CaptureOptions } from './types.js';
export declare const LIBRARY_VERSION = "0.1.0";
/**
 * Create a keystroke-dynamics capture session bound to a DOM element.
 *
 * Subscribe to events before calling `start()` — errors emitted
 * synchronously from `start()` will otherwise be missed.
 */
export declare function createCapture(options: CaptureOptions): Capture;
/**
 * Compute a 0–1 quality score for a captured session. Pure function;
 * exported for direct unit testing but not re-exported from the
 * package entry point.
 */
export declare function computeQualityScore(events: ReadonlyArray<{
    type: 'down' | 'up';
    code: string;
}>, flags: ReadonlySet<string>, timing_resolution_ms: number): number;
