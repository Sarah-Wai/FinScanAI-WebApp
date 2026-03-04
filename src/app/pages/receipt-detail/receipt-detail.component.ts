import { CommonModule } from "@angular/common";
import { Component } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router } from "@angular/router";
import { ReceiptApiService } from "../../shared/services/receipt-api.service";
import { ReceiptStatus } from "../../models/receipt.model";
import { Subject } from "rxjs";
import { takeUntil } from "rxjs/operators";
import {
  buildSamplePredictionLines,
  parsePredictionLog,
  FormattedPredictionLine,
} from "../../utils/prediction-log";   // <-- adjust path if needed


type ItemValidationStatus =
  | "OK"
  | "OUTLIER"
  | "NAME_ISSUE"
  | "SUSPICIOUS_PRICE"
  | "CHECK";

type ReceiptItem = {
  id: string; // row id
  name: string;
  currency: string; // "CAD", "USD"
  unitPrice: number; // editable
  confidence: number; // 0-100 (UI)
  validationStatus: ItemValidationStatus; // NEW
};

@Component({
  selector: "app-receipt-detail",
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: "./receipt-detail.component.html",
  styleUrl: "./receipt-detail.component.css",
})
export class ReceiptDetailComponent {
  private destroy$ = new Subject<void>();

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

  // Prev/Next navigation state
  private receiptIds: number[] = [];
  private receiptIndex = -1;

  get canPrev() {
    return this.receiptIndex > 0;
  }
  get canNext() {
    return (
      this.receiptIds.length > 0 &&
      this.receiptIndex >= 0 &&
      this.receiptIndex < this.receiptIds.length - 1
    );
  }

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

  // Receipt header fields
  receiptId!: number;
  receiptNumericId = 0;
  vendor = "";
  receiptName = "";
  receiptDate = "";
  status: ReceiptStatus | "" = "";
  confidence = 0;

  currency: "CAD" | "USD" = "CAD";
  subtotal = 0;
  tax = 0;
  total = 0;

  activeTab: "items" | "ocr" | "validation" | "prediction" = "items";

  local_folder_path = "/assets/best_images/";
  receiptImageUrl = "/assets/receipt-demo.png";
  rawOcrText = `RAW OCR will show here...\n...`;
  predictionLines: FormattedPredictionLine[] = [];
  showPredictions = false; // toggle view
  validationJson = ""; // for raw json view if you want

  //Summary fields
  summary_subtotal = 0;
  summary_tax = 0;
  summary_total = 0;
  summary_vendor: string | null = null;
  summary_phone: string | null = null;
  summary_address: string | null = null;
  summary_receipt_date: string | null = null;

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
  ) { }

  ngOnInit() {
    // Keep prev/next list from navigation state
    const st = (history.state ?? {}) as any;
    if (Array.isArray(st.ids) && st.ids.length > 0) {
      this.receiptIds = st.ids
        .map((x: any) => Number(x))
        .filter(Number.isFinite);
      this.receiptIndex = Number.isFinite(st.index) ? Number(st.index) : -1;
    }

    // reload when route :id changes
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe((pm) => {
      const id = Number(pm.get("id"));

      if (!id || Number.isNaN(id)) {
        this.loading = false;
        this.errorMsg = "Invalid receipt id";
        return;
      }

      this.receiptId = id;
      this.receiptNumericId = id;

      if (this.receiptIds.length > 0) {
        const idx = this.receiptIds.indexOf(id);
        if (idx >= 0) this.receiptIndex = idx;
      }

      this.loadReceipt(id);
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ----------------------------
  // Validation helpers
  // ----------------------------
  private safeJsonParse(value: unknown): any {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  private normName(s: unknown): string {
    return String(s ?? "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  private buildValidationIndex(validationJson: any) {
    const outlierNames = new Set<string>();
    const nameIssueNames = new Set<string>();
    const suspiciousNames = new Set<string>();

    const outliers = validationJson?.price_outliers?.outliers ?? [];
    for (const o of outliers) outlierNames.add(this.normName(o?.item_name));

    const issues = validationJson?.name_quality?.issues ?? [];
    for (const x of issues) nameIssueNames.add(this.normName(x?.item_name));

    const suspicious = validationJson?.price_range?.suspicious_prices ?? [];
    for (const s of suspicious) suspiciousNames.add(this.normName(s?.item_name));

    return { outlierNames, nameIssueNames, suspiciousNames };
  }

  private pickItemStatus(
    itemName: string,
    idx: {
      outlierNames: Set<string>;
      nameIssueNames: Set<string>;
      suspiciousNames: Set<string>;
    },
  ): ItemValidationStatus {
    const key = this.normName(itemName);

    // priority: outlier > suspicious > name issues > ok
    if (idx.outlierNames.has(key)) return "OUTLIER";
    if (idx.suspiciousNames.has(key)) return "SUSPICIOUS_PRICE";
    if (idx.nameIssueNames.has(key)) return "NAME_ISSUE";
    return "OK";
  }

  // ----------------------------
  // Load receipt
  // ----------------------------
  private loadReceipt(id: number) {
    this.loading = true;
    this.errorMsg = "";

    this.receiptApi.getReceiptDetail(id).subscribe({
      next: (detail: any) => {
        this.subtotal = Number(detail.subtotal || 0);
        this.tax = Number(detail.tax || 0);
        this.total = Number(detail.total || 0);

        this.status = detail.status ?? this.status;

        this.vendor = detail.vendor ?? this.vendor;
        this.receiptName = detail.receiptName ?? this.receiptName;
        this.receiptDate = detail.date ?? this.receiptDate;

        // confidence: support 0..1 or 0..100 from API
        const confRaw = Number(detail.confidence ?? this.confidence);
        this.confidence = confRaw <= 1 ? Math.round(confRaw * 100) : confRaw;

        this.rawOcrText = detail.ocrJson ? JSON.stringify(detail.ocrJson["ocr_text"], null, 2) : "No OCR JSON data";
        // ---- Build SAMPLE PREDICTIONS view ----
        const log = parsePredictionLog(detail.predictionLogJson);
        console.log(detail.predictionLogJson);

        this.predictionLines = buildSamplePredictionLines(log);

        // Optional: auto show if exists
        this.showPredictions = this.predictionLines.length > 0;


        // image
        this.receiptImageUrl =
          this.local_folder_path + String(detail.receiptName ?? "") + "_best_view.png";

        console.log("Receipt image URL:", this.receiptImageUrl);

        // --- validation: build index from parsed json ---
        // detail.validation?.validationJson preferred if your service maps it
        const vjson =
          detail?.validation?.validationJson ??
          detail?.validationJson ??
          null;

        const parsed = this.safeJsonParse(vjson);
        const idx = this.buildValidationIndex(parsed);

        const summary = detail.summary ?? null;
        if (summary) {
          this.summary_subtotal = Number(summary.subtotal ?? this.subtotal);
          this.summary_tax = Number(summary.tax ?? this.tax);
          this.summary_total = Number(summary.total ?? this.total);
          this.summary_vendor = summary.vendor ?? null;
          this.summary_phone = summary.phone ?? null;
          this.summary_address = summary.address ?? null;
          this.summary_receipt_date = summary.receipt_date ?? null;
        }

        // items (ensure validationStatus exists)
        const inItems = (detail.items ?? []) as any[];
        this.items = inItems.map((it: any) => {
          const name = String(it.name ?? it.item_name ?? "");
          const c = String(it.currency ?? "CAD").toUpperCase();
          const p = Number(it.unitPrice ?? it.unit_price ?? 0);

          // confidence in item: support 0..1 or 0..100
          const ic = Number(it.confidence ?? 0);
          const ic100 = ic <= 1 ? Math.round(ic * 100) : ic;

          return {
            id: String(it.id ?? it.item_id ?? ""),
            name,
            currency: c,
            unitPrice: p,
            confidence: Math.max(0, Math.min(100, ic100)),
            validationStatus: this.pickItemStatus(name, idx),
          } as ReceiptItem;
        });

        this.loading = false;
      },
      error: (err) => {
        console.error(err);
        this.loading = false;
        this.errorMsg = "Failed to load receipt detail";
      },
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

  // ---------- validation pill helpers for your template ----------
  itemStatusLabel(s: ItemValidationStatus) {
    switch (s) {
      case "OUTLIER":
        return "Outlier";
      case "SUSPICIOUS_PRICE":
        return "Price Warn";
      case "NAME_ISSUE":
        return "Name Issue";
      case "CHECK":
        return "Check";
      default:
        return "OK";
    }
  }

  itemStatusClass(s: ItemValidationStatus) {
    switch (s) {
      case "OUTLIER":
        return "bg-red-100 text-red-700 dark:bg-red-500/10 dark:text-red-300";
      case "SUSPICIOUS_PRICE":
        return "bg-amber-100 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300";
      case "NAME_ISSUE":
        return "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/10 dark:text-indigo-300";
      case "CHECK":
        return "bg-yellow-100 text-yellow-700 dark:bg-yellow-500/10 dark:text-yellow-300";
      default:
        return "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300";
    }
  }

  confidenceClass(c: number) {
    if (c >= 90) return "bg-emerald-100 text-emerald-700";
    if (c >= 75) return "bg-blue-100 text-blue-700";
    return "bg-amber-100 text-amber-700";
  }

  // ---------- actions ----------
  back() {
    this.router.navigate(["/receipts"]);
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

    const header = ["Item Name", "Currency", "Unit Price", "Confidence", "Validation"];
    const rows = this.items.map((it) => [
      `"${(it.name || "").replace(/"/g, '""')}"`,
      it.currency,
      String(it.unitPrice ?? ""),
      String(it.confidence ?? ""),
      it.validationStatus,
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
      {
        id: nextId,
        name: "",
        currency: "CAD",
        unitPrice: 0,
        confidence: 0,
        validationStatus: "CHECK",
      },
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

  approve() {
    this.approving = true;

    this.receiptApi.updateReceiptStatus(this.receiptId, "Processed").subscribe({
      next: (res) => {
        this.status = res.receipt.status as ReceiptStatus;
        //alert("Status update success as Processed");
      },
      error: (err) => {
        console.error(err);
        alert("Failed to update status");
      },
    });
    setTimeout(() => (this.approving = false), 700);
  }

  WrongExtraction() {
    this.receiptApi.updateReceiptStatus(this.receiptId, "Failed").subscribe({
      next: (res) => {
        this.status = res.receipt.status as ReceiptStatus;
        //alert("Status update success as Failed");
      },
      error: (err) => {
        console.error(err);
        alert("Failed to update status");
      },
    });
  }
  ErrorLayout() {
    this.receiptApi.updateReceiptStatus(this.receiptId, "Error").subscribe({
      next: (res) => {
        this.status = res.receipt.status as ReceiptStatus;
        //alert("Status update success as Error");
      },
      error: (err) => {
        console.error(err);
        alert("Failed to update status");
      },
    });
  }

  prevReceipt() {
    if (!this.canPrev) return;

    const nextIndex = this.receiptIndex - 1;
    const prevId = this.receiptIds[nextIndex];

    this.receiptIndex = nextIndex;

    this.router.navigate(["/receipts", prevId], {
      state: { ids: this.receiptIds, index: this.receiptIndex },
    });
  }

  nextReceipt() {
    if (!this.canNext) return;

    const nextIndex = this.receiptIndex + 1;
    const nextId = this.receiptIds[nextIndex];

    this.receiptIndex = nextIndex;

    this.router.navigate(["/receipts", nextId], {
      state: { ids: this.receiptIds, index: this.receiptIndex },
    });
  }

  trackByIndex(index: number): number {
    return index;
  }

  labelClass(label: string): string {
    if (!label || label === "O") {
      return "bg-gray-200/50 text-gray-700 dark:bg-white/[0.08] dark:text-gray-300";
    }

    // Price labels
    if (label.includes("PRICE")) {
      return "bg-green-200/50 text-green-700 dark:bg-green-500/20 dark:text-green-400";
    }

    // Menu item labels
    if (label.includes("MENU")) {
      return "bg-blue-200/50 text-blue-700 dark:bg-blue-500/20 dark:text-blue-400";
    }

    // Sum/total labels
    if (label.includes("SUM")) {
      return "bg-orange-200/50 text-orange-700 dark:bg-orange-500/20 dark:text-orange-400";
    }

    // Vendor/header labels
    if (label.includes("VENDOR") || label.includes("HEADER")) {
      return "bg-purple-200/50 text-purple-700 dark:bg-purple-500/20 dark:text-purple-400";
    }

    // Default for any other labels
    return "bg-gray-200/50 text-gray-700 dark:bg-white/[0.08] dark:text-gray-300";
  }

  // Shows "00 123.45" (space after first 2 digits) with 2 decimals
  formatPrice5(value: any): string {
    const num = Number(value);
    if (!isFinite(num)) return '';

    return num
      .toFixed(2)                       // always 2 decimals
      .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');  // add space grouping
  }

  // Convert back from "1 234.56" → 1234.56
  parsePrice5(raw: any): number {
    if (raw === null || raw === undefined) return 0;

    const normalized = String(raw).replace(/\s+/g, ''); // remove spaces
    const num = Number(normalized);

    return isFinite(num) ? num : 0;
  }
}
