import type { Dependency, Severity, Target } from "./types";

export const DOCS = {
  migrateCode: "https://docs.val.town/migration/cloudflare/migrate-code",
  migrateCrons: "https://docs.val.town/migration/cloudflare/migrate-crons",
  migrateSqlite: "https://docs.val.town/migration/cloudflare/migrate-sqlite",
  migrateBlobs: "https://docs.val.town/migration/cloudflare/migrate-blobs",
  migrateEmail: "https://docs.val.town/migration/cloudflare/migrate-email",
  migrateAi: "https://docs.val.town/migration/cloudflare/migrate-ai",
  secrets: "https://docs.val.town/migration/cloudflare/transfer-secrets",
  mapping: "https://docs.val.town/migration/cloudflare",
  kvLimits: "https://developers.cloudflare.com/kv/platform/limits/",
  kvConsistency: "https://developers.cloudflare.com/kv/concepts/how-kv-works/",
  denoKv: "https://docs.deno.com/deploy/kv/manual/",
  nodeCompat: "https://developers.cloudflare.com/workers/runtime-apis/nodejs/",
  cronTriggers: "https://developers.cloudflare.com/workers/configuration/cron-triggers/",
  denoIssue: "https://github.com/denoland/deno/issues/37030",
};

export type ImportKind =
  | "npm"
  | "jsr"
  | "esm-sh"
  | "cdn"
  | "deno-std"
  | "deno-x"
  | "esm-town"
  | "valtown-std"
  | "url"
  | "bare";

export interface ImportResolution {
  kind: ImportKind;
  spec: string;
  rule: string;
  severity: Severity;
  message: string;
  /** Replacement module specifier, when the import can be rewritten. */
  newSpec?: string;
  dep?: Dependency;
  /** Name of the Val Town std module (sqlite, blob, ...), for kind "valtown-std". */
  std?: string;
  docs?: string;
}

export type ImportMap = Record<string, string>;

/** Remove // and /* *\/ comments and trailing commas so deno.jsonc can be JSON.parsed. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
      i++;
    } else if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

export function readImportMap(files: { path: string; text: string }[]): ImportMap {
  const map: ImportMap = {};
  for (const f of files) {
    const base = f.path.split("/").pop() ?? "";
    if (!["deno.json", "deno.jsonc", "import_map.json"].includes(base)) continue;
    try {
      const j = parseJsonc(f.text) as { imports?: Record<string, string> };
      const imports = base === "import_map.json" ? (j as { imports?: Record<string, string> }).imports : j.imports;
      if (imports) Object.assign(map, imports);
    } catch {
      /* unparsable config: ignore, the scan warns elsewhere */
    }
  }
  return map;
}

/** Split "@scope/name@1.2.3/sub/path" into parts. */
export function splitPackageSpec(s: string): { name: string; version?: string; subpath?: string } | undefined {
  const m = s.match(/^((?:@[^/@]+\/)?[^/@]+)(?:@([^/]+))?(\/.*)?$/);
  if (!m) return undefined;
  return { name: m[1], version: m[2] || undefined, subpath: m[3] || undefined };
}

const DENO_STD_TO_JSR: Record<string, string> = {
  path: "@std/path",
  encoding: "@std/encoding",
  assert: "@std/assert",
  async: "@std/async",
  collections: "@std/collections",
  datetime: "@std/datetime",
  uuid: "@std/uuid",
  crypto: "@std/crypto",
  http: "@std/http",
  media_types: "@std/media-types",
  semver: "@std/semver",
  yaml: "@std/yaml",
  csv: "@std/csv",
  html: "@std/html",
  testing: "@std/testing",
  text: "@std/text",
  bytes: "@std/bytes",
  url: "@std/url",
  jsonc: "@std/jsonc",
  toml: "@std/toml",
  ulid: "@std/ulid",
};

export function jsrToNpmAlias(name: string, range: string): Dependency {
  // @std/path -> npm:@jsr/std__path
  const m = name.match(/^@([^/]+)\/(.+)$/);
  const alias = m ? `@jsr/${m[1]}__${m[2]}` : name;
  return { name, range: `npm:${alias}@${range}` };
}

function npmDep(name: string, version: string | undefined): { dep: Dependency; unpinned: boolean } {
  return { dep: { name, range: version ?? "latest" }, unpinned: !version };
}

const CDN_NPM: { host: RegExp; re: RegExp }[] = [
  { host: /^(?:www\.)?unpkg\.com$/, re: /^\/(?:npm\/)?(.+)$/ },
  { host: /^cdn\.jsdelivr\.net$/, re: /^\/npm\/(.+)$/ },
  { host: /^cdn\.skypack\.dev$/, re: /^\/(.+)$/ },
];

const ESM_TOWN_STD_FILES = /^(?:main|index|global)\.(?:ts|tsx|js)$/;

/** Classify one module specifier. Returns undefined for relative paths, node: builtins and data URLs. */
export function resolveImport(spec: string, ctx: { importMap: ImportMap; target: Target }): ImportResolution | undefined {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:") || spec.startsWith("data:") || spec.startsWith("cloudflare:")) return undefined;

  // import map (deno.json): exact or trailing-slash prefix match
  if (!/^(?:npm|jsr|https?):/.test(spec)) {
    let mapped: string | undefined;
    if (ctx.importMap[spec]) mapped = ctx.importMap[spec];
    else {
      for (const [k, v] of Object.entries(ctx.importMap)) {
        if (k.endsWith("/") && spec.startsWith(k)) {
          mapped = v + spec.slice(k.length);
          break;
        }
      }
    }
    if (mapped) {
      if (mapped.startsWith(".") || mapped.startsWith("/")) return undefined;
      const inner = resolveImport(mapped, { ...ctx, importMap: {} });
      if (inner) {
        return { ...inner, spec, newSpec: inner.newSpec ?? undefined, message: `import-map entry "${spec}" -> ${mapped}. ${inner.message}` };
      }
      return undefined;
    }
    // bare specifier with no mapping: assume it is already an npm package
    const p = splitPackageSpec(spec);
    if (!p) return undefined;
    // Node builtins without prefix (fs, path, ...) are handled by bundlers with nodejs_compat
    return {
      kind: "bare",
      spec,
      rule: "import-bare",
      severity: "review",
      message: `Bare import "${p.name}" is not in any import map. Added to package.json as "latest"; pin the version you used.`,
      dep: { name: p.name, range: "latest" },
    };
  }

  if (spec.startsWith("npm:")) {
    const p = splitPackageSpec(spec.slice(4));
    if (!p) return { kind: "npm", spec, rule: "import-npm", severity: "manual", message: `Could not parse ${spec}.` };
    const { dep, unpinned } = npmDep(p.name, p.version);
    return {
      kind: "npm",
      spec,
      rule: "import-npm",
      severity: unpinned ? "review" : "auto",
      message: unpinned ? `${spec} has no version; added "${p.name}": "latest". Pin it to the version your code was tested with.` : `${spec} -> package.json dependency ${p.name}@${p.version}.`,
      newSpec: p.name + (p.subpath ?? ""),
      dep,
      docs: DOCS.migrateCode,
    };
  }

  if (spec.startsWith("jsr:")) {
    const p = splitPackageSpec(spec.slice(4).replace(/^\//, ""));
    if (!p || !p.name.startsWith("@")) return { kind: "jsr", spec, rule: "import-jsr", severity: "manual", message: `Could not parse ${spec}.` };
    const range = p.version ?? "*";
    return {
      kind: "jsr",
      spec,
      rule: "import-jsr",
      severity: p.version ? "auto" : "review",
      message: `${spec} -> JSR package ${p.name} installed through JSR's npm registry (.npmrc is generated).${p.version ? "" : " No version given: pinned to \"*\"; set a real range."}`,
      newSpec: p.name + (p.subpath ?? ""),
      dep: jsrToNpmAlias(p.name, range),
      docs: "https://jsr.io/docs/npm-compatibility",
    };
  }

  let url: URL;
  try {
    url = new URL(spec);
  } catch {
    return { kind: "url", spec, rule: "import-url", severity: "manual", message: `Unparseable import ${spec}.` };
  }
  const host = url.hostname;

  if (host === "esm.town") {
    const m = url.pathname.match(/^\/v\/std\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const file = m[2];
      if (!file || ESM_TOWN_STD_FILES.test(file) || file === "") {
        return { kind: "valtown-std", spec, rule: `import-valtown-std-${m[1]}`, severity: "manual", message: `Val Town std/${m[1]}.`, std: m[1] };
      }
      return { kind: "valtown-std", spec, rule: `import-valtown-std-${m[1]}`, severity: "manual", message: `Val Town std/${m[1]}/${file}.`, std: m[1] };
    }
    return {
      kind: "esm-town",
      spec,
      rule: "import-esm-town",
      severity: "manual",
      message: `${spec} imports another val over esm.town. Copy that val's files into this project and import them relatively (preserve license and attribution). Bundling the URL does not remove the dependency on Val Town, which is shutting down on 2027-01-10.`,
      docs: DOCS.migrateCode,
    };
  }

  if (host === "esm.sh") {
    const path = url.pathname.replace(/^\/(?:v\d+|stable)\//, "/").replace(/^\/\*/, "/");
    const jsr = path.match(/^\/jsr\/(.+)$/);
    if (jsr) {
      const p = splitPackageSpec(jsr[1]);
      if (p && p.name.startsWith("@")) {
        const range = p.version ?? "*";
        return {
          kind: "jsr",
          spec,
          rule: "import-esm-sh",
          severity: p.version ? "auto" : "review",
          message: `esm.sh/jsr/${jsr[1]} -> JSR package ${p.name}.`,
          newSpec: p.name + (p.subpath ?? ""),
          dep: jsrToNpmAlias(p.name, range),
        };
      }
    }
    if (/^\/gh\//.test(path)) {
      return { kind: "esm-sh", spec, rule: "import-esm-sh", severity: "manual", message: `${spec} is a GitHub-hosted module; vendor it or publish it to npm.` };
    }
    const p = splitPackageSpec(path.slice(1));
    if (!p) return { kind: "esm-sh", spec, rule: "import-esm-sh", severity: "manual", message: `Could not parse ${spec}.` };
    const { dep, unpinned } = npmDep(p.name, p.version);
    const sub = (p.subpath ?? "").replace(/\.(?:m?js)$/, "");
    return {
      kind: "esm-sh",
      spec,
      rule: "import-esm-sh",
      severity: unpinned ? "review" : "auto",
      message: `${host} import -> npm dependency ${p.name}${p.version ? "@" + p.version : ""}.${url.search ? " Query options (" + url.search + ") were dropped: check bundling flags like ?deps or ?external." : ""}${unpinned ? " No version given; pinned to latest." : ""}`,
      newSpec: p.name + sub,
      dep,
      docs: DOCS.migrateCode,
    };
  }

  for (const c of CDN_NPM) {
    if (c.host.test(host)) {
      const m = url.pathname.match(c.re);
      const p = m && splitPackageSpec(m[1]);
      if (p) {
        const { dep, unpinned } = npmDep(p.name, p.version);
        return {
          kind: "cdn",
          spec,
          rule: "import-cdn",
          severity: unpinned || p.subpath ? "review" : "auto",
          message: `${host} import -> npm dependency ${p.name}${p.version ? "@" + p.version : ""}.${p.subpath ? " The CDN path (" + p.subpath + ") may not match the package's export map: check it." : ""}`,
          newSpec: p.name + (p.subpath && !/\/\+esm$/.test(p.subpath) ? p.subpath.replace(/\+esm$/, "") : ""),
          dep,
          docs: DOCS.migrateCode,
        };
      }
    }
  }

  if (host === "deno.land") {
    const std = url.pathname.match(/^\/std(?:@[^/]+)?\/([^/]+)(?:\/(.*))?$/);
    if (std) {
      const jsr = DENO_STD_TO_JSR[std[1]];
      if (jsr) {
        const sub = std[2] && !/^mod\.ts$/.test(std[2]) ? "/" + std[2].replace(/\/mod\.ts$/, "").replace(/\.ts$/, "") : "";
        return {
          kind: "deno-std",
          spec,
          rule: "import-deno-std",
          severity: "review",
          message: `deno.land/std/${std[1]} -> JSR ${jsr} (1.x). The old std@0.x APIs were reorganized; read the changelog for ${jsr}. For paths, node:path with nodejs_compat also works.`,
          newSpec: jsr + sub,
          dep: jsrToNpmAlias(jsr, "^1.0.0"),
          docs: "https://jsr.io/@std",
        };
      }
      return { kind: "deno-std", spec, rule: "import-deno-std", severity: "manual", message: `deno.land/std/${std[1]} depends on Deno runtime APIs and has no automatic Workers mapping. Use the web or node: equivalent.` };
    }
    return { kind: "deno-x", spec, rule: "import-deno-x", severity: "manual", message: `${spec} is a deno.land/x module. Look for the same package on npm or JSR, or vendor the source.` };
  }

  if (host === "cdn.deno.land" || host === "raw.githubusercontent.com" || host === "gist.githubusercontent.com") {
    return { kind: "url", spec, rule: "import-url", severity: "manual", message: `${spec} is a remote module. Workers bundlers cannot fetch it at build time. Vendor it into the repo (keeping attribution) or use an npm package.`, docs: DOCS.migrateCode };
  }

  return { kind: "url", spec, rule: "import-url", severity: "manual", message: `${spec} is a remote URL import. Inspect what it serves: use an npm package where one exists, otherwise vendor the source with attribution or keep it as an intentional external dependency (bundlers will not fetch it).`, docs: DOCS.migrateCode };
}

/** Advice per Val Town std/utils export (from docs.val.town/migration/cloudflare/migrate-code). */
export const UTILS_ADVICE: Record<string, string> = {
  readFile: "At build time use node:fs reads. At runtime import the file as text/JSON, or read a file bundled into the Worker.",
  listFiles: "Use node:fs.readdir at build time, or list bundled files at runtime. Workers cannot browse the original repository.",
  listFilesByPath: "Use node:fs.readdir at build time, or list bundled files at runtime.",
  serveFile: "Put public files in Workers Static Assets. Keep private files behind authentication.",
  staticHTTPServer: "Use Workers Static Assets (the [assets] block in wrangler.toml).",
  readFileTranspiled: "Compile browser TypeScript/JSX with Vite or your existing build; reference the built asset.",
  fetchTranspiledJavaScript: "Compile browser TypeScript/JSX with Vite or your existing build; reference the built asset.",
  serveImmutableFile: "Use build-generated hashed assets (Vite).",
  immutableFileUrl: "Use build-generated hashed assets (Vite).",
  hotReload: "Use the dev server's hot reload and remove the Val Town reload script from production.",
  httpEndpoint: "Configure the new URL explicitly (an env var or a constant) and update callers.",
  emailAddress: "Configure the new address explicitly and update callers.",
  parseVal: "Replace with explicit configuration: parseVal() describes a Val Town val, which no longer exists.",
};
