// camera-scan.component.ts (UPDATED: split long receipts into segments + enhance)
import { Component, ElementRef, ViewChild, AfterViewInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { FormsModule } from '@angular/forms';

declare const cv: any;

type ReceiptShot = {
  id: string;
  blob: Blob;
  url: string;
  source: 'camera' | 'upload';
  createdAt: number;
  partIndex?: number;   // 1-based segment index for long receipts
  partCount?: number;   // total segments for that long receipt
};

@Component({
  selector: 'app-camera-scan',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './camera-scan.component.html',
  styleUrl: './camera-scan.component.css',
})
export class CameraScanComponent implements AfterViewInit, OnDestroy {
  @ViewChild('video') videoRef!: ElementRef<HTMLVideoElement>;
  @ViewChild('canvas') canvasRef!: ElementRef<HTMLCanvasElement>;   // full-res capture canvas
  @ViewChild('work') workRef!: ElementRef<HTMLCanvasElement>;       // small detection canvas
  @ViewChild('overlay') overlayRef!: ElementRef<HTMLCanvasElement>; // overlay drawing

  // ============================
  // Batch / multi receipts
  // ============================
  readonly MAX_RECEIPTS = 10;
  receipts: ReceiptShot[] = [];

  selectedId?: string;
  selectedUrl?: string;
  selectedBlob?: Blob;

  limitMsg = '';
  uploadMsg = '';
  isUploading = false;

  // ============================
  // Camera / OpenCV
  // ============================
  private stream?: MediaStream;
  private usingFront = false;

  showGrid = true;

  canCapture = false;
  cameraHint = 'Loading OpenCV...';
  private cvReady = false;
  private detectTimer?: number;

  private lastCorners: { x: number; y: number }[] | null = null;
  private stableCount = 0;

  // Quality toggles (used by HTML ngModel)
  saveAsPng = false;
  sharpenAfterWarp = true;

  constructor(private router: Router) {}

  // ============================
  // UI actions
  // ============================
  toggleGrid() { this.showGrid = !this.showGrid; }

  goBack() {
    this.router.navigate(['/scan-receipt']);
  }

  // ============================
  // Lifecycle
  // ============================
  async ngAfterViewInit() {
    await this.waitForOpenCV();
    await this.startCamera();
  }

  ngOnDestroy() {
    this.stopCamera();
    // cleanup object urls
    this.receipts.forEach(r => URL.revokeObjectURL(r.url));
  }

  // ============================
  // OpenCV ready
  // ============================
  private async waitForOpenCV() {
    this.cameraHint = 'Loading OpenCV...';

    const maxWaitMs = 12000;
    const start = Date.now();

    while (!(window as any).cv) {
      if (Date.now() - start > maxWaitMs) {
        this.cameraHint = 'OpenCV not loaded. Check index.html script.';
        return;
      }
      await new Promise(r => setTimeout(r, 50));
    }

    const cvAny: any = (window as any).cv;

    await new Promise<void>((resolve) => {
      if (cvAny?.Mat) return resolve();
      cvAny['onRuntimeInitialized'] = () => resolve();
    });

    this.cvReady = true;
    this.cameraHint = 'Point camera at receipt';
  }

  // ============================
  // Camera start/stop
  // ============================
  async startCamera() {
    this.stopCamera();

    const constraints: MediaStreamConstraints = {
      video: {
        facingMode: this.usingFront ? 'user' : { ideal: 'environment' },
        width: { ideal: 2560 },   // slightly higher ideal resolution
        height: { ideal: 1440 },
        frameRate: { ideal: 30, max: 30 },
      } as any,
      audio: false,
    };

    this.stream = await navigator.mediaDevices.getUserMedia(constraints);

    // optional: try continuous focus/exposure (may be ignored on iOS)
    try {
      const track = this.stream.getVideoTracks?.()[0];
      await track?.applyConstraints?.({
        advanced: [{ focusMode: 'continuous', exposureMode: 'continuous', whiteBalanceMode: 'continuous' }]
      } as any);
      console.log('iOS camera settings:', track?.getSettings?.());
    } catch {}

    const video = this.videoRef.nativeElement;
    video.srcObject = this.stream;

    await new Promise<void>((resolve) => {
      video.onloadedmetadata = () => resolve();
    });

    try { await video.play(); } catch {}
    await new Promise(r => setTimeout(r, 450)); // let focus settle

    this.resizeOverlayToVideoBox();
    this.startDetectLoop();
    window.addEventListener('resize', this.onResize);
  }

  stopCamera() {
    this.stopDetectLoop();
    window.removeEventListener('resize', this.onResize);

    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = undefined;
    }

    this.canCapture = false;
    this.lastCorners = null;
    this.stableCount = 0;
    this.clearOverlay();
  }

  async switchCamera() {
    this.usingFront = !this.usingFront;
    await this.startCamera();
  }

  private onResize = () => {
    this.resizeOverlayToVideoBox();
  };

  private resizeOverlayToVideoBox() {
    const video = this.videoRef?.nativeElement;
    const overlay = this.overlayRef?.nativeElement;
    if (!video || !overlay) return;

    const rect = video.getBoundingClientRect();
    overlay.width = Math.max(1, Math.floor(rect.width));
    overlay.height = Math.max(1, Math.floor(rect.height));
  }

  // ============================
  // Live detection loop
  // ============================
  private startDetectLoop() {
    if (!this.cvReady) return;
    this.stopDetectLoop();
    this.detectTimer = window.setInterval(() => this.detectOnce(), 220);
  }

  private stopDetectLoop() {
    if (this.detectTimer) {
      clearInterval(this.detectTimer);
      this.detectTimer = undefined;
    }
  }

  private detectOnce() {
    if (!this.cvReady) return;

    const video = this.videoRef.nativeElement;
    if (!video.videoWidth || !video.videoHeight) return;

    const work = this.workRef.nativeElement;
    const W = 360;
    const H = Math.round((video.videoHeight / video.videoWidth) * W);
    work.width = W;
    work.height = H;

    const ctx = work.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, W, H);

    const corners = this.findReceiptCornersOnCanvas(work);
    const areaFrac = corners ? this.polyAreaFrac(corners) : 0;

    const ok = this.updateStability(corners, areaFrac);
    this.canCapture = ok;

    const MIN_AREA_FRAC = 0.40;

    if (!corners) {
      this.cameraHint = 'Point camera at receipt';
    } else if (areaFrac < MIN_AREA_FRAC) {
      this.cameraHint = 'Move closer — receipt too small';
    } else if (!ok) {
      this.cameraHint = 'Hold steady…';
    } else if (this.receipts.length >= this.MAX_RECEIPTS) {
      this.cameraHint = `Limit reached (${this.MAX_RECEIPTS}). Process or clear.`;
    } else {
      this.cameraHint = 'Ready — tap Capture';
    }

    this.drawOverlayCorners(corners, W, H);
  }

  private updateStability(
    corners: { x: number; y: number }[] | null,
    areaFrac: number
  ): boolean {
    const MIN_AREA_FRAC = 0.40;

    if (!corners || corners.length !== 4) {
      this.lastCorners = null;
      this.stableCount = 0;
      return false;
    }

    // Gate: require receipt to be large enough in frame (quality)
    if (areaFrac < MIN_AREA_FRAC) {
      this.lastCorners = null;
      this.stableCount = 0;
      return false;
    }

    if (!this.lastCorners) {
      this.lastCorners = corners;
      this.stableCount = 0;
      return false;
    }

    const avgMove = this.avgCornerMove(this.lastCorners, corners);
    this.lastCorners = corners;

    if (avgMove < 4) this.stableCount++;
    else this.stableCount = 0;

    return this.stableCount >= 6;
  }

  private avgCornerMove(a: {x:number;y:number}[], b: {x:number;y:number}[]) {
    let sum = 0;
    for (let i = 0; i < 4; i++) sum += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
    return sum / 4;
  }

  private polyAreaFrac(pts: {x:number;y:number}[]) {
    let a = 0;
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      a += pts[i].x * pts[j].y - pts[j].x * pts[i].y;
    }
    a = Math.abs(a) / 2;

    const work = this.workRef.nativeElement;
    const denom = work.width * work.height;
    return denom > 0 ? a / denom : 0;
  }

  private clearOverlay() {
    const overlay = this.overlayRef?.nativeElement;
    if (!overlay) return;
    const octx = overlay.getContext('2d');
    if (!octx) return;
    octx.clearRect(0, 0, overlay.width, overlay.height);
  }

  private drawOverlayCorners(
    corners: { x: number; y: number }[] | null,
    workW: number,
    workH: number
  ) {
    const overlay = this.overlayRef.nativeElement;
    const octx = overlay.getContext('2d');
    if (!octx) return;

    octx.clearRect(0, 0, overlay.width, overlay.height);
    if (!corners) return;

    const map = this.getContainMapping(workW, workH, overlay.width, overlay.height);
    const pts = corners.map(p => ({
      x: map.offsetX + p.x * map.scale,
      y: map.offsetY + p.y * map.scale,
    }));

    octx.lineWidth = this.canCapture ? 4 : 3;
    octx.strokeStyle = this.canCapture ? 'rgba(34,197,94,0.95)' : 'rgba(59,130,246,0.95)';

    octx.beginPath();
    octx.moveTo(pts[0].x, pts[0].y);
    octx.lineTo(pts[1].x, pts[1].y);
    octx.lineTo(pts[2].x, pts[2].y);
    octx.lineTo(pts[3].x, pts[3].y);
    octx.closePath();
    octx.stroke();

    for (const p of pts) {
      octx.fillStyle = octx.strokeStyle;
      octx.beginPath();
      octx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      octx.fill();
    }
  }

  private getContainMapping(srcW: number, srcH: number, dstW: number, dstH: number) {
    const srcAR = srcW / srcH;
    const dstAR = dstW / dstH;

    let scale = 1;
    let drawW = dstW;
    let drawH = dstH;

    if (srcAR > dstAR) {
      scale = dstW / srcW;
      drawW = dstW;
      drawH = srcH * scale;
    } else {
      scale = dstH / srcH;
      drawH = dstH;
      drawW = srcW * scale;
    }

    const offsetX = (dstW - drawW) / 2;
    const offsetY = (dstH - drawH) / 2;
    return { scale, offsetX, offsetY };
  }

  // ============================
  // OpenCV: find corners
  // ============================
  private findReceiptCornersOnCanvas(canvasEl: HTMLCanvasElement): { x: number; y: number }[] | null {
    const cvAny: any = (window as any).cv;
    if (!cvAny?.imread) return null;

    let src: any, gray: any, blur: any, edges: any, contours: any, hierarchy: any;
    try {
      src = cvAny.imread(canvasEl);

      gray = new cvAny.Mat();
      cvAny.cvtColor(src, gray, cvAny.COLOR_RGBA2GRAY);

      blur = new cvAny.Mat();
      cvAny.GaussianBlur(gray, blur, new cvAny.Size(5, 5), 0);

      edges = new cvAny.Mat();
      cvAny.Canny(blur, edges, 50, 150);

      contours = new cvAny.MatVector();
      hierarchy = new cvAny.Mat();
      cvAny.findContours(edges, contours, hierarchy, cvAny.RETR_EXTERNAL, cvAny.CHAIN_APPROX_SIMPLE);

      let bestPts: {x:number;y:number}[] | null = null;
      let bestArea = 0;

      for (let i = 0; i < contours.size(); i++) {
        const cnt = contours.get(i);
        const area = cvAny.contourArea(cnt);
        if (area < bestArea) { cnt.delete(); continue; }

        const peri = cvAny.arcLength(cnt, true);
        const approx = new cvAny.Mat();
        cvAny.approxPolyDP(cnt, approx, 0.02 * peri, true);

        if (approx.rows === 4) {
          bestArea = area;
          const pts: {x:number;y:number}[] = [];
          for (let r = 0; r < 4; r++) {
            const x = approx.intPtr(r, 0)[0];
            const y = approx.intPtr(r, 0)[1];
            pts.push({ x, y });
          }
          bestPts = this.orderCorners(pts);
        }

        approx.delete();
        cnt.delete();
      }

      return bestPts;
    } catch {
      return null;
    } finally {
      src?.delete?.();
      gray?.delete?.();
      blur?.delete?.();
      edges?.delete?.();
      contours?.delete?.();
      hierarchy?.delete?.();
    }
  }

  private orderCorners(pts: {x:number;y:number}[]) {
    const sum = pts.map(p => p.x + p.y);
    const diff = pts.map(p => p.x - p.y);

    const tl = pts[sum.indexOf(Math.min(...sum))];
    const br = pts[sum.indexOf(Math.max(...sum))];
    const tr = pts[diff.indexOf(Math.min(...diff))];
    const bl = pts[diff.indexOf(Math.max(...diff))];

    return [tl, tr, br, bl];
  }

  // ============================
  // Capture + warp -> add to batch (max 10)
  // with long-receipt splitting
  // ============================
  captureWarped() {
    if (this.receipts.length >= this.MAX_RECEIPTS) {
      this.limitMsg = `Max ${this.MAX_RECEIPTS} receipts per batch. Process or clear first.`;
      return;
    }

    const video = this.videoRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;

    if (!video.videoWidth || !video.videoHeight) return;
    if (!this.cvReady) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // detect corners again on full-res
    const corners = this.findReceiptCornersOnCanvas(canvas);
    if (!corners) {
      this.cameraHint = 'Could not find corners on capture. Try again.';
      return;
    }

    const warpedCanvas = this.warpCanvasByCorners(canvas, corners);
    if (!warpedCanvas) {
      this.cameraHint = 'Warp failed. Try again.';
      return;
    }

    // ---- NEW: detect tall receipts and split into segments ----
    const MAX_SINGLE_AR = 4.0; // treat >4:1 as "very long"
    const ar = warpedCanvas.height / warpedCanvas.width;

    const mime = this.saveAsPng ? 'image/png' : 'image/jpeg';
    const quality = this.saveAsPng ? undefined : 0.95;

    let segmentCanvases: HTMLCanvasElement[];

    if (ar > MAX_SINGLE_AR) {
      segmentCanvases = this.splitTallReceipt(warpedCanvas, 1800);
      this.cameraHint = `Very long receipt detected — split into ${segmentCanvases.length} part(s).`;
    } else {
      segmentCanvases = [warpedCanvas];
    }

    // Respect remaining capacity
    const remainingSlots = this.MAX_RECEIPTS - this.receipts.length;
    if (segmentCanvases.length > remainingSlots) {
      segmentCanvases = segmentCanvases.slice(0, remainingSlots);
      this.limitMsg = `Added only ${remainingSlots} segment(s). Max ${this.MAX_RECEIPTS} receipts per batch.`;
    }

    const partCount = segmentCanvases.length;

    segmentCanvases.forEach((seg, idx) => {
      // Optional: enhance via OpenCV
      this.enhanceReceiptCanvas(seg);

      // Optional: additional sharpen at lower amount
      if (this.sharpenAfterWarp) this.sharpenCanvas(seg, 0.15);

      seg.toBlob((blob: Blob | null) => {
        if (!blob) return;
        this.addReceipt(blob, 'camera', idx + 1, partCount);
      }, mime as any, quality as any);
    });
  }

  private warpCanvasByCorners(canvasEl: HTMLCanvasElement, corners: {x:number;y:number}[]) {
    const cvAny: any = (window as any).cv;

    let src: any, dst: any, M: any, srcTri: any, dstTri: any;
    try {
      src = cvAny.imread(canvasEl);
      const [tl, tr, br, bl] = corners;

      const widthA = Math.hypot(br.x - bl.x, br.y - bl.y);
      const widthB = Math.hypot(tr.x - tl.x, tr.y - tl.y);
      const heightA = Math.hypot(tr.x - br.x, tr.y - br.y);
      const heightB = Math.hypot(tl.x - bl.x, tl.y - bl.y);

      const upscale = 1.8;
      let maxW = Math.min(3200, Math.max(1, Math.round(Math.max(widthA, widthB) * upscale)));
      let maxH = Math.min(7000, Math.max(1, Math.round(Math.max(heightA, heightB) * upscale)));

      // clamp aspect ratio to avoid absurdly tall single images
      const MAX_AR = 5.0;
      const ar = maxH / maxW;
      if (ar > MAX_AR) {
        maxH = Math.round(maxW * MAX_AR);
      }

      srcTri = cvAny.matFromArray(4, 1, cvAny.CV_32FC2, [
        tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y
      ]);
      dstTri = cvAny.matFromArray(4, 1, cvAny.CV_32FC2, [
        0, 0, maxW - 1, 0, maxW - 1, maxH - 1, 0, maxH - 1
      ]);

      M = cvAny.getPerspectiveTransform(srcTri, dstTri);
      dst = new cvAny.Mat();
      cvAny.warpPerspective(src, dst, M, new cvAny.Size(maxW, maxH));

      const out = document.createElement('canvas');
      out.width = maxW;
      out.height = maxH;
      cvAny.imshow(out, dst);

      return out;
    } catch {
      return null;
    } finally {
      src?.delete?.();
      dst?.delete?.();
      M?.delete?.();
      srcTri?.delete?.();
      dstTri?.delete?.();
    }
  }

  private sharpenCanvas(c: HTMLCanvasElement, amount = 0.25) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    const img = ctx.getImageData(0, 0, c.width, c.height);
    const data = img.data;
    const w = c.width;
    const h = c.height;

    const copy = new Uint8ClampedArray(data);
    const idx = (x:number,y:number)=> (y*w + x) * 4;

    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = idx(x, y);
        for (let ch = 0; ch < 3; ch++) {
          const center = copy[i + ch];
          const v =
            5 * center
            - copy[idx(x - 1, y) + ch] - copy[idx(x + 1, y) + ch]
            - copy[idx(x, y - 1) + ch] - copy[idx(x, y + 1) + ch];

          const out = center + amount * (v - center);
          data[i + ch] = Math.max(0, Math.min(255, out));
        }
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  // Enhance using OpenCV: grayscale + denoise + CLAHE
  private enhanceReceiptCanvas(c: HTMLCanvasElement) {
    const cvAny: any = (window as any).cv;
    if (!cvAny?.imread) return;

    let src: any, gray: any, denoised: any, claheDst: any;
    try {
      src = cvAny.imread(c);

      gray = new cvAny.Mat();
      cvAny.cvtColor(src, gray, cvAny.COLOR_RGBA2GRAY);

      denoised = new cvAny.Mat();
      cvAny.bilateralFilter(gray, denoised, 7, 50, 50);

      claheDst = new cvAny.Mat();
      const clahe = cvAny.createCLAHE(2.0, new cvAny.Size(8, 8));
      clahe.apply(denoised, claheDst);
      clahe.delete();

      const out = new cvAny.Mat();
      cvAny.cvtColor(claheDst, out, cvAny.COLOR_GRAY2RGBA);
      cvAny.imshow(c, out);
      out.delete();
    } catch (e) {
      console.warn('enhanceReceiptCanvas failed', e);
    } finally {
      src?.delete?.();
      gray?.delete?.();
      denoised?.delete?.();
      claheDst?.delete?.();
    }
  }

  // Split tall warped receipt into multiple canvases
  private splitTallReceipt(
    warped: HTMLCanvasElement,
    maxSegmentHeight = 1800
  ): HTMLCanvasElement[] {
    const segments: HTMLCanvasElement[] = [];
    const totalHeight = warped.height;

    if (totalHeight <= maxSegmentHeight) {
      return [warped];
    }

    const numSegments = Math.ceil(totalHeight / maxSegmentHeight);

    for (let i = 0; i < numSegments; i++) {
      const startY = i * maxSegmentHeight;
      const segH = Math.min(maxSegmentHeight, totalHeight - startY);

      const segCanvas = document.createElement('canvas');
      segCanvas.width = warped.width;
      segCanvas.height = segH;

      const ctx = segCanvas.getContext('2d');
      if (!ctx) continue;

      ctx.drawImage(
        warped,
        0, startY, warped.width, segH,
        0, 0, warped.width, segH
      );

      segments.push(segCanvas);
    }

    return segments;
  }

  // ============================
  // Upload multiple (max 10)
  // ============================
  onFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    const remaining = this.MAX_RECEIPTS - this.receipts.length;

    if (remaining <= 0) {
      this.limitMsg = `Max ${this.MAX_RECEIPTS} receipts per batch.`;
      input.value = '';
      return;
    }

    this.limitMsg = '';
    for (const f of files.slice(0, remaining)) {
      this.addReceipt(f, 'upload');
    }

    if (files.length > remaining) {
      this.limitMsg = `Only added ${remaining}. Max ${this.MAX_RECEIPTS} per batch.`;
    }

    input.value = '';
  }

  // ============================
  // Batch helpers
  // ============================
  private makeId() {
    return (crypto as any)?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  }

  private addReceipt(
    blob: Blob,
    source: 'camera' | 'upload',
    partIndex?: number,
    partCount?: number
  ) {
    if (this.receipts.length >= this.MAX_RECEIPTS) {
      this.limitMsg = `Max ${this.MAX_RECEIPTS} receipts per batch. Process or clear first.`;
      return false;
    }

    this.limitMsg = '';
    const id = this.makeId();
    const url = URL.createObjectURL(blob);

    const item: ReceiptShot = {
      id,
      blob,
      url,
      source,
      createdAt: Date.now(),
      partIndex,
      partCount,
    };

    this.receipts.unshift(item);

    // auto select newest
    this.selectReceipt(id);
    return true;
  }

  selectReceipt(id: string) {
    const r = this.receipts.find(x => x.id === id);
    if (!r) return;
    this.selectedId = r.id;
    this.selectedUrl = r.url;
    this.selectedBlob = r.blob;
  }

  removeReceipt(id: string) {
    const idx = this.receipts.findIndex(r => r.id === id);
    if (idx < 0) return;

    URL.revokeObjectURL(this.receipts[idx].url);
    this.receipts.splice(idx, 1);

    if (this.selectedId === id) {
      const next = this.receipts[0];
      if (next) this.selectReceipt(next.id);
      else {
        this.selectedId = undefined;
        this.selectedUrl = undefined;
        this.selectedBlob = undefined;
      }
    }
  }

  clearAllReceipts() {
    this.receipts.forEach(r => URL.revokeObjectURL(r.url));
    this.receipts = [];
    this.selectedId = undefined;
    this.selectedUrl = undefined;
    this.selectedBlob = undefined;
    this.limitMsg = '';
    this.uploadMsg = '';
  }

  // ============================
  // Use selected + save debug (selected)
  // ============================
  useSelected() {
    if (!this.selectedBlob) return;

    const reader = new FileReader();
    reader.onload = () => {
      sessionStorage.setItem('captured_receipt', String(reader.result));
      this.router.navigate(['/scan-receipt']);
    };
    reader.readAsDataURL(this.selectedBlob);
  }

  async saveDebugSelected() {
    if (!this.selectedBlob) return;

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const ext = this.selectedBlob.type.includes('png') ? 'png' : 'jpg';

    this.downloadBlob(this.selectedBlob, `debug_selected_${ts}.${ext}`);

    try {
      const dataUrl = await this.blobToDataURL(this.selectedBlob);
      sessionStorage.setItem('debug_receipt_selected', dataUrl);
      sessionStorage.setItem('debug_receipt_time', ts);
      this.uploadMsg = 'Saved debug (download + sessionStorage).';
    } catch {
      this.uploadMsg = 'Downloaded debug, but sessionStorage is too small.';
    }
  }

  // ============================
  // Backend upload (stub)
  // ============================
  async processAll() {
    // later: send this.receipts blobs via FormData to Python backend
    // For now: store small metadata for navigation
    this.uploadMsg = `Ready to send ${this.receipts.length} receipt(s) to backend.`;
  }

  // ============================
  // Utils
  // ============================
  private downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private blobToDataURL(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error('FileReader failed'));
      r.readAsDataURL(blob);
    });
  }
}