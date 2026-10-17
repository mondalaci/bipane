import type {
  CopyOutcome,
  DeleteOutcome,
  DirListing,
  PtyDataEvent,
  PtyExitEvent,
  PtySpawnOptions,
  PtyStateSnapshot,
  Result
} from './types'

export interface BipaneFsApi {
  home(): Promise<string>
  list(dir: string): Promise<Result<DirListing>>
  open(target: string): Promise<string>
  reveal(target: string): Promise<void>
  rename(source: string, target: string): Promise<Result<string>>
  copy(sources: string[], destination: string, baseDir: string): Promise<Result<CopyOutcome>>
  remove(targets: string[]): Promise<Result<DeleteOutcome>>
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
