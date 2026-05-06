function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}
function std(values) {
    if (values.length === 0)
        return 0;
    const avg = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance);
}
function readSyntheticMeta(meta) {
    if (typeof meta !== 'object' || meta === null)
        return {};
    return meta;
}
export function extractFeatures(sample) {
    const pressed = new Map();
    const paired = [];
    for (const event of sample.events) {
        if (event.type === 'down') {
            pressed.set(event.code, event.t);
            continue;
        }
        if (!pressed.has(event.code))
            continue;
        const down_t = pressed.get(event.code);
        pressed.delete(event.code);
        paired.push({ code: event.code, down_t, up_t: event.t });
    }
    paired.sort((a, b) => a.down_t - b.down_t || a.up_t - b.up_t);
    const keystrokes = paired.map((current, index) => {
        const previous = index > 0 ? paired[index - 1] : undefined;
        return {
            code: current.code,
            hold_time: current.up_t - current.down_t,
            flight_time: previous ? current.down_t - previous.up_t : null,
            down_down: previous ? current.down_t - previous.down_t : null,
            up_up: previous ? current.up_t - previous.up_t : null
        };
    });
    const holds = keystrokes.map((key) => key.hold_time);
    const flights = keystrokes.flatMap((key) => key.flight_time === null ? [] : [key.flight_time]);
    const downDowns = keystrokes.flatMap((key) => key.down_down === null ? [] : [key.down_down]);
    const firstEvent = sample.events[0];
    const lastEvent = sample.events[sample.events.length - 1];
    const total_duration = firstEvent && lastEvent ? lastEvent.t - firstEvent.t : 0;
    const typing_speed = total_duration > 0 ? keystrokes.length / (total_duration / 1000) : 0;
    const syntheticMeta = readSyntheticMeta(sample.meta);
    const meta = {
        session_id: sample.session_id,
        password_length: keystrokes.length,
        quality_score: sample.quality_score,
        flags: sample.flags
    };
    if (typeof syntheticMeta.user_id === 'string') {
        meta.user_id = syntheticMeta.user_id;
    }
    if (typeof syntheticMeta.sample_index === 'number') {
        meta.sample_index = syntheticMeta.sample_index;
    }
    if (typeof syntheticMeta.impostor_of === 'string') {
        meta.impostor_of = syntheticMeta.impostor_of;
    }
    return {
        keystrokes,
        aggregates: {
            mean_hold: mean(holds),
            std_hold: std(holds),
            mean_flight: mean(flights),
            std_flight: std(flights),
            mean_down_down: mean(downDowns),
            std_down_down: std(downDowns),
            total_duration,
            typing_speed,
            keystroke_count: keystrokes.length
        },
        meta
    };
}
//# sourceMappingURL=features.js.map