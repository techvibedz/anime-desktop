import pkg from "../../package.json";

// Installed app version (electron-builder writes it into package.json).
export const APP_VERSION: string = (pkg as { version?: string }).version ?? "0.0.0";
