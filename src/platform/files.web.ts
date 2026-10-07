const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export function pickTextFile(): Promise<{ name: string; text: string } | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept =
      ".csv,.txt,.json,.ics,text/plain,text/csv,application/json,text/calendar";
    input.style.display = "none";
    const finish = () => input.remove();
    input.addEventListener(
      "cancel",
      () => {
        finish();
        resolve(null);
      },
      { once: true },
    );
    input.addEventListener(
      "change",
      async () => {
        const file = input.files?.[0];
        try {
          if (!file) return resolve(null);
          if (file.size > MAX_IMPORT_BYTES)
            throw new Error("Choose a rota or backup file smaller than 5 MB.");
          resolve({ name: file.name, text: await file.text() });
        } catch (error) {
          reject(error);
        } finally {
          finish();
        }
      },
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}
export async function exportTextFile(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<void> {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Allow the browser to consume the object URL before revoking it.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
