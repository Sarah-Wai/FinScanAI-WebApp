import { Injectable } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { map, Observable } from "rxjs";
import {
  ReceiptRow,
  ReceiptStatus,
  ReceiptDetail,
} from "../../models/receipt.model";

export interface ApiReceiptRow {
  receipt_id: number;
  receipt_name: string;
  vendor: string | null;
  receipt_date: string | null;
  subtotal: number;
  tax: number;
  total: number;
  status: ReceiptStatus;
  confidence: number;
  raw_json: string | null;
  ocr_json: string | null;
  predictionlog_json: string | null;
  source_id: string;
}

export interface ApiReceiptItem {
  name: string;
  currency: string;
  price: number;
  confidence: number;
}

export interface ApiReceiptItemRow {
  item_id: number;
  receipt_id: number;
  item_name: string | null;
  currency: string | null;
  unit_price: number;
  confidence: number;
}

export interface ApiReceiptValidationRow {
  validation_id: number;
  receipt_id: number;
  subtotal_status: string | null;
  subtotal_discrepancy: number | null;
  subtotal_discrepancy_pct: number | null;
  outliers_count: number | null;
  name_quality_issues: number | null;
  price_range_warnings: number | null;
  validation_json: string | null;   // backend sends string
  created_at: string;
}
export interface ApiReceiptSummaryRow {
  summary_id: number;
  receipt_id: number;

  subtotal: number | null;
  tax: number | null;
  total: number | null;

  vendor: string | null;
  phone: string | null;
  address: string | null;
  receipt_date: string | null;
}


export interface ApiReceiptDetailResponse {
  receipt: ApiReceiptRow;
  items: ApiReceiptItemRow[];
  validation?: ApiReceiptValidationRow | null; // backend returns null when missing
  summary?: ApiReceiptSummaryRow | null;
}

export interface ReceiptValidation {
  id: number;
  receiptId: number;
  subtotalStatus: string;
  subtotalDiscrepancy: number;
  subtotalDiscrepancyPct: number;
  outliersCount: number;
  nameQualityIssues: number;
  priceRangeWarnings: number;
  validationJson: unknown;
  createdAt: string;
}

@Injectable({ providedIn: "root" })
export class ReceiptApiService {
  private baseUrl = "http://localhost:8000/api";

  constructor(private http: HttpClient) { }

  listReceipts(): Observable<ReceiptRow[]> {
    return this.http.get<ApiReceiptRow[]>(`${this.baseUrl}/receipts`).pipe(
      map((rows) =>
        rows.map((r) => ({
          id: r.receipt_id,
          receiptName: r.receipt_name,
          vendor: r.vendor ?? "",
          date: r.receipt_date ?? "",
          subtotal: Number(r.subtotal ?? 0),
          tax: Number(r.tax ?? 0),
          total: Number(r.total ?? 0),
          status: r.status,
          rawJson: r.raw_json ?? null,
          ocrJson: r.ocr_json ?? null,
          predictionLogJson: r.predictionlog_json ?? null,
          confidence: Number(r.confidence ?? 0),
        })),
      ),
    );
  }

  getReceiptDetail_1(receiptId: number): Observable<ReceiptDetail> {
    return this.http
      .get<ApiReceiptDetailResponse>(`${this.baseUrl}/receipts/${receiptId}`)
      .pipe(
        map((res) => ({
          id: res.receipt.receipt_id,
          receiptName: res.receipt.receipt_name,
          vendor: res.receipt.vendor ?? "",
          date: res.receipt.receipt_date ?? "",
          subtotal: Number(res.receipt.subtotal ?? 0),
          tax: Number(res.receipt.tax ?? 0),
          total: Number(res.receipt.total ?? 0),
          status: res.receipt.status,
          confidence: Number(res.receipt.confidence ?? 0),
          source_id: res.receipt.source_id ?? null,

          items: (res.items || []).map((it) => ({
            id: String(it.item_id), //  use item_id
            name: it.item_name ?? "", // item_name
            currency: (it.currency ?? "CAD").toUpperCase(),
            unitPrice: Number(it.unit_price ?? 0), // unit_price
            confidence: Number(it.confidence ?? 0),
          })),
        })),
      );
  }

  getReceiptDetail(receiptId: number): Observable<ReceiptDetail> {
    return this.http
      .get<ApiReceiptDetailResponse>(
        `${this.baseUrl}/receipts/${receiptId}?include_validation=true&include_summary=true`,
      )
      .pipe(
        map((res) => {
          const r = res.receipt;
          const v = res.validation ?? null;
          const s = (res as any).summary ?? null; // or res.summary if your type has it

          return {
            id: Number(r.receipt_id ?? 0),
            receiptName: r.receipt_name ?? "",
            vendor: r.vendor ?? "",
            date: r.receipt_date ?? "",
            subtotal: Number(r.subtotal ?? 0),
            tax: Number(r.tax ?? 0),
            total: Number(r.total ?? 0),
            status: r.status ?? "",
            confidence: Number(r.confidence ?? 0),
            source_id: r.source_id ?? null,
            rawJson: this.parseValidationJson(r.raw_json ?? null),
            ocrJson: this.parseValidationJson(r.ocr_json ?? null),
            predictionLogJson: this.parseValidationJson(r.predictionlog_json ?? null),

            items: (res.items ?? []).map((it) => ({
              id: String(it.item_id ?? 0),
              name: it.item_name ?? "",
              currency: String(it.currency ?? "CAD").toUpperCase(),
              unitPrice: Number(it.unit_price ?? 0),
              confidence: Number(it.confidence ?? 0),
            })),

            // include summary (or null)
            summary: s
              ? {
                summaryId: Number(s.summary_id ?? 0),
                receiptId: Number(s.receipt_id ?? 0),

                subtotal: s.subtotal == null ? null : Number(s.subtotal),
                tax: s.tax == null ? null : Number(s.tax),
                total: s.total == null ? null : Number(s.total),

                vendor: s.vendor ?? null,
                phone: s.phone ?? null,
                address: s.address ?? null,
                receiptDate: s.receipt_date ?? null,
              }
              : null,

            // include validation (or null)
            validation: v
              ? {
                id: Number(v.validation_id ?? 0),
                receiptId: Number(v.receipt_id ?? 0),
                subtotalStatus: v.subtotal_status ?? "",
                subtotalDiscrepancy:
                  v.subtotal_discrepancy == null ? null : Number(v.subtotal_discrepancy),
                subtotalDiscrepancyPct:
                  v.subtotal_discrepancy_pct == null ? null : Number(v.subtotal_discrepancy_pct),
                outliersCount: Number(v.outliers_count ?? 0),
                nameQualityIssues: Number(v.name_quality_issues ?? 0),
                priceRangeWarnings: Number(v.price_range_warnings ?? 0),
                validationJson: this.parseValidationJson(v.validation_json ?? null),
                createdAt: v.created_at ?? "",
              }
              : null,
          } as ReceiptDetail;
        }),
      );
  }

  private parseValidationJson(value: unknown): unknown {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  // receipt-api.service.ts
  updateReceiptStatus(receiptId: number, status: string) {
    return this.http.put<{
      ok: boolean;
      receipt: { receipt_id: number; status: string };
    }>(`${this.baseUrl}/receipts/${receiptId}/status`, { status });
  }


}
