import { rollbackReleaseFromEnv } from './render-release.mjs';

await rollbackReleaseFromEnv(process.env, process.argv[2]);
