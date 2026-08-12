// Render preDeployCommand는 셸 연산자(&&)를 해석하지 않고 전체를 첫 프로그램의 인자로
// 넘길 수 있다 — 실제로 "preflight.mjs migrate && node .../migrate.js"에서 migrate.js가
// 한 번도 실행되지 않았다(2026-08-12 장애). 반드시 이 단일 스크립트만 preDeployCommand로 쓴다.
import { runDeploymentPreflight } from "./preflight.mjs";

const code = runDeploymentPreflight(process.env, "migrate");
if (code !== 0) process.exit(code);

await import("../../../packages/db/dist/migrate.js");
console.log("pre-deploy migrate finished");
