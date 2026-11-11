import { main } from "./index";

main(process.argv.slice(2), {
  out: (s) => process.stdout.write(s.endsWith("\n") ? s : s + "\n"),
  err: (s) => process.stderr.write(s.endsWith("\n") ? s : s + "\n"),
  env: process.env,
  cwd: process.cwd(),
}).then((code) => {
  process.exitCode = code;
});
