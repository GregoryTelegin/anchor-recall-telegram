import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createLicenseBanner, validateProjectLicense } from "./project-license.mjs";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeFile = "anchor-recall-companion.cjs";

/** Build on the developer machine; the server needs Node only, never esbuild/npm. */
export async function buildCompanion({ outdir = join(projectRoot, "dist/telegram-companion") } = {}) {
  const destination = resolve(outdir);
  const license = await readFile(join(projectRoot, "LICENSE"), "utf8");
  const licenseError = validateProjectLicense(license);
  if (licenseError) throw new Error(licenseError);
  const notices = await readFile(join(projectRoot, "THIRD_PARTY_NOTICES.md"), "utf8");
  const version = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8")).version;
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ["src/infrastructure/companion/server/cli-shared.ts"],
    outfile: runtimeFile,
    write: false, bundle: true, metafile: true, platform: "node", format: "cjs",
    target: "node24", sourcemap: false, legalComments: "inline",
    banner: { js: createLicenseBanner(notices) }
  });
  const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
  for (const output of Object.values(result.metafile.outputs)) for (const dependency of output.imports) {
    if (dependency.external && !builtins.has(dependency.path)) throw new Error("Companion artifact has an unbundled runtime dependency");
  }
  const copies = [
    ["LICENSE", "LICENSE"], ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.md"],
    ["deploy/telegram/anchor-recall-companion.service", "anchor-recall-companion.service"],
    ["deploy/telegram/config.example.json", "config.example.json"],
    ["deploy/telegram/install.py", "install.py"],
    ["deploy/telegram/update.py", "update.py"],
    ["deploy/telegram/backup.py", "backup.py"],
    ["deploy/telegram/health.py", "health.py"],
    ["deploy/telegram/enable-miniapp.py", "enable-miniapp.py"],
    ["deploy/telegram/configure-miniapp-menu.py", "configure-miniapp-menu.py"],
    ["docs/telegram-companion-quickstart-ru.md", "START-HERE-ru.md"],
    ["docs/telegram-miniapp.md", "MINIAPP-ru.md"],
    ["docs/telegram-backups.md", "BACKUPS-ru.md"],
    ["docs/telegram-health.md", "HEALTH-ru.md"],
    ["docs/telegram-companion-debian.md", "INSTALL.md"]
  ];
  const files = [runtimeFile, ...copies.map(([, name]) => name), "artifact.json"].sort();
  try {
    const info = await lstat(destination);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Companion output must be a real build directory");
    for (const name of await readdir(destination)) {
      if (![...files, "SHA256SUMS"].includes(name) || (await lstat(join(destination, name))).isSymbolicLink())
        throw new Error("Companion output contains unrelated files; choose a clean build directory");
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, runtimeFile), result.outputFiles[0].contents);
  for (const [source, name] of copies) await copyFile(join(projectRoot, source), join(destination, name));
  await writeFile(join(destination, "artifact.json"), JSON.stringify({ name: "anchor-recall-companion", version, node: ">=24", standalone: true, files }, null, 2) + "\n");
  const sums = [];
  for (const file of files) sums.push(`${createHash("sha256").update(await readFile(join(destination, file))).digest("hex")}  ${file}`);
  await writeFile(join(destination, "SHA256SUMS"), sums.join("\n") + "\n");
  return { directory: destination, entry: join(destination, runtimeFile), version, files: [...files, "SHA256SUMS"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) process.stdout.write("node scripts/build-companion.mjs [--outdir=dist/telegram-companion]\nBuilds a standalone Node >=24 server artifact. Does not start a listener.\n");
  else if (args.some(arg => !arg.startsWith("--outdir=") || !arg.slice(9)) || args.length > 1) {
    process.stderr.write("Use --help or one --outdir=directory argument.\n"); process.exitCode = 1;
  } else {
    buildCompanion({ ...(args[0] ? { outdir: args[0].slice(9) } : {}) }).then(result => {
      process.stdout.write(`Standalone companion built: ${result.directory} (${basename(result.entry)})\n`);
    }).catch(() => { process.stderr.write("Companion build failed. No server was started.\n"); process.exitCode = 1; });
  }
}
