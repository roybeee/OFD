import { useEffect, useRef, type PointerEvent } from 'react';
import { Button } from '../components/ui';

export type EsignStroke = Array<{ x: number; y: number }>;
export function EsignSignaturePad({ value, onChange, disabled = false }: { value: EsignStroke[]; onChange: (value: EsignStroke[]) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const active = useRef<number | null>(null);
  const strokes = useRef(value);
  useEffect(() => { strokes.current = value; }, [value]);
  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, element.width, element.height);
    context.strokeStyle = '#18213b'; context.lineWidth = 3; context.lineCap = 'round'; context.lineJoin = 'round';
    for (const stroke of value) {
      context.beginPath();
      stroke.forEach((point, index) => index ? context.lineTo(point.x * element.width, point.y * element.height) : context.moveTo(point.x * element.width, point.y * element.height));
      context.stroke();
    }
  }, [value]);
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(Math.max(0, Math.min(1, (event.clientX - bounds.left) / (bounds.width || 1))) * 10000) / 10000, y: Math.round(Math.max(0, Math.min(1, (event.clientY - bounds.top) / (bounds.height || 1))) * 10000) / 10000 };
  }
  function end(event: PointerEvent<HTMLCanvasElement>) {
    if (active.current !== event.pointerId) return;
    active.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  return <div className="esign-signature"><p id="esign-signature-help">아래 영역에 손가락이나 마우스로 직접 서명해 주세요.</p><canvas ref={canvas} width={720} height={240} aria-label="직접 서명 입력 영역" aria-describedby="esign-signature-help" aria-disabled={disabled}
    onPointerDown={event => { if (disabled || active.current !== null || strokes.current.length >= 30) return; event.preventDefault(); active.current = event.pointerId; event.currentTarget.setPointerCapture?.(event.pointerId); strokes.current = [...strokes.current, [point(event)]]; onChange(strokes.current); }}
    onPointerMove={event => { if (disabled || active.current !== event.pointerId) return; const current = strokes.current.at(-1); if (!current || current.length >= 500) return; event.preventDefault(); strokes.current = [...strokes.current.slice(0, -1), [...current, point(event)]]; onChange(strokes.current); }}
    onPointerUp={end} onPointerCancel={end} onLostPointerCapture={() => { active.current = null; }} />
    <Button type="button" variant="ghost" disabled={disabled || !value.length} onClick={() => { active.current = null; strokes.current = []; onChange([]); }}>서명 지우기</Button>
  </div>;
}
