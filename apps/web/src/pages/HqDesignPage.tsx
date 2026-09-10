/** 디자인워크 — 브랜드 공간디자인 아카이브 열람.
 *  아카이브는 정적 단일 HTML로 public/design-archive/에 커밋되며, 원문을 가공 없이 그대로(iframe) 표시한다.
 *  전역 CSP(frame-ancestors 'none')는 nginx의 /design-archive/ 전용 블록에서 'self'로 완화된다. */

const ARCHIVE = {
  file: 'design-archive/space-design-260909.html',
  title: '올드페리도넛 공간디자인 아카이브',
  dated: '2026-09-09',
};

export function HqDesignPage() {
  const src = `${import.meta.env.BASE_URL}${ARCHIVE.file}`;
  return (
    <section className="page" aria-labelledby="design-heading">
      <header className="page-head">
        <div>
          <h1 id="design-heading">디자인워크</h1>
          <p>{ARCHIVE.title} · 기준일 {ARCHIVE.dated} · 원본 문서를 그대로 표시합니다</p>
        </div>
        <a className="button button-secondary" href={src} target="_blank" rel="noreferrer">새 창에서 열기</a>
      </header>
      <div className="panel design-archive-frame">
        <iframe src={src} title={ARCHIVE.title} loading="lazy" />
      </div>
    </section>
  );
}
