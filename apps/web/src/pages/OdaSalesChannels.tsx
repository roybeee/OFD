import { ODA_DELIVERY_CHANNELS, getOdaPosDeliveryScopes, type OdaPolicy, type OdaPosDeliveryScope } from '../../../../packages/domain/src/oda-settlement';

export function OdaSalesChannels({ policy, disabled, onChange }: {
  policy: OdaPolicy; disabled: boolean; onChange: (policy: OdaPolicy) => void;
}) {
  const scopes = getOdaPosDeliveryScopes(policy);
  const channels = [{ value: 'pos', label: '매장 POS' }, ...ODA_DELIVERY_CHANNELS];
  const change = (patch: Partial<OdaPolicy>) => onChange({ ...policy, posDeliveryScopes: scopes, ...patch });
  return <div className="oda-policy-section">
    <h3>01. 매출 집계</h3>
    <div className="oda-form-grid">
      <label className="oda-field">손익의 부가세 기준
        <select disabled={disabled} value={policy.vatBasis} onChange={e => change({ vatBasis: e.target.value as OdaPolicy['vatBasis'] })}>
          <option value="unresolved">양측 합의 필요</option><option value="net">부가세 제외 · 공급가액</option><option value="gross">부가세 포함 · 결제금액</option>
        </select><small>부가세 제외 시 각 거래의 부가세액이 필요합니다.</small>
      </label>
      <label className="oda-field">손익 귀속 기준
        <select disabled={disabled} value={policy.attributionBasis} onChange={e => change({ attributionBasis: e.target.value as OdaPolicy['attributionBasis'] })}>
          <option value="unresolved">양측 확인 필요</option><option value="accrual">매출·비용 발생월 기준</option>
        </select><small>입금일과 무관하게 해당 매출·비용이 발생한 달에 반영합니다.</small>
      </label>
      <div className="oda-field full"><span>운영 중인 판매 채널</span>
        <div className="oda-checks">{channels.map(channel => <label key={channel.value} className="oda-checkbox">
          <input type="checkbox" disabled={disabled} checked={policy.activeChannels.includes(channel.value)} onChange={e => change({ activeChannels: e.target.checked ? [...policy.activeChannels, channel.value] : policy.activeChannels.filter(item => item !== channel.value) })} />{channel.label}
        </label>)}</div>
        <small>운영 중인 채널을 선택한 뒤 아래에서 POS 포함 여부를 각각 확인하세요. 선택한 채널의 월 마감 원본이 필요합니다.</small>
      </div>
      <fieldset className="oda-delivery-scopes full">
        <legend>POS에 포함되는 배달 매출 채널</legend>
        <p className="oda-mini-note">포함된 채널은 POS 매출만 반영하고, 별도인 채널은 플랫폼 매출을 더합니다. 플랫폼 수수료는 모두 별도 비용으로 반영합니다.</p>
        <div className="oda-form-grid">{ODA_DELIVERY_CHANNELS.map(channel => {
          const active = policy.activeChannels.includes(channel.value);
          return <label key={channel.value} className="oda-field">{channel.label}
            <select aria-label={`${channel.label} POS 포함 여부`} disabled={disabled || !active} value={scopes[channel.value]} onChange={e => change({ posDeliveryScopes: { ...scopes, [channel.value]: e.target.value as OdaPosDeliveryScope } })}>
              <option value="unresolved">확인 필요</option><option value="included">포함됨 · POS 매출 기준</option><option value="excluded">별도 · 플랫폼 매출 추가</option>
            </select>
            <small>{!active ? '미사용 · 위에서 운영 채널을 선택하면 설정할 수 있습니다.' : scopes[channel.value] === 'included' ? '이 채널의 플랫폼 매출은 중복 합산하지 않습니다.' : scopes[channel.value] === 'excluded' ? 'POS 매출에 이 채널의 플랫폼 매출을 추가합니다.' : '이 채널의 POS 포함 여부를 확인해야 정산을 확정할 수 있습니다.'}</small>
          </label>;
        })}</div>
      </fieldset>
    </div>
  </div>;
}
