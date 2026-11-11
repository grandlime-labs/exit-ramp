import { build } from "esbuild";
import { chmodSync, mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
await build({
  entryPoints: ["src/cli/bin.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  // ts-morph pulls in CommonJS deps: give the ESM bundle a require()
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __cr } from 'node:module';\nimport { fileURLToPath as __fu } from 'node:url';\nimport { dirname as __dn } from 'node:path';\nconst require = __cr(import.meta.url);\nconst __filename = __fu(import.meta.url);\nconst __dirname = __dn(__filename);" },
  logLevel: "info",
});
chmodSync("dist/cli.mjs", 0o755);
