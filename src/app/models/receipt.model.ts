export type ReceiptStatus = 'Approved' | 'Pending' | 'Rejected';

export interface ReceiptRow {
  id: number;
  receiptName: string;
  vendor: string;
  date: string;           // for displaying in table
  subtotal: number;
  tax: number;
  total: number;
  status: ReceiptStatus;
  confidence: number;
}

export interface ReceiptDetailItem {
  id: string;
  name: string;
  currency: string;
  unitPrice: number;
  confidence: number;
}

export interface ReceiptDetail {
  id: number;
  receiptName: string;
  vendor: string;
  date: string;
  subtotal: number;
  tax: number;
  total: number;
  status: ReceiptStatus;
  confidence: number;
  items: ReceiptDetailItem[];
}