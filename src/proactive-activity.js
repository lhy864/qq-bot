// Activity changes opportunities, never an obligation to send a message.
const MINUTE = 60000;
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export function proactiveActivityProfile(config = {}, {energy = 60, mood = 0, rhythmFactor = 1, dailyFactor = 1} = {}) {
  const enabled = config.activityBoost !== false;
  const e = Math.max(0, Math.min(100, finite(energy, 60)));
  const r = Math.max(0, finite(rhythmFactor, 1));
  const energetic = enabled && finite(mood, 0) > -25 && finite(dailyFactor, 1) >= 0.8
    && ((e >= 70 && r >= 0.8) || (e >= 40 && r >= 1.1));
  const baseMin = Math.max(MINUTE, finite(config.checkIntervalMinMs, 30 * MINUTE));
  const baseMax = Math.max(baseMin, finite(config.checkIntervalMaxMs, 90 * MINUTE));
  const dailyBaseMax = Math.max(0, Math.floor(finite(config.dailyMaxPerKey, 2)));
  return {
    enabled, energetic,
    checkIntervalMinMs: Math.max(MINUTE, Math.round(baseMin * (energetic ? 0.75 : 1))),
    checkIntervalMaxMs: Math.max(MINUTE, Math.round(baseMax * (energetic ? 0.75 : 1))),
    probabilityMultiplier: energetic ? 1.35 : 1,
    dailyBaseMax,
    // Zero retains the existing unlimited convention. The bonus is temporary,
    // not a separate daily counter, so returning to normal cannot reset usage.
    dailyMax: dailyBaseMax > 0 ? dailyBaseMax + (energetic ? 2 : 0) : 0,
    minContactGapMs: 45 * MINUTE,
  };
}
