import { defineConfig, type Plugin } from "vite";

// The same policy ships as a <meta> tag (so it also applies on hosts that ignore _headers) and in public/_headers.
// `connect-src` allows only the Val Town API, used by the optional exporter with a token the user pastes.
// No inline scripts or styles, no eval: ts-morph is bundled and runs from our own origin.
export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src https://api.val.town; font-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";

function csp(): Plugin {
  return {
    name: "exit-ramp-csp",
    apply: "build",
    transformIndexHtml: { order: "post", handler: (html) => html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`) },
  };
}

export default defineConfig({
  base: "./",
  plugins: [csp()],
  build: { outDir: "../dist-web", emptyOutDir: true, target: "es2022", modulePreload: { polyfill: false }, chunkSizeWarningLimit: 8000 },
  define: { "process.env.NODE_ENV": '"production"' },
});
