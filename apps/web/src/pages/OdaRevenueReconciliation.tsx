import { ODA_DELIVERY_CHANNELS, getOdaPosDeliveryScope, normalizeOdaChannel } from '../../../../packages/domain/src/oda-settlement';
import type { OdaResponse } from '../api/oda-client';
import { Button } from '../components/ui';

const won = (value: number) => `${value.toLocaleString('ko-KR')}원`;
export function OdaRevenueReconciliation({ state, onPolicy, onSources }: {
  state: OdaResponse; onPolicy: () => void; onSources: () => void;
}) {
  const snapshot = state.data.status !== 'draft'
    ? [...state.data.history].reverse().find(entry => entry.reason === '월 정산 확정' && entry.version <= state.data.version)
    : undefined;
  const data = snapshot ?? state.data;
  const groups = (snapshot?.summary ?? state.summary).platformRevenueByChannel;
  if (!groups) return null;
  const sources = data.sources.filter(source => source.kind === 'platform');
  const channels = [...new Set([
    ...data.policy.activeChannels.map(normalizeOdaChannel).filter(channel => channel !== 'pos'),
    ...sources.map(source => normalizeOdaChannel(source.channel)), ...groups.map(group => group.channel),
  ])];
  if (!channels.length) return null;
  return <section className="oda-card" aria-label="배달 매출 반영 내역">
    <div className="oda-card-head"><div><h2>배달 매출은 이렇게 반영됩니다</h2><p>저장된 POS 포함 기준과 실제 손익 추가액을 함께 확인하세요.</p></div>
      <Button variant="secondary" onClick={onPolicy}>포함 기준 보기</Button></div>
    <div className="oda-revenue-scroll"><table className="oda-revenue-table">
      <caption>{state.data.status === 'draft' ? '작성 중 · 잠정 집계' : '확정 기준 집계'} · 손익 추가액은 {data.policy.vatBasis === 'net' ? '입력된 부가세 제외' : data.policy.vatBasis === 'gross' ? '부가세 포함' : '부가세 기준 확인 전'} 금액입니다.</caption>
      <thead><tr><th scope="col">배달 채널</th><th scope="col">POS 포함 기준</th><th scope="col">정산 대상 원본금액</th><th scope="col">손익 추가액</th><th scope="col">원본 자료</th></tr></thead>
      <tbody>{channels.map(channel => {
        const group = groups.find(item => item.channel === channel);
        const sourceIds = new Set(data.lines.filter(line => normalizeOdaChannel(line.channel) === channel).map(line => line.sourceId));
        const count = sources.filter(source => normalizeOdaChannel(source.channel) === channel || sourceIds.has(source.id)).length;
        const scope = getOdaPosDeliveryScope(data.policy, channel);
        return <tr key={channel}>
          <th scope="row">{ODA_DELIVERY_CHANNELS.find(item => item.value === channel)?.label ?? (channel || '채널 확인 필요')}</th>
          <td>{scope === 'included' ? 'POS에 포함' : scope === 'excluded' ? '별도 합산' : '확인 필요'}{!data.policy.activeChannels.map(normalizeOdaChannel).includes(channel) && <small>운영 채널 확인 필요</small>}</td>
          <td>{count ? won(group?.gross ?? 0) : '—'}<small>{count ? `부가세 포함 · ${group?.count ?? 0}건` : '자료 미등록'}</small></td>
          <td><strong>{count ? won(group?.recognized ?? 0) : '—'}</strong>{group && group.ignoredCount > 0 && <small>POS 중복 제외 {won(group.ignoredGross)}</small>}</td>
          <td>{count ? `${count}개` : '미등록'}</td>
        </tr>;
      })}</tbody>
    </table></div>
    <p className="oda-pnl-note">POS 포함 채널의 추가액 0원은 해당 매출을 POS에서 반영한다는 뜻입니다. 원본금액은 환불을 차감한 집계 대상 금액이며, 손익 제외·금액 오류·귀속월 오류·중복 거래와 수수료·지급예정액은 이 표에서 제외합니다. 미확인 거래와 기준은 확정 전에 확인하세요.</p>
    <div className="oda-policy-footer"><p>플랫폼 수수료는 운영비에, 실제 입금은 계좌 대사에 표시합니다.</p><Button variant="secondary" onClick={onSources}>거래·원본 확인</Button></div>
  </section>;
}
