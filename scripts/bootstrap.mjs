import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Restore the supplied artwork byte for byte from its portable source encoding.
const artwork = new URL("../assets/wakey-wakey-icon.png.base64", import.meta.url);
const icon = Buffer.from(readFileSync(artwork, "utf8").trim(), "base64");
if (
  createHash("sha256").update(icon).digest("hex") !==
  "4c25288ffa06096e2315c2a3304902baa83abcd56845ce67f27a40ee89012584"
)
  throw new Error("The supplied Wakey-Wakey icon source is damaged.");
writeFileSync(new URL("../assets/wakey-wakey-icon.png", import.meta.url), icon);

const seed = new URL("../src/data/localSeed.ts", import.meta.url);
if (!existsSync(seed)) {
  writeFileSync(
    seed,
    '/* Empty seed for a portable checkout. Never ship private rota data. */\nexport const localRotaText = "";\n',
  );
}
