import type { DesktopSnapshot } from "@clipboard-mate/contracts";

export interface ClipboardPort {
  readText(): string;
  writeText(value: string): void;
}

export interface ManualSyncPort {
  readonly snapshot: DesktopSnapshot;
  publishText(content: string): Promise<DesktopSnapshot>;
}

export class ManualClipboardActions {
  constructor(
    private readonly clipboard: ClipboardPort,
    private readonly sync: ManualSyncPort,
  ) {}

  publishLocalClipboard(): Promise<DesktopSnapshot> {
    return this.sync.publishText(this.clipboard.readText());
  }

  copySharedToLocal(): void {
    const value = this.sync.snapshot.state.value;
    if (!value) throw new Error("The shared clipboard is empty.");
    this.clipboard.writeText(value.content);
  }
}

