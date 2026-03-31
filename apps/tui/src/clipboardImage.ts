import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

const MACOS_CLIPBOARD_IMAGE_SWIFT = `
import AppKit
import Foundation

func writeStdout(_ data: Data) {
  FileHandle.standardOutput.write(data)
}

let pasteboard = NSPasteboard.general

if let png = pasteboard.data(forType: .png) {
  writeStdout(png)
  exit(0)
}

if let tiff = pasteboard.data(forType: .tiff),
   let bitmap = NSBitmapImageRep(data: tiff),
   let png = bitmap.representation(using: .png, properties: [:]) {
  writeStdout(png)
  exit(0)
}

fputs("No image data found on the clipboard.\\n", stderr)
exit(2)
`.trim();

function readClipboardImagePngMacOs(): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const child = spawn("swift", ["-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdout: Buffer[] = [];
    let stderr = "";

    child.on("error", reject);
    child.stdout?.on("data", (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      if (code === 2) {
        resolve(null);
        return;
      }
      reject(new Error(stderr.trim() || `Clipboard image helper exited with code ${code ?? -1}.`));
    });

    child.stdin?.end(MACOS_CLIPBOARD_IMAGE_SWIFT);
  });
}

type SpawnImpl = typeof spawn;

type ClipboardImagePayload = {
  readonly bytes: Buffer;
  readonly mimeType: string;
};

type LinuxClipboardImageHelper = {
  readonly listCommand: readonly [string, ...string[]];
  readonly readCommand: (mimeType: string) => readonly [string, ...string[]];
};

export interface ClipboardImageDependencies {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly spawnImpl?: SpawnImpl;
}

const CLIPBOARD_IMAGE_EXTENSION_BY_MIME: Record<string, string> = {
  "image/bmp": ".bmp",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/tiff": ".tiff",
  "image/webp": ".webp",
};

const SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES = Object.keys(CLIPBOARD_IMAGE_EXTENSION_BY_MIME);

function createLinuxClipboardImageHelpers(
  env: NodeJS.ProcessEnv,
): ReadonlyArray<LinuxClipboardImageHelper> {
  const hasWayland = Boolean(env.WAYLAND_DISPLAY?.trim());
  const hasX11 = Boolean(env.DISPLAY?.trim());
  const helpers: LinuxClipboardImageHelper[] = [];
  if (hasWayland || !hasX11) {
    helpers.push({
      listCommand: ["wl-paste", "--list-types"],
      readCommand: (mimeType) => ["wl-paste", "--no-newline", "--type", mimeType],
    });
  }
  if (hasX11 || !hasWayland) {
    helpers.push({
      listCommand: ["xclip", "-selection", "clipboard", "-t", "TARGETS", "-o"],
      readCommand: (mimeType) => ["xclip", "-selection", "clipboard", "-t", mimeType, "-o"],
    });
  }
  return helpers;
}

function readCommandStdout(
  command: readonly [string, ...string[]],
  spawnImpl: SpawnImpl,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    const stdout: Buffer[] = [];
    let stderr = "";

    child.on("error", reject);
    child.stdout?.on("data", (chunk) => {
      stdout.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      reject(new Error(stderr.trim() || `Clipboard helper exited with code ${code ?? -1}.`));
    });
  });
}

function pickClipboardImageMimeType(listedTypes: string): string | null {
  const available = new Set(
    listedTypes
      .split(/\r?\n/u)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const mimeType of SUPPORTED_CLIPBOARD_IMAGE_MIME_TYPES) {
    if (available.has(mimeType)) {
      return mimeType;
    }
  }
  return null;
}

async function readClipboardImageLinux(
  env: NodeJS.ProcessEnv,
  spawnImpl: SpawnImpl,
): Promise<ClipboardImagePayload | null> {
  for (const helper of createLinuxClipboardImageHelpers(env)) {
    try {
      const listedTypes = await readCommandStdout(helper.listCommand, spawnImpl);
      const mimeType = pickClipboardImageMimeType(listedTypes.toString("utf8"));
      if (!mimeType) {
        continue;
      }
      const bytes = await readCommandStdout(helper.readCommand(mimeType), spawnImpl);
      if (bytes.length > 0) {
        return { bytes, mimeType };
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function resolveClipboardImage(
  dependencies: Required<ClipboardImageDependencies>,
): Promise<ClipboardImagePayload | null> {
  if (dependencies.platform === "darwin") {
    const bytes = await readClipboardImagePngMacOs();
    return bytes && bytes.length > 0 ? { bytes, mimeType: "image/png" } : null;
  }

  if (dependencies.platform === "linux") {
    return await readClipboardImageLinux(dependencies.env, dependencies.spawnImpl);
  }

  return null;
}

const CLIPBOARD_IMAGE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

function createShortImageId(length: number): string {
  const bytes = randomBytes(length);
  let id = "";
  for (const byte of bytes) {
    id += CLIPBOARD_IMAGE_ID_ALPHABET[byte % CLIPBOARD_IMAGE_ID_ALPHABET.length];
  }
  return id;
}

export function createClipboardImageFileName(
  id = createShortImageId(5),
  extension = ".png",
): string {
  return `${id}${extension}`;
}

export async function saveClipboardImageToFile(
  directory: string,
  dependencies: ClipboardImageDependencies = {},
): Promise<string | null> {
  const clipboardImage = await resolveClipboardImage({
    env: dependencies.env ?? process.env,
    platform: dependencies.platform ?? process.platform,
    spawnImpl: dependencies.spawnImpl ?? spawn,
  });

  if (!clipboardImage || clipboardImage.bytes.length === 0) {
    return null;
  }

  await fs.mkdir(directory, { recursive: true });
  const extension = CLIPBOARD_IMAGE_EXTENSION_BY_MIME[clipboardImage.mimeType] ?? ".bin";
  const filePath = path.join(directory, createClipboardImageFileName(undefined, extension));
  await fs.writeFile(filePath, clipboardImage.bytes);
  return filePath;
}
