import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  FileContent,
  FsChangeEvent,
  ImagePreview,
  ImageSize,
  MoveOutcome,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  PtyStateSnapshot,
  Result
} from './types'

export interface BipaneFsApi {
  home(): Promise<string>
  list(dir: string): Promise<Result<DirListing>>
  /**
   * Read a regular text file for the viewer. Non-regular files and binary
   * content come back as an error rather than a lossy decode.
   */
  read(target: string): Promise<Result<FileContent>>
  /**
   * Read a regular image file for a pane's status-bar preview, as a `data:`
   * URL. Only decodable formats and files within the preview ceiling come back;
   * anything else is an error the bar simply renders nothing for.
   */
  readImage(target: string): Promise<Result<ImagePreview>>
  /**
   * The pixel dimensions in an image's header, read without decoding it, so a
   * pane can reserve a preview of the right shape before reading the image
   * itself. Null when the target is not a previewable image, or when its header
   * does not carry the dimensions cheaply — nothing to reserve, not an error.
   */
  imageSize(target: string): Promise<ImageSize | null>
  /**
   * Overwrite a regular text file with edited content (the editor's save).
   * Returns the resolved path that was written.
   */
  write(target: string, text: string): Promise<Result<string>>
  open(target: string): Promise<string>
  reveal(target: string): Promise<void>
  rename(source: string, target: string): Promise<Result<string>>
  copy(sources: string[], destination: string, baseDir: string): Promise<Result<CopyOutcome>>
  move(sources: string[], destination: string, baseDir: string): Promise<Result<MoveOutcome>>
  remove(targets: string[]): Promise<Result<DeleteOutcome>>
  /**
   * Watch a directory for on-disk changes. Refcounted in main, so several
   * callers (both panes, or the same pane twice) may watch one directory.
   */
  watch(dir: string): Promise<void>
  unwatch(dir: string): Promise<void>
  onChanged(handler: (event: FsChangeEvent) => void): () => void
}

export interface BipanePtyApi {
  create(id: string, options: PtySpawnOptions): Promise<void>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  kill(id: string): void
  state(id: string): Promise<PtyStateSnapshot>
  onData(handler: (event: PtyDataEvent) => void): () => void
  onExit(handler: (event: PtyExitEvent) => void): () => void
}

export interface BipaneWindowApi {
  minimize(): Promise<void>
  toggleMaximize(): Promise<boolean>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  onMaximizedChange(handler: (maximized: boolean) => void): () => void
}

export interface BipaneApi {
  fs: BipaneFsApi
  pty: BipanePtyApi
  win: BipaneWindowApi
}
