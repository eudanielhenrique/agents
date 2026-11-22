import "react-image-crop/dist/ReactCrop.css";
import { type SyntheticEvent, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactCrop, { type Crop, type PixelCrop } from "react-image-crop";
import { Button } from "@/client/components/Button";
import {
  Modal,
  type ModalController,
  useModal,
  useOnModalOpen,
} from "@/client/components/Modal";

// Crop + downscale a raster image before upload. The aspect is LOCKED per kind (favicon 1:1, logo
// 4:1); the user can move/resize but not change the ratio. The output is re-encoded as a bounded
// PNG, which also keeps uploads well under the size limit. SVG never reaches here — it is uploaded
// as-is (vector, no raster crop).

export type CropKind = "logo" | "favicon";
export type CropVariant = "dark" | "light";
export interface CropPayload {
  variant: CropVariant;
  file: File;
}

// Longest output edge per kind: crisp at the sizes we render, tiny on the wire.
const MAX_EDGE: Record<CropKind, number> = { logo: 512, favicon: 256 };

// Locked crop aspect (width / height) per kind. The favicon is square; the logo is a 4:1 wordmark
// lockup (the recommended logo shape). The user can move/resize the selection but never change the
// ratio. SVG bypasses the cropper entirely (vector, no raster crop).
const ASPECT: Record<CropKind, number> = { logo: 4, favicon: 1 };

// The largest crop of the given aspect that fits inside W×H, centered. At least one edge touches the
// image bound (no wasted margin on both axes) — the rest is letterboxed and centered.
function maxFitCrop(w: number, h: number, aspect: number): PixelCrop {
  const widthLimited = w / h < aspect;
  const cw = widthLimited ? w : h * aspect;
  const ch = widthLimited ? w / aspect : h;
  return {
    unit: "px",
    x: (w - cw) / 2,
    y: (h - ch) / 2,
    width: cw,
    height: ch,
  };
}

async function cropToPngBlob(
  image: HTMLImageElement,
  crop: PixelCrop,
  kind: CropKind,
): Promise<Blob | null> {
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  const sw = crop.width * scaleX;
  const sh = crop.height * scaleY;
  const scale = Math.min(1, MAX_EDGE[kind] / Math.max(sw, sh, 1));
  const outW = Math.max(1, Math.round(sw * scale));
  const outH = Math.max(1, Math.round(sh * scale));
  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(
    image,
    crop.x * scaleX,
    crop.y * scaleY,
    sw,
    sh,
    0,
    0,
    outW,
    outH,
  );
  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}

export function ImageCropperModal({
  modal,
  kind,
  onCropped,
}: {
  modal: ModalController<CropPayload>;
  kind: CropKind;
  onCropped: (variant: CropVariant, blob: Blob) => void;
}) {
  const { t } = useTranslation();
  // Reset the object URL + crop on each open (the file changes per open).
  const [src, setSrc] = useState<string | null>(null);
  useOnModalOpen(modal, () => {
    const file = modal.payload?.file;
    if (!file) return;
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  });

  return (
    <Modal
      modal={modal}
      title={
        kind === "logo"
          ? t("branding.cropLogoTitle", "Adjust logo")
          : t("branding.cropFaviconTitle", "Adjust favicon")
      }
      closeOnOutsideClick={false}
    >
      <CropBody src={src} kind={kind} onCropped={onCropped} />
    </Modal>
  );
}

function CropBody({
  src,
  kind,
  onCropped,
}: {
  src: string | null;
  kind: CropKind;
  onCropped: (variant: CropVariant, blob: Blob) => void;
}) {
  const { t } = useTranslation();
  const { payload, close } = useModal<CropPayload>();
  const imgRef = useRef<HTMLImageElement>(null);
  const [crop, setCrop] = useState<Crop>();
  const [completed, setCompleted] = useState<PixelCrop>();
  const [busy, setBusy] = useState(false);

  const aspect = ASPECT[kind];

  function onImageLoad(e: SyntheticEvent<HTMLImageElement>) {
    const { width, height } = e.currentTarget;
    // Default to the largest aspect-locked selection (at least one edge maxed, no double margin).
    const initial = maxFitCrop(width, height, aspect);
    setCrop(initial);
    // Seed the pixel crop too so "Apply" works on the default selection (onComplete only fires
    // on user interaction; without this the button stays disabled until the user nudges the box).
    setCompleted(initial);
  }

  async function apply() {
    if (!imgRef.current || !completed?.width || !completed?.height || !payload)
      return;
    setBusy(true);
    try {
      const blob = await cropToPngBlob(imgRef.current, completed, kind);
      if (blob) onCropped(payload.variant, blob);
      close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">
        {t("branding.cropHint", "Drag to select the area to keep.")}
      </p>
      <div className="flex max-h-[60vh] justify-center overflow-auto rounded-lg border border-border bg-bg-tertiary p-2">
        {src && (
          <ReactCrop
            crop={crop}
            onChange={(c) => setCrop(c)}
            onComplete={(c) => setCompleted(c)}
            aspect={aspect}
            keepSelection
          >
            <img
              ref={imgRef}
              src={src}
              onLoad={onImageLoad}
              alt=""
              className="max-h-[55vh] w-auto"
            />
          </ReactCrop>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={() => close()} disabled={busy}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          onClick={apply}
          loading={busy}
          disabled={!completed?.width || !completed?.height}
        >
          {t("branding.cropApply", "Apply")}
        </Button>
      </div>
    </div>
  );
}
