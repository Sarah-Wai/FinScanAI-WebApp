import { Component, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";

type ScanItem = {
  id: string;
  kind: "image" | "pdf";
  source: "upload" | "camera";
  name: string;
  file?: File; // for upload items
  dataUrl?: string; // for camera items (base64)
  previewUrl: string; // image: dataUrl or objectURL; pdf: empty
};

@Component({
  selector: "app-scan-receipt",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./scan-receipt.component.html",
  styleUrl: "./scan-receipt.component.css",
})
export class ScanReceiptComponent implements OnInit {
  readonly MAX_ITEMS = 10;

  removeBg = false;
  deskew = false;

  items: ScanItem[] = [];
  selectedId?: string;

  limitMsg = "";
  statusMsg = "";

  skippedNames: string[] = [];

  isProcessing = false;
  progressLabel = "";
  private readonly NEW_KEY = "receipt_new_ids";
  newReceiptIds: number[] = [40,41,42,43,44,45]; // receipts that are NEW (unseen)

  constructor(private router: Router) {}

  ngOnInit(): void {
    // NEW: receive multiple camera images (preferred)
    const batch = sessionStorage.getItem("captured_receipts");
    if (batch) {
      try {
        const arr: string[] = JSON.parse(batch);
        arr.forEach((dataUrl, idx) =>
          this.addCameraDataUrl(dataUrl, `camera_${idx + 1}.jpg`),
        );
      } catch {
        // ignore parse error
      }
      sessionStorage.removeItem("captured_receipts");
    }

    // fallback: old single key
    const single = sessionStorage.getItem("captured_receipt");
    if (single) {
      this.addCameraDataUrl(single, "camera_1.jpg");
      sessionStorage.removeItem("captured_receipt");
    }

    // auto-select first
    if (this.items[0]) this.select(this.items[0].id);
  }

  openCameraPage() {
    this.router.navigate(["/camera-scan"]);
  }

  // --------------------------
  // Upload multiple
  // --------------------------
  onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";

    this.skippedNames = [];

    const remaining = this.MAX_ITEMS - this.items.length;

    // Nothing can be added
    if (remaining <= 0) {
      this.skippedNames = files.map((f) => f.name);
      this.limitMsg = `Max ${this.MAX_ITEMS} items per batch.`;
      return;
    }

    const toAdd = files.slice(0, remaining);
    const skipped = files.slice(remaining);

    for (const f of toAdd) {
      if (f.type === "application/pdf") this.addPdfFile(f);
      else this.addImageFile(f);
    }

    // Track skipped file names
    this.skippedNames = skipped.map((f) => f.name);

    if (this.skippedNames.length > 0) {
      this.limitMsg = `Only added ${toAdd.length}. Max ${this.MAX_ITEMS} per batch.`;
    } else {
      this.limitMsg = "";
    }

    if (!this.selectedId && this.items[0]) this.select(this.items[0].id);
  }

  private addImageFile(file: File) {
    const id = this.makeId();
    const url = URL.createObjectURL(file);

    this.items.unshift({
      id,
      kind: "image",
      source: "upload",
      name: file.name,
      file,
      previewUrl: url,
    });
  }

  private addPdfFile(file: File) {
    const id = this.makeId();
    this.items.unshift({
      id,
      kind: "pdf",
      source: "upload",
      name: file.name,
      file,
      previewUrl: "",
    });
  }

  // --------------------------
  // Camera dataURL -> items
  // --------------------------
  private addCameraDataUrl(dataUrl: string, name: string) {
    if (this.items.length >= this.MAX_ITEMS) {
      this.limitMsg = `Max ${this.MAX_ITEMS} items per batch.`;
      return;
    }

    const id = this.makeId();
    this.items.unshift({
      id,
      kind: "image",
      source: "camera",
      name,
      dataUrl,
      previewUrl: dataUrl,
    });
  }

  // --------------------------
  // Select / Remove / Clear
  // --------------------------
  get selectedItem(): ScanItem | undefined {
    return this.items.find((i) => i.id === this.selectedId);
  }

  select(id: string) {
    this.selectedId = id;
    this.statusMsg = "";
  }

  remove(id: string) {
    const idx = this.items.findIndex((i) => i.id === id);
    if (idx < 0) return;

    const item = this.items[idx];

    // cleanup object URL only for upload images
    if (item.source === "upload" && item.kind === "image" && item.previewUrl) {
      URL.revokeObjectURL(item.previewUrl);
    }

    this.items.splice(idx, 1);

    if (this.selectedId === id) {
      this.selectedId = this.items[0]?.id;
    }
  }

  clearAll() {
    // cleanup all object URLs
    for (const it of this.items) {
      if (it.source === "upload" && it.kind === "image" && it.previewUrl) {
        URL.revokeObjectURL(it.previewUrl);
      }
    }
    this.items = [];
    this.selectedId = undefined;
    this.limitMsg = "";
    this.statusMsg = "";
  }

  private saveNewIds() {
    localStorage.setItem(this.NEW_KEY, JSON.stringify(this.newReceiptIds));
  }

  // --------------------------
  // Run extraction (batch)
  // --------------------------
  async runExtraction() {
    if (this.items.length === 0 || this.isProcessing) return;

    this.isProcessing = true;
    this.progressLabel = "Starting…";
    this.statusMsg = "";

    try {
      // (Later) call backend here.
      // For now, simulate work:
      await this.fakeProgress();
      this.saveNewIds();

      // After backend success -> go to receipt list page
      this.router.navigate(["/receipts"]);
    } catch (err) {
      console.error(err);
      this.statusMsg = "Processing failed. Please try again.";
    } finally {
      this.isProcessing = false;
      this.progressLabel = "";
    }
  }

  private async fakeProgress() {
    const steps = [
      "Uploading…",
      "Preprocessing…",
      "Detecting receipt…",
      "Extracting items…",
      "Finalizing…",
    ];

    for (let i = 0; i < steps.length; i++) {
      this.progressLabel = steps[i];
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  // --------------------------
  // Utils
  // --------------------------
  private makeId() {
    return (
      (crypto as any)?.randomUUID?.() ??
      `${Date.now()}_${Math.random().toString(16).slice(2)}`
    );
  }
}
