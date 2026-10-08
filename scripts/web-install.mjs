import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const WEB_APP_NAME = "Wakey-Wakey!";
export const WEB_THEME_COLOR = "#FECC07";
const origin = "https://wakey-wakey.invalid";

function appRoot(basePath) {
  if (basePath && !/^\/[a-z0-9-]+$/i.test(basePath))
    throw new Error("Web install base path must be empty or one project path.");
  return `${basePath}/`;
}

/** Exported identity is explicit; source-relative URLs also work in local previews. */
export function prepareWebInstall(directory, basePath = "") {
  const root = appRoot(basePath);
  const path = join(directory, "manifest.webmanifest");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.id = root;
  manifest.start_url = root;
  manifest.scope = root;
  manifest.icons = manifest.icons.map((icon) => ({
    ...icon,
    src: `${root}${icon.sizes === "192x192" ? "icon-192.png" : "icon-512.png"}`,
  }));
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

function attributes(tag) {
  return Object.fromEntries(
    [...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(
      (match) => [match[1].toLowerCase(), match[2] ?? match[3]],
    ),
  );
}

function pngSize(path) {
  const bytes = readFileSync(path);
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("A Home Screen icon is not a PNG image.");
  return `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`;
}

/** Fail exports whose install metadata resolves outside the app or to missing icons. */
export function checkWebInstallOutput(directory, basePath = "") {
  const output = resolve(directory),
    root = appRoot(basePath);
  const html = readFileSync(join(output, "index.html"), "utf8");
  const meta = [...html.matchAll(/<meta\b[^>]*>/gi)].map((match) =>
    attributes(match[0]),
  );
  const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((match) =>
    attributes(match[0]),
  );
  const one = (items, key, value) => {
    const found = items.filter((item) => item[key]?.toLowerCase() === value);
    if (found.length !== 1)
      throw new Error(`Web install requires exactly one ${value} tag.`);
    return found[0];
  };
  const target = (url, expected) => {
    const resolved = new URL(url, `${origin}${root}`);
    if (
      resolved.origin !== origin ||
      resolved.pathname !== `${root}${expected}`
    )
      throw new Error("A Home Screen metadata URL does not use the app path.");
    const path = resolve(
      output,
      decodeURIComponent(resolved.pathname.slice(root.length)),
    );
    if (
      relative(output, path).startsWith("..") ||
      !existsSync(path) ||
      !lstatSync(path).isFile()
    )
      throw new Error(
        "A Home Screen metadata URL does not resolve to an artifact file.",
      );
    return path;
  };
  const manifestLink = one(links, "rel", "manifest");
  const manifest = JSON.parse(
    readFileSync(target(manifestLink.href, "manifest.webmanifest"), "utf8"),
  );
  for (const key of ["id", "start_url", "scope"])
    if (
      new URL(manifest[key], `${origin}${root}manifest.webmanifest`).href !==
      `${origin}${root}`
    )
      throw new Error("Manifest identity must use the app root.");
  if (
    manifest.name !== WEB_APP_NAME ||
    manifest.short_name !== WEB_APP_NAME ||
    manifest.display !== "standalone"
  )
    throw new Error("Manifest name or standalone display is incorrect.");
  if (
    manifest.theme_color !== WEB_THEME_COLOR ||
    manifest.background_color !== WEB_THEME_COLOR
  )
    throw new Error("Manifest colours must retain the brand yellow.");
  for (const size of [192, 512]) {
    const icon = manifest.icons?.find(
      (icon) => icon.sizes === `${size}x${size}`,
    );
    if (!icon || icon.type !== "image/png" || icon.purpose !== "any")
      throw new Error(
        "Manifest must include ordinary 192 and 512 pixel PNG icons.",
      );
    if (pngSize(target(icon.src, `icon-${size}.png`)) !== icon.sizes)
      throw new Error(
        "Manifest icon dimensions do not match its declared size.",
      );
  }
  const appleIcon = one(links, "rel", "apple-touch-icon");
  if (
    appleIcon.sizes !== "180x180" ||
    pngSize(target(appleIcon.href, "apple-touch-icon.png")) !== "180x180"
  )
    throw new Error("Apple touch icon must be a 180 pixel PNG.");
  for (const [name, expected] of [
    ["theme-color", WEB_THEME_COLOR],
    ["apple-mobile-web-app-capable", "yes"],
    ["apple-mobile-web-app-title", WEB_APP_NAME],
    ["apple-mobile-web-app-status-bar-style", "default"],
  ])
    if (one(meta, "name", name).content !== expected)
      throw new Error(`Web install ${name} metadata is incorrect.`);
  const viewport = one(meta, "name", "viewport").content;
  for (const expected of [
    "width=device-width",
    "initial-scale=1",
    "viewport-fit=cover",
  ])
    if (!viewport?.split(/\s*,\s*/).includes(expected))
      throw new Error(
        "Web viewport must fit the device and expose safe-area insets.",
      );
  if (/maximum-scale|user-scalable\s*=\s*(?:no|0)/i.test(viewport))
    throw new Error("Web viewport must preserve user zoom.");
  if (!/height:\s*100dvh/.test(html) || !/height:\s*100%/.test(html))
    throw new Error(
      "Web app shell must use dynamic viewport height with a fallback.",
    );
}
