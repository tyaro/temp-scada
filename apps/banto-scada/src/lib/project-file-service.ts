/**
 * The desktop's Project file host (alarm design §5.2, 3-C1): the host picks
 * the file in its own dialog and reads or writes it, so the saved Project is
 * the file the host wrote. The webview names a file only by the `fileId` the
 * host returned. The browser has no such host and keeps its download.
 */
export type ProjectFileFormat = "json" | "package";

export interface OpenedProjectFile {
  readonly fileId: number;
  readonly file: File;
}

export interface SaveProjectFileRequest {
  /** The file the Project came from or was last saved to; null for a new
   * Project or a sample (the host asks where to save). */
  readonly fileId: number | null;
  readonly format: ProjectFileFormat;
  /** The Project's name, for the save dialog's file name. */
  readonly name: string;
  /** Always ask where to save. */
  readonly saveAs: boolean;
  readonly content: Uint8Array;
}

export interface SavedProjectFile {
  readonly fileId: number;
  readonly fileName: string;
}

export interface ProjectFileService {
  /** null when the user cancelled the dialog. */
  open(): Promise<OpenedProjectFile | null>;
  /** null when the user cancelled the dialog. */
  save(request: SaveProjectFileRequest): Promise<SavedProjectFile | null>;
}

/** A refusal of the host, with its reason code. */
export class ProjectFileError extends Error {
  constructor(readonly reason: string) {
    super(projectFileReasonText(reason));
  }
}

export function projectFileReasonText(reason: string): string {
  switch (reason) {
    case "unauthorized":
      return "Project の保存には Admin でのログインが必要です。";
    case "forbidden":
      return "Project の保存は Admin だけが行えます。";
    case "auth_unavailable":
    case "auth_failed":
      return "認証を確かめられないため保存できません。";
    case "too_large":
      return "ファイルは80MiB以下にしてください。";
    case "unknown_format":
      return "Project ファイル（.json・.bantoscada）を選んでください。";
    case "not_found":
      return "ファイルまたはフォルダが見つかりません。";
    case "permission_denied":
      return "ファイルへのアクセスが拒否されました。";
    case "format_mismatch":
    case "invalid_request":
      return "保存の要求が不正です。";
    default:
      return `ファイルの読み書きに失敗しました（${reason}）。`;
  }
}
