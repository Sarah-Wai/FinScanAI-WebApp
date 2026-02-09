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

export interface ApiReceiptDetailResponse {
  receipt: ApiReceiptRow;
  items: ApiReceiptItemRow[];
}

@Injectable({ providedIn: "root" })
export class ReceiptApiService {
  private baseUrl = "http://localhost:8000/api";

  constructor(private http: HttpClient) {}

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
          confidence: Number(r.confidence ?? 0),
        })),
      ),
    );
  }

  getReceiptDetail(receiptId: number): Observable<ReceiptDetail> {
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
}
