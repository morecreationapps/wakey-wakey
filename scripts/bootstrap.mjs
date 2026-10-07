import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Restore the supplied artwork byte for byte from its portable source encodings.
for (const [name, expectedHash] of [
  [
    "wakey-wakey-icon",
    "4c25288ffa06096e2315c2a3304902baa83abcd56845ce67f27a40ee89012584",
  ],
  [
    "wakey-wakey-wordmark",
    "dd4f18ac3fb7ec5a0c9a7c7fc488c015c8bfa05821c55e0ef43577e2960805ed",
  ],
]) {
  const artwork = new URL(`../assets/${name}.png.base64`, import.meta.url);
  const image = Buffer.from(readFileSync(artwork, "utf8").trim(), "base64");
  if (createHash("sha256").update(image).digest("hex") !== expectedHash)
    throw new Error(`The supplied ${name} source is damaged.`);
  writeFileSync(new URL(`../assets/${name}.png`, import.meta.url), image);
}

const seed = new URL("../src/data/localSeed.ts", import.meta.url);
if (!existsSync(seed)) {
  writeFileSync(
    seed,
    '/* Empty seed for a portable checkout. Never ship private rota data. */\nexport const localRotaText = "";\n',
  );
}
