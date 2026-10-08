import { afterEach, describe, expect, it } from "vitest";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkWebInstallOutput,
  prepareWebInstall,
} from "../scripts/web-install.mjs";
import { checkPagesOutput } from "../scripts/check-public-build.mjs";

const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wakey-web-install-"));
  directories.push(directory);
  cpSync(join(sourceRoot, "public"), directory, { recursive: true });
  const html = readFileSync(join(directory, "index.html"), "utf8")
    .replaceAll("%WEB_TITLE%", "Wakey-Wakey!")
    .replaceAll("%LANG_ISO_CODE%", "en");
  writeFileSync(join(directory, "index.html"), html);
  return directory;
}
function changeManifest(directory: string, change: (manifest: any) => void) {
  const path = join(directory, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  change(manifest);
  writeFileSync(path, JSON.stringify(manifest));
}
function changeHTML(directory: string, change: (html: string) => string) {
  const path = join(directory, "index.html");
  writeFileSync(path, change(readFileSync(path, "utf8")));
}
afterEach(() => {
  directories
    .splice(0)
    .forEach((directory) => rmSync(directory, { recursive: true }));
});

describe("Home Screen metadata and Pages export", () => {
  it("resolves source metadata and icon URLs at the local root", () => {
    const directory = fixture();
    expect(() => checkWebInstallOutput(directory)).not.toThrow();
    const html = readFileSync(join(directory, "index.html"), "utf8");
    expect(html).toContain("height: 100dvh");
    expect(html).not.toContain("safe-area-inset");
    expect(html).not.toContain("serviceWorker");
  });
  it("exports explicit project identity and resolves all icons alongside real artifact files", () => {
    const directory = fixture();
    prepareWebInstall(directory, "/wakey-wakey");
    const manifest = JSON.parse(
      readFileSync(join(directory, "manifest.webmanifest"), "utf8"),
    );
    expect([manifest.id, manifest.start_url, manifest.scope]).toEqual([
      "/wakey-wakey/",
      "/wakey-wakey/",
      "/wakey-wakey/",
    ]);
    expect(manifest.icons.map((icon: { src: string }) => icon.src)).toEqual([
      "/wakey-wakey/icon-192.png",
      "/wakey-wakey/icon-512.png",
    ]);
    const scripts = join(directory, "_expo/static/js/web");
    mkdirSync(scripts, { recursive: true });
    writeFileSync(join(scripts, "index.js"), "// Public export fixture.");
    writeFileSync(join(directory, ".nojekyll"), "");
    changeHTML(directory, (html) =>
      html.replace(
        "</body>",
        '<script src="/wakey-wakey/_expo/static/js/web/index.js"></script></body>',
      ),
    );
    expect(() => checkPagesOutput(directory)).not.toThrow();
  });
  it("can prepare a repeated export without changing identity or duplicating HTML metadata", () => {
    const directory = fixture();
    prepareWebInstall(directory, "/wakey-wakey");
    const html = readFileSync(join(directory, "index.html"), "utf8");
    const manifest = readFileSync(
      join(directory, "manifest.webmanifest"),
      "utf8",
    );
    prepareWebInstall(directory, "/wakey-wakey");
    expect(readFileSync(join(directory, "manifest.webmanifest"), "utf8")).toBe(
      manifest,
    );
    expect(readFileSync(join(directory, "index.html"), "utf8")).toBe(html);
    expect(() =>
      checkWebInstallOutput(directory, "/wakey-wakey"),
    ).not.toThrow();
  });
  it.each(["id", "start_url", "scope"])(
    "blocks a Pages manifest whose %s escapes the app project",
    (key) => {
      const directory = fixture();
      prepareWebInstall(directory, "/wakey-wakey");
      changeManifest(directory, (manifest) => {
        manifest[key] = "/";
      });
      expect(() => checkWebInstallOutput(directory, "/wakey-wakey")).toThrow(
        /identity/,
      );
    },
  );
  it.each(["/icon-192.png", "https://other.example.invalid/icon-192.png"])(
    "blocks an icon URL outside the app: %s",
    (url) => {
      const directory = fixture();
      prepareWebInstall(directory, "/wakey-wakey");
      changeManifest(directory, (manifest) => {
        manifest.icons[0].src = url;
      });
      expect(() => checkWebInstallOutput(directory, "/wakey-wakey")).toThrow(
        /app path/,
      );
    },
  );
  it("blocks an export missing the large install icon", () => {
    const directory = fixture();
    unlinkSync(join(directory, "icon-512.png"));
    expect(() => checkWebInstallOutput(directory)).toThrow(/artifact file/);
  });
  it("checks actual PNG dimensions instead of trusting the manifest", () => {
    const directory = fixture();
    cpSync(join(directory, "icon-192.png"), join(directory, "icon-512.png"));
    expect(() => checkWebInstallOutput(directory)).toThrow(/dimensions/);
  });
  it("blocks conflicting Apple touch icons", () => {
    const directory = fixture();
    changeHTML(directory, (html) =>
      html.replace(
        "</head>",
        '<link rel="apple-touch-icon" href="./icon-512.png" /></head>',
      ),
    );
    expect(() => checkWebInstallOutput(directory)).toThrow(
      /exactly one apple-touch-icon/,
    );
  });
  it("preserves device zoom while requesting viewport safe-area coverage", () => {
    const directory = fixture();
    changeHTML(directory, (html) =>
      html.replace(
        "viewport-fit=cover",
        "viewport-fit=cover, user-scalable=no",
      ),
    );
    expect(() => checkWebInstallOutput(directory)).toThrow(/user zoom/);
  });
  it("retains the supplied logo source and alpha in all resized PNGs", () => {
    const source = readFileSync(
      join(sourceRoot, "assets/wakey-wakey-icon.png"),
    );
    expect(createHash("sha256").update(source).digest("hex")).toBe(
      "4c25288ffa06096e2315c2a3304902baa83abcd56845ce67f27a40ee89012584",
    );
    for (const name of [
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
    ]) {
      const bytes = readFileSync(join(sourceRoot, "public", name));
      expect(bytes[25]).toBe(6); // PNG RGBA colour type preserves alpha.
    }
  });
});
