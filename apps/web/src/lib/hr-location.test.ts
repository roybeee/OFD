import { afterEach, describe, expect, it, vi } from 'vitest';
import { getCurrentHrPosition, hrDistanceMeters } from './hr-location';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('HR browser location', () => {
  it('requests a fresh precise location each time and returns only the required coordinates', async () => {
    const getCurrentPosition = vi.fn((success: PositionCallback) => success({ coords: { latitude: 37.5, longitude: 127, accuracy: 12 }, timestamp: 1_800_000_000_000 } as GeolocationPosition));
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition } });
    expect(await getCurrentHrPosition()).toEqual({ latitude: 37.5, longitude: 127, accuracy: 12, timestamp: 1_800_000_000_000 });
    await getCurrentHrPosition();
    expect(getCurrentPosition).toHaveBeenCalledTimes(2);
    expect(getCurrentPosition).toHaveBeenCalledWith(expect.any(Function), expect.any(Function), { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  });
  it.each([[1, 'denied'], [2, 'unavailable'], [3, 'timeout']])('explains browser error %s', async (code, expected) => {
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (_success: unknown, fail: PositionErrorCallback) => fail({ code } as GeolocationPositionError) } });
    await expect(getCurrentHrPosition()).rejects.toMatchObject({ code: expected });
  });
  it('reports unsupported browsers and malformed coordinates', async () => {
    vi.stubGlobal('navigator', {}); await expect(getCurrentHrPosition()).rejects.toMatchObject({ code: 'unsupported' });
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 91, longitude: 127, accuracy: 1 }, timestamp: Date.now() } as GeolocationPosition) } });
    await expect(getCurrentHrPosition()).rejects.toMatchObject({ code: 'invalid' });
  });
  it('calculates great-circle distances for the 200 m boundary and identical locations', () => {
    expect(hrDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 0 })).toBe(0);
    expect(hrDistanceMeters({ latitude: 0, longitude: 0 }, { latitude: 200 / 6371000 * 180 / Math.PI, longitude: 0 })).toBeCloseTo(200, 5);
    expect(() => hrDistanceMeters({ latitude: NaN, longitude: 0 }, { latitude: 0, longitude: 0 })).toThrow();
  });
  it('ends an unanswered permission prompt at the hard deadline and ignores late callbacks', async () => {
    vi.useFakeTimers(); let succeed!: PositionCallback;
    vi.stubGlobal('navigator', { geolocation: { getCurrentPosition: (success: PositionCallback) => { succeed = success; } } });
    const result = getCurrentHrPosition(); const rejection = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(20_000); await rejection;
    succeed({ coords: { latitude: 37.5, longitude: 127, accuracy: 5 }, timestamp: Date.now() } as GeolocationPosition);
    expect(vi.getTimerCount()).toBe(0);
  });
});
