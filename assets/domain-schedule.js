// Hard cap enforced by normalizeDraftV2 as well; the UI must never offer a 5th range.
export const MAX_RANGES_PER_DAY = 4;
const DEFAULT_RANGE = { from: "09:00", to: "18:00" };
const DAY_END_MINUTES = 23 * 60 + 59;
// Convert a "HH:MM" string to minutes since midnight; falls back to 09:00 for malformed input.
function toMinutes(value) {
    const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
    if (!match)
        return 9 * 60;
    return Number(match[1]) * 60 + Number(match[2]);
}
// Format minutes since midnight back to "HH:MM", clamped to the valid 00:00–23:59 window.
function fromMinutes(total) {
    const clamped = Math.max(0, Math.min(total, DAY_END_MINUTES));
    const hours = Math.floor(clamped / 60);
    const minutes = clamped % 60;
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
function cloneRanges(ranges) {
    return ranges.map((range) => ({ from: range.from, to: range.to }));
}
// Apply `updater` to the matching day only, returning a new schedule; other days keep their identity.
function replaceDay(schedule, dow, updater) {
    return schedule.map((day) => (day.dayOfWeek === dow ? updater(day) : day));
}
// Toggle a day's closed state. Closing clears the ranges; opening an empty day seeds one default range.
export function setDayClosed(schedule, dow, closed) {
    return replaceDay(schedule, dow, (day) => {
        if (closed)
            return { ...day, closed: true, ranges: [] };
        const ranges = day.ranges.length ? cloneRanges(day.ranges) : [{ ...DEFAULT_RANGE }];
        return { ...day, closed: false, ranges };
    });
}
// Set one field ("from" | "to") of a single range. A no-op when the index is out of bounds. Opens the day.
export function setRangeField(schedule, dow, index, field, value) {
    return replaceDay(schedule, dow, (day) => {
        if (index < 0 || index >= day.ranges.length)
            return day;
        const ranges = day.ranges.map((range, i) => (i === index ? { ...range, [field]: value } : { ...range }));
        return { ...day, closed: false, ranges };
    });
}
// Append a range starting 60 min after the previous range ends (clamped). No-op once four ranges exist. Opens the day.
export function addRange(schedule, dow) {
    return replaceDay(schedule, dow, (day) => {
        if (day.ranges.length >= MAX_RANGES_PER_DAY)
            return day;
        const ranges = cloneRanges(day.ranges);
        if (!ranges.length) {
            ranges.push({ ...DEFAULT_RANGE });
        }
        else {
            const last = ranges[ranges.length - 1];
            const from = fromMinutes(toMinutes(last.to) + 60);
            const to = fromMinutes(toMinutes(from) + 60);
            ranges.push({ from, to });
        }
        return { ...day, closed: false, ranges };
    });
}
// Remove one range. When the last range is removed the day becomes closed (no silent default re-injection).
export function removeRange(schedule, dow, index) {
    return replaceDay(schedule, dow, (day) => {
        if (index < 0 || index >= day.ranges.length)
            return day;
        const ranges = cloneRanges(day.ranges.filter((_, i) => i !== index));
        if (!ranges.length)
            return { ...day, closed: true, ranges: [] };
        return { ...day, ranges };
    });
}
// Copy the source day's closed state and ranges (deep) onto every target day except the source itself.
export function copyDayToDays(schedule, sourceDow, targetDows) {
    const source = schedule.find((day) => day.dayOfWeek === sourceDow);
    if (!source)
        return schedule;
    const targets = new Set(targetDows);
    return schedule.map((day) => {
        if (day.dayOfWeek === sourceDow || !targets.has(day.dayOfWeek))
            return day;
        return { ...day, closed: source.closed, ranges: cloneRanges(source.ranges) };
    });
}
