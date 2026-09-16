import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { EsignSignaturePad, type EsignStroke } from './EsignSignaturePad';

describe('signature capture limits', () => {
  it('keeps captured points within the server limit, reports the limit and allows a clean retry', async () => {
    const context = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn() } as unknown as CanvasRenderingContext2D);
    const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
    const onChange = vi.fn();
    function Harness() {
      const [value, setValue] = useState<EsignStroke[]>([Array.from({ length: 4000 }, () => ({ x: .1, y: .1 })), Array.from({ length: 3999 }, () => ({ x: .2, y: .2 }))]);
      return <EsignSignaturePad value={value} onChange={next => { onChange(next); setValue(next); }} />;
    }
    try {
      await act(async () => root.render(<Harness />));
      const canvas = container.querySelector('canvas')!;
      const pointer = async (type: string, x = 20) => act(async () => { const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 30 }); Object.defineProperty(event, 'pointerId', { value: 1 }); canvas.dispatchEvent(event); });
      await pointer('pointerdown'); await pointer('pointermove', 40); await pointer('pointerup');
      expect(onChange).toHaveBeenCalledOnce();
      expect((onChange.mock.calls[0][0] as EsignStroke[]).reduce((sum, stroke) => sum + stroke.length, 0)).toBe(8000);
      expect(container.textContent).toContain('입력 한도에 도달했습니다');
      await act(async () => container.querySelector('button')!.click());
      expect(onChange.mock.calls.at(-1)?.[0]).toEqual([]);
      expect(container.textContent).not.toContain('입력 한도에 도달했습니다');
      await pointer('pointerdown');
      expect(onChange.mock.calls.at(-1)?.[0]).toHaveLength(1);
    } finally { await act(async () => root.unmount()); container.remove(); context.mockRestore(); }
  });
});
