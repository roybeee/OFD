import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/ui';
import { getCurrentHrPosition } from '../lib/hr-location';
import { hrDate, hrError, type HrPanelProps } from './shared';

const RADIUS_METERS = 200;
const MAX_ACCURACY_METERS = 50;
const mapUrl = (latitude: number, longitude: number) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${latitude},${longitude}`)}`;
function coordinates(latitude: string, longitude: string): { latitude: number; longitude: number } | null {
  if (!latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lon = Number(longitude);
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
    ? { latitude: lat, longitude: lon } : null;
}

/** This form only edits a draft. Geolocation never triggers a mutation. */
export function HrClockLocationSettings({ workspace, permissions, mutate, busy, storeAddress }: HrPanelProps) {
  const saved = workspace.settings.clockLocation;
  const [address, setAddress] = useState(saved?.address ?? storeAddress ?? '');
  const [latitude, setLatitude] = useState(saved ? String(saved.latitude) : '');
  const [longitude, setLongitude] = useState(saved ? String(saved.longitude) : '');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [phase, setPhase] = useState<'locating' | 'saving' | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const operation = useRef<'locating' | 'saving' | null>(null);
  const generation = useRef(0);
  const canManage = useRef(permissions.manage);
  canManage.current = permissions.manage;

  // Switching stores invalidates an outstanding GPS result and clears the old draft.
  useEffect(() => {
    generation.current += 1; operation.current = null;
    setAddress(workspace.settings.clockLocation?.address ?? storeAddress ?? '');
    setLatitude(workspace.settings.clockLocation ? String(workspace.settings.clockLocation.latitude) : '');
    setLongitude(workspace.settings.clockLocation ? String(workspace.settings.clockLocation.longitude) : '');
    setAccuracy(null); setPhase(null); setError(''); setMessage('');
    return () => { generation.current += 1; operation.current = null; };
    // Same-store reloads preserve a draft when another write causes a version conflict.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.storeId]);

  const point = coordinates(latitude, longitude);
  const disabled = busy || phase !== null;
  function changePoint(key: 'latitude' | 'longitude', value: string): void {
    if (key === 'latitude') setLatitude(value); else setLongitude(value);
    setAccuracy(null); setMessage(''); setError('');
  }

  async function locate(): Promise<void> {
    if (!canManage.current || busy || operation.current) return;
    operation.current = 'locating'; setPhase('locating'); setError(''); setMessage('');
    const current = generation.current;
    try {
      const position = await getCurrentHrPosition();
      if (current !== generation.current || !canManage.current) return;
      if (!coordinates(String(position.latitude), String(position.longitude)) || !Number.isFinite(position.accuracy) || position.accuracy <= 0) {
        throw new Error('현재 위치를 정확히 확인하지 못했습니다. 다시 시도하거나 좌표를 직접 입력해 주세요.');
      }
      if (position.accuracy > MAX_ACCURACY_METERS) {
        throw new Error(`현재 위치의 오차가 약 ${Math.ceil(position.accuracy)}m입니다. 50m 이하일 때 지정할 수 있습니다. 위치가 잘 잡히는 곳에서 다시 시도해 주세요. 이번 위치는 적용하지 않았습니다.`);
      }
      setLatitude(String(position.latitude)); setLongitude(String(position.longitude)); setAccuracy(position.accuracy);
      setMessage('현재 위치를 입력했습니다. 주소와 지도 위치를 확인한 뒤 저장해 주세요.');
    } catch (caught) {
      if (current === generation.current && canManage.current) setError(hrError(caught));
    } finally {
      if (current === generation.current) { operation.current = null; setPhase(null); }
    }
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!canManage.current || busy || operation.current) return;
    setError(''); setMessage('');
    if (!address.trim() || address.trim().length > 500) { setError('매장 주소를 1~500자로 입력해 주세요.'); return; }
    const position = coordinates(latitude, longitude);
    if (!position) { setError('위도는 -90~90, 경도는 -180~180 범위의 숫자로 입력해 주세요.'); return; }
    operation.current = 'saving'; setPhase('saving');
    const current = generation.current;
    try {
      await mutate('attendance.location.set', { address: address.trim(), ...position });
      if (current === generation.current) setMessage('매장 출퇴근 기준 위치를 저장했습니다. 허용 반경은 200m입니다.');
    } catch (caught) {
      if (current === generation.current) setError(hrError(caught));
    } finally {
      if (current === generation.current) { operation.current = null; setPhase(null); }
    }
  }

  return <section className="hr-card" aria-labelledby="hr-clock-location-title">
    <div className="hr-section-heading"><div><h2 id="hr-clock-location-title">매장 출퇴근 기준 위치</h2><p>저장한 좌표를 중심으로 반경 {RADIUS_METERS}m를 출퇴근 허용 범위로 사용합니다.</p></div></div>
    {saved ? <div style={{ marginBottom: 20 }}><h3>현재 저장된 위치</h3><dl className="hr-details">
      <div><dt>매장 주소</dt><dd>{saved.address}</dd></div><div><dt>위도 · 경도</dt><dd>{saved.latitude}, {saved.longitude}</dd></div>
      <div><dt>허용 반경</dt><dd>{RADIUS_METERS}m · 고정</dd></div><div><dt>최근 변경</dt><dd>{hrDate(saved.updatedAt)}</dd></div>
    </dl><a href={mapUrl(saved.latitude, saved.longitude)} target="_blank" rel="noopener noreferrer">저장된 위치 지도에서 확인</a></div>
      : <p className="hr-note" style={{ marginBottom: 20 }}>아직 출퇴근 기준 위치를 저장하지 않았습니다.</p>}
    {!permissions.manage ? <p className="hr-note">출퇴근 기준 위치 변경은 관리자에게 요청해 주세요.</p> : <form className="hr-form" aria-label="매장 출퇴근 위치 설정" noValidate onSubmit={event => void save(event)}>
      <fieldset disabled={disabled}>
        <p className="hr-inline-note">매장 현장에서 현재 위치를 지정하거나 지도에서 확인한 좌표를 입력하세요. 주소만 입력하면 좌표가 자동으로 지정되지는 않습니다.</p>
        {storeAddress && <p className="hr-muted">매장 대장 주소: {storeAddress}</p>}
        <label>매장 주소<input name="clockLocationAddress" autoComplete="street-address" required maxLength={500} value={address} onChange={event => { setAddress(event.target.value); setMessage(''); setError(''); }} /></label>
        <div className="hr-actions"><Button type="button" variant="secondary" onClick={() => void locate()}>{phase === 'locating' ? '현재 위치 확인 중…' : '매장 현장의 현재 위치 사용'}</Button><span className="hr-muted">위치 오차가 50m 이하일 때 입력합니다.</span></div>
        <div className="hr-form-grid"><label>위도<input name="clockLocationLatitude" type="number" min={-90} max={90} step="any" inputMode="decimal" required value={latitude} onChange={event => changePoint('latitude', event.target.value)} placeholder="예: 37.5665" /></label>
          <label>경도<input name="clockLocationLongitude" type="number" min={-180} max={180} step="any" inputMode="decimal" required value={longitude} onChange={event => changePoint('longitude', event.target.value)} placeholder="예: 126.9780" /></label></div>
        {point && <div className="hr-inline-note"><strong>저장할 기준 위치</strong><p>{address.trim() || '매장 주소를 입력해 주세요.'}</p><p>위도 {point.latitude} · 경도 {point.longitude} · 반경 {RADIUS_METERS}m</p>
          {accuracy !== null && <p>현재 위치의 오차: 약 {Math.ceil(accuracy)}m</p>}<a href={mapUrl(point.latitude, point.longitude)} target="_blank" rel="noopener noreferrer">저장할 위치 지도에서 확인</a></div>}
        {error && <p className="hr-error" role="alert">{error}</p>}
        {message && <p className="hr-note" role="status">{message}</p>}
        <div className="hr-actions"><Button type="submit">{phase === 'saving' ? '기준 위치 저장 중…' : '이 위치를 매장 출퇴근 기준으로 저장'}</Button></div>
      </fieldset>
    </form>}
  </section>;
}
