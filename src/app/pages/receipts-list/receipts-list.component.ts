import { Component, OnInit } from "@angular/core";
import { CommonModule } from "@angular/common";
import { Router } from "@angular/router";

import { ReceiptTableComponent } from "../../shared/components/receipt-table/receipt-table.component";
import { ReceiptRow } from "../../models/receipt.model";
import { ReceiptApiService } from "../../shared/services/receipt-api.service";

@Component({
  selector: "app-receipts-list",
  standalone: true,
  imports: [CommonModule, ReceiptTableComponent],
  templateUrl: "./receipts-list.component.html",
  styleUrl: "./receipts-list.component.css",
})
export class ReceiptsListComponent implements OnInit {
  receipts: ReceiptRow[] = [];
  loading = true;

  newReceiptIds: number[] = []; // receipts that are NEW (unseen)
  private readonly NEW_KEY = "receipt_new_ids";
  constructor(
    private api: ReceiptApiService,
    private router: Router,
  ) {}

  ngOnInit(): void {
    this.loading = true;
    this.loadNewIds();
    this.api.listReceipts().subscribe({
      next: (rows) => {
        this.receipts = rows;
        this.loading = false;
      },
      error: (err) => {
        console.error("Failed to load receipts", err);
        this.loading = false;
      },
    });
  }

  private loadNewIds() {
    try {
      this.newReceiptIds = JSON.parse(
        localStorage.getItem(this.NEW_KEY) || "[]",
      );
    } catch {
      this.newReceiptIds = [];
    }
  }
  private saveNewIds() {
    localStorage.setItem(this.NEW_KEY, JSON.stringify(this.newReceiptIds));
  }

  // called by table rowClick/viewClick
  openDetail(receiptId: number): void {
    // mark as seen
    const before = this.newReceiptIds.length;
    this.newReceiptIds = this.newReceiptIds.filter((id) => id !== receiptId);
    if (this.newReceiptIds.length !== before) this.saveNewIds();

    // navigate
    this.router.navigate(["/receipts", receiptId]);
  }

  deleteReceipt(id: number) {
    // later: call backend delete API
    this.receipts = this.receipts.filter((r) => r.id !== id);
    this.saveNewIds();
  }

  goToUpload() {
    this.router.navigate(["/scan-receipt"]);
  }

  // call this after upload/scan creates a new receipt
  addNewReceipt(receiptId: number) {
    if (!this.newReceiptIds.includes(receiptId)) {
      this.newReceiptIds = [receiptId, ...this.newReceiptIds];
      this.saveNewIds();
    }
  }
}
