import { DomainError } from './errors.ts';
import type { HrContext } from './oda-hr.ts';

export interface HrClockLocation {
  address: string;
  latitude: number;
  longitude: number;
  radiusMeters: 200;
  updatedAt: string;
  updatedBy: string;
}
export interface HrClockPosition {
  latitude: number;
  longitude: number;
  accuracy: number;
  timestamp: number;
}
/** Persist the verification result, never the employee's original coordinates. */
export interface HrClockLocationEvidence {
  distanceMeters: number;
  accuracyMeters: number;
  verifiedAt: string;
  radiusMeters: 200;
  locationUpdatedAt: string;
}

function invalid(message: string): never { throw new DomainError('HR_CLOCK_LOCATION_INVALID', message, 422); }
function coordinate(value: unknown, limit: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > limit) invalid(`${name} 좌표가 올바르지 않습니다. 위치를 다시 확인해 주세요.`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('위치 정보 형식이 올바르지 않습니다. 위치를 다시 확인해 주세요.');
  return value as Record<string, unknown>;
}

export function createHrClockLocation(input: Record<string, unknown>, ctx: HrContext): HrClockLocation {
  if (!ctx.manager) throw new DomainError('HR_FORBIDDEN', '매장 출퇴근 위치는 관리자만 설정할 수 있습니다.', 403);
  if (Object.keys(input).some(key => !['address', 'latitude', 'longitude'].includes(key))) invalid('매장 주소와 좌표만 입력해 주세요. 출퇴근 허용 반경은 200m로 고정됩니다.');
  if (typeof input.address !== 'string' || !input.address.trim() || input.address.trim().length > 500) invalid('매장 주소를 500자 이내로 입력해 주세요.');
  const latitude = coordinate(input.latitude, 90, '위도');
  const longitude = coordinate(input.longitude, 180, '경도');
  if (!Number.isFinite(Date.parse(ctx.now))) invalid('서버 시간을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  return { address: input.address.trim(), latitude, longitude, radiusMeters: 200, updatedAt: ctx.now, updatedBy: ctx.actorId };
}

/** Great-circle distance using the mean Earth radius; valid across the antimeridian. */
export function hrHaversineDistanceMeters(from: Pick<HrClockPosition, 'latitude' | 'longitude'>, to: Pick<HrClockPosition, 'latitude' | 'longitude'>): number {
  const rad = Math.PI / 180;
  const latDelta = (to.latitude - from.latitude) * rad;
  const lonDelta = (to.longitude - from.longitude) * rad;
  const raw = Math.sin(latDelta / 2) ** 2 + Math.cos(from.latitude * rad) * Math.cos(to.latitude * rad) * Math.sin(lonDelta / 2) ** 2;
  const a = Math.min(1, Math.max(0, raw));
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function verifyHrClockLocation(setting: HrClockLocation | undefined, value: unknown, now: string): HrClockLocationEvidence {
  if (!setting) throw new DomainError('HR_CLOCK_LOCATION_NOT_CONFIGURED', '매장 출퇴근 위치가 아직 설정되지 않았습니다. 관리자에게 매장 위치 설정을 요청해 주세요.', 409);
  if (value === undefined || value === null) throw new DomainError('HR_CLOCK_LOCATION_REQUIRED', '출퇴근하려면 기기의 위치 접근을 허용하고 현재 위치를 확인해 주세요.', 422);
  const input = object(value);
  if (Object.keys(input).some(key => !['latitude', 'longitude', 'accuracy', 'timestamp'].includes(key))) invalid('현재 위치의 좌표, 오차, 확인 시각만 보내 주세요. 출퇴근 허용 반경은 200m로 고정됩니다.');
  const latitude = coordinate(input.latitude, 90, '위도');
  const longitude = coordinate(input.longitude, 180, '경도');
  if (typeof input.accuracy !== 'number' || !Number.isFinite(input.accuracy) || input.accuracy <= 0 || input.accuracy > 50) {
    throw new DomainError('HR_CLOCK_LOCATION_ACCURACY', '위치 오차가 50m 이내여야 합니다. 위치 수신이 좋은 곳에서 다시 확인해 주세요.', 422);
  }
  if (typeof input.timestamp !== 'number' || !Number.isFinite(input.timestamp) || input.timestamp < 0 || input.timestamp > Number.MAX_SAFE_INTEGER) invalid('위치 확인 시각이 올바르지 않습니다. 현재 위치를 다시 확인해 주세요.');
  const serverTime = Date.parse(now);
  if (!Number.isFinite(serverTime)) invalid('서버 시간을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.');
  const age = serverTime - input.timestamp;
  if (age > 60_000 || age < -10_000) throw new DomainError('HR_CLOCK_LOCATION_STALE', age < -10_000 ? '위치 확인 시각이 현재 시각보다 빠릅니다. 기기 시간을 확인하고 위치를 다시 받아 주세요.' : '위치 확인 후 60초가 지났습니다. 현재 위치를 다시 확인해 주세요.', 422);
  coordinate(setting.latitude, 90, '매장 위도'); coordinate(setting.longitude, 180, '매장 경도');
  const distanceMeters = hrHaversineDistanceMeters(setting, { latitude, longitude });
  // Absorb only machine-precision arithmetic noise at the inclusive 200m boundary.
  if (distanceMeters + input.accuracy - 200 > Number.EPSILON * 200 * 8) throw new DomainError('HR_CLOCK_LOCATION_OUTSIDE', '위치 오차를 포함해 매장 반경 200m 안에 있어야 출퇴근할 수 있습니다. 매장 가까이에서 다시 확인해 주세요.', 422);
  return { distanceMeters, accuracyMeters: input.accuracy, verifiedAt: now, radiusMeters: 200, locationUpdatedAt: setting.updatedAt };
}
