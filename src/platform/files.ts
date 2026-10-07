import * as DocumentPicker from "expo-document-picker";
import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export async function pickTextFile(): Promise<{
  name: string;
  text: string;
} | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? file.size ?? 0) > MAX_IMPORT_BYTES)
      throw new Error("Choose a rota or backup file smaller than 5 MB.");
    return { name: asset.name, text: await file.text() };
  } finally {
    // Remove only the picker copy in this app's cache, never the original chosen file.
    if (asset.uri.startsWith(Paths.cache.uri) && file.exists) file.delete();
  }
}

export async function exportTextFile(
  filename: string,
  text: string,
  mime = "text/plain",
): Promise<void> {
  if (!(await Sharing.isAvailableAsync()))
    throw new Error("File sharing is unavailable on this device.");
  const safeName =
    filename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120) ||
    "wakey-wakey.txt";
  const directory = new File(Paths.cache, `${Date.now()}-${safeName}`);
  directory.create({ overwrite: false });
  try {
    directory.write(text);
    await Sharing.shareAsync(directory.uri, {
      mimeType: mime,
      dialogTitle: "Save or share your Wakey-Wakey! export",
    });
  } finally {
    if (directory.exists) directory.delete();
  }
}
