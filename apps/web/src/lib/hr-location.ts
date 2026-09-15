export type HrCoordinates = { latitude: number; longitude: number };
export type HrPosition = HrCoordinates & { accuracy: number; timestamp: number };
export type HrLocationErrorCode = 'unsupported' | 'insecure' | 'denied' | 'timeout' | 'unavailable' | 'invalid';

export class HrLocationError extends Error {
  constructor(public readonly code: HrLocationErrorCode, message: string) { super(message); this.name = 'HrLocationError'; }
}

function validCoordinates(point: HrCoordinates): boolean {
  return Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90 && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
}

/** One fresh measurement per call. Coordinates are never persisted by this utility. */
export function getCurrentHrPosition(): Promise<HrPosition> {
  return new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      reject(new HrLocationError('unsupported', '이 기기에서는 위치를 확인할 수 없습니다. 위치 기능을 지원하는 휴대전화나 브라우저로 접속해 주세요.')); return;
    }
    if (globalThis.isSecureContext === false) {
      reject(new HrLocationError('insecure', '안전한 연결에서 위치를 확인할 수 있습니다. HTTPS 주소로 다시 접속해 주세요.')); return;
    }
    let settled = false;
    const deadline = setTimeout(() => fail(new HrLocationError('timeout', '위치 확인이 지연되고 있습니다. 위치 권한을 확인한 뒤 다시 시도해 주세요.')), 20_000);
    function fail(error: HrLocationError) { if (settled) return; settled = true; clearTimeout(deadline); reject(error); }
    try { navigator.geolocation.getCurrentPosition(position => {
      if (settled) return;
      const result: HrPosition = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy, timestamp: position.timestamp };
      if (!validCoordinates(result) || !Number.isFinite(result.accuracy) || result.accuracy <= 0 || !Number.isFinite(result.timestamp) || result.timestamp <= 0) {
        fail(new HrLocationError('invalid', '기기에서 올바른 위치 정보를 받지 못했습니다. 위치 서비스를 확인한 뒤 다시 시도해 주세요.')); return;
      }
      settled = true; clearTimeout(deadline); resolve(result);
    }, error => {
      if (error.code === 1) fail(new HrLocationError('denied', '위치 사용이 허용되지 않았습니다. 브라우저와 기기 설정에서 위치 권한을 허용한 뒤 다시 확인해 주세요.'));
      else if (error.code === 3) fail(new HrLocationError('timeout', '15초 안에 위치를 확인하지 못했습니다. 창가나 실외에서 다시 시도해 주세요.'));
      else fail(new HrLocationError('unavailable', '현재 위치를 찾을 수 없습니다. 기기의 위치 서비스를 켜고 다시 시도해 주세요.'));
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 }); }
    catch { fail(new HrLocationError('unavailable', '위치 서비스를 시작하지 못했습니다. 기기 설정을 확인한 뒤 다시 시도해 주세요.')); }
  });
}

/** Great-circle distance in metres, using the same Earth radius as the server. */
export function hrDistanceMeters(from: HrCoordinates, to: HrCoordinates): number {
  if (!validCoordinates(from) || !validCoordinates(to)) throw new HrLocationError('invalid', '거리 계산에 필요한 위치 정보가 올바르지 않습니다.');
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(to.latitude - from.latitude);
  const longitudeDelta = radians(to.longitude - from.longitude);
  const a = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(radians(from.latitude)) * Math.cos(radians(to.latitude)) * Math.sin(longitudeDelta / 2) ** 2;
  return 6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)));
}
