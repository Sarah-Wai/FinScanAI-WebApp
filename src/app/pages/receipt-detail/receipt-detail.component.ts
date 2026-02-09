import { CommonModule } from "@angular/common";
import { Component } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { ReceiptApiService } from "../../shared/services/receipt-api.service";
import { ReceiptStatus } from "../../models/receipt.model";

type ReceiptItem = {
  id: string; // row id
  name: string;
  currency: string; // "CAD", "USD"
  unitPrice: number; // editable
  confidence: number; // 0-100
};

@Component({
  selector: "app-receipt-detail",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./receipt-detail.component.html",
  styleUrl: "./receipt-detail.component.css",
})
export class ReceiptDetailComponent {
  // Sizeable
  leftW = 300;
  rightW = 320;

  private dragMode: "left" | "right" | null = null;
  private dragStartX = 0;
  private startLeftW = 0;
  private startRightW = 0;

  startDrag(e: PointerEvent, mode: "left" | "right") {
    this.dragMode = mode;
    this.dragStartX = e.clientX;
    this.startLeftW = this.leftW;
    this.startRightW = this.rightW;

    (e.target as HTMLElement).setPointerCapture(e.pointerId);

    window.addEventListener("pointermove", this.onDragMove);
    window.addEventListener("pointerup", this.onDragEnd);
  }

  private onDragMove = (e: PointerEvent) => {
    if (!this.dragMode) return;

    const dx = e.clientX - this.dragStartX;

    const LEFT_MIN = 220;
    const LEFT_MAX = 520;

    const RIGHT_MIN = 240;
    const RIGHT_MAX = 520;

    if (this.dragMode === "left") {
      const next = this.startLeftW + dx;
      this.leftW = Math.max(LEFT_MIN, Math.min(LEFT_MAX, next));
    }

    if (this.dragMode === "right") {
      const next = this.startRightW - dx;
      this.rightW = Math.max(RIGHT_MIN, Math.min(RIGHT_MAX, next));
    }
  };

  private onDragEnd = (_e: PointerEvent) => {
    this.dragMode = null;
    window.removeEventListener("pointermove", this.onDragMove);
    window.removeEventListener("pointerup", this.onDragEnd);
  };

  // Zoom
  zoom = 1;
  minZoom = 0.6;
  maxZoom = 2.5;
  zoomStep = 0.15;

  baseWidth = 400;

  zoomIn() {
    this.zoom = Math.min(this.zoom + this.zoomStep, this.maxZoom);
  }

  zoomOut() {
    this.zoom = Math.max(this.zoom - this.zoomStep, this.minZoom);
  }

  // Receipt header fields (will be overwritten by API)
  receiptId = ""; // string for export filenames
  receiptNumericId = 0; // numeric for API calls
  vendor = "";
  receiptName = "";
  receiptDate = "";
  status: ReceiptStatus | "" = "";
  confidence = 0;

  currency: "CAD" | "USD" = "CAD";
  subtotal = 0;
  tax = 0;
  total = 0;

  activeTab: "items" | "ocr" = "items";

  receiptImageUrl = "/assets/receipt-demo.png";
  rawOcrText = `RAW OCR will show here...\nLine 1...\nLine 2...`;

  items: ReceiptItem[] = [];

  // UI state
  loading = true;
  errorMsg = "";
  approving = false;
  exporting = false;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private receiptApi: ReceiptApiService,
  ) {}

  ngOnInit() {
    const idStr = this.route.snapshot.paramMap.get("id") ?? "";
    const id = Number(idStr);

    this.receiptId = idStr;
    this.receiptNumericId = id;

    if (!id || Number.isNaN(id)) {
      this.loading = false;
      this.errorMsg = "Invalid receipt id";
      return;
    }

    this.loading = true;
    this.errorMsg = "";

    this.receiptApi.getReceiptDetail(id).subscribe((detail) => {
      this.subtotal = detail.subtotal;
      this.tax = detail.tax;
      this.total = detail.total;

      this.items = detail.items; // already in UI shape
    });
  }

  recalcTotal() {
    const s = Number(this.subtotal || 0);
    const t = Number(this.tax || 0);
    this.total = Math.round((s + t) * 100) / 100;
  }

  trackByItemId(_index: number, it: { id: string }) {
    return it.id;
  }

  // ---------- computed summary ----------
  formatMoney(n: number, currency = "CAD") {
    try {
      return new Intl.NumberFormat("en-CA", {
        style: "currency",
        currency,
      }).format(n);
    } catch {
      return `$${n.toFixed(2)}`;
    }
  }

  // ---------- actions ----------
  back() {
    this.router.navigate(["/receipts"]);
  }

  approve() {
    this.approving = true;
    setTimeout(() => (this.approving = false), 700);
  }

  exportJson() {
    this.exporting = true;

    const payload = {
      receiptId: this.receiptId,
      receiptName: this.receiptName,
      vendor: this.vendor,
      date: this.receiptDate,
      status: this.status,
      confidence: this.confidence,
      items: this.items,
      summary: { subtotal: this.subtotal, tax: this.tax, total: this.total },
      rawOcr: this.rawOcrText,
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    this.downloadBlob(blob, `receipt_${this.receiptId}.json`);

    setTimeout(() => (this.exporting = false), 350);
  }

  exportCsv() {
    this.exporting = true;

    const header = ["Item Name", "Currency", "Unit Price", "Confidence"];
    const rows = this.items.map((it) => [
      `"${(it.name || "").replace(/"/g, '""')}"`,
      it.currency,
      String(it.unitPrice ?? ""),
      String(it.confidence ?? ""),
    ]);
    const csv = [header.join(","), ...rows.map((r) => r.join(","))].join("\n");

    const blob = new Blob([csv], { type: "text/csv" });
    this.downloadBlob(blob, `receipt_${this.receiptId}.csv`);

    setTimeout(() => (this.exporting = false), 350);
  }

  addRow() {
    const nextId = String(Date.now());
    this.items = [
      ...this.items,
      { id: nextId, name: "", currency: "CAD", unitPrice: 0, confidence: 0 },
    ];
  }

  deleteRow(rowId: string) {
    this.items = this.items.filter((it) => it.id !== rowId);
  }

  autoFix() {
    this.items = this.items.map((it) => ({
      ...it,
      name: (it.name || "").trim(),
      unitPrice: Math.max(0, Number(it.unitPrice) || 0),
      confidence: Math.max(0, Math.min(100, Number(it.confidence) || 0)),
    }));
  }

  confidenceClass(c: number) {
    if (c >= 90) return "bg-emerald-100 text-emerald-700";
    if (c >= 75) return "bg-blue-100 text-blue-700";
    return "bg-amber-100 text-amber-700";
  }

  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 800);
  }
}
