import { existsSync, writeFileSync } from "node:fs";
const seed = new URL("../src/data/localSeed.ts", import.meta.url);
if (!existsSync(seed)) {
  writeFileSync(
    seed,
    '/* Empty seed for a portable checkout. Never ship private rota data. */\nexport const localRotaText = "";\n',
  );
}
