/** Type-level exhaustiveness check and runtime rejection for unsupported commands. */
export function unhandledCommand(command: never): never {
  throw new Error("未対応の編集コマンドです");
}
