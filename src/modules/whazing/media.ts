import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { cleanTranscription } from "@/modules/chatwoot/render";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { getSttProvider } from "@/modules/stt/providers";
import { readSttConfig, type SttConfig } from "@/modules/stt/settings";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import {
  getVisionProvider,
  type VisionKind,
  visionKindForMime,
} from "@/modules/vision/providers";
import { readVisionConfig, type VisionConfig } from "@/modules/vision/settings";

const MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;
// Whisper hard limit — reject before uploading to avoid a provider-side 413.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;
// Vision providers read the whole file into one request (no streaming) — keep it well under the
// chat-completions payload ceiling most providers enforce.
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Loads the STT config for an agent by reading its settings from the DB.
// Returns null when the agent is not found, disabled, or STT is turned off.
export async function resolveWhazingSttConfig(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<SttConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    });
    if (!agent) return null;
    return readSttConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

// Downloads a Whazing media URL. Uses redirect:"error" for SSRF safety — CDN redirect chains
// are a known vector for open redirects to internal IPs. allowHttp allows private Whazing hosts.
export async function downloadWhazingMedia(
  mediaUrl: string,
  opts?: { fetchImpl?: typeof fetch; maxBytes?: number },
): Promise<{ bytes: ArrayBuffer; contentType: string | null }> {
  const maxBytes = opts?.maxBytes ?? MAX_AUDIO_BYTES;
  await assertSafeOutboundUrl(mediaUrl, { allowHttp: true });
  const res = await (opts?.fetchImpl ?? fetch)(mediaUrl, {
    redirect: "error",
    signal: AbortSignal.timeout(MEDIA_DOWNLOAD_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`whazing media download ${res.status}`);
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > maxBytes) {
    throw new Error(
      `whazing media too large (${bytes.byteLength} B; limit ${maxBytes})`,
    );
  }
  return { bytes, contentType: res.headers.get("content-type") };
}

export interface TranscribeWhazingAudioParams {
  mediaUrl: string;
  cfg: SttConfig;
  tenantId: bigint;
  base?: PrismaClient;
  flow?: FlowContext;
  fetchImpl?: typeof fetch;
}

// Downloads and transcribes a Whazing audio attachment using the agent's STT provider.
// Best-effort: returns null on any skip condition (misconfig, download failure) so a broken STT
// setup never strands a delivery — the caller falls back to the audio-marker string.
export async function transcribeWhazingAudio(
  params: TranscribeWhazingAudioParams,
): Promise<string | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "stt",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getSttProvider(cfg.provider);
  if (!provider) {
    logger.warn("whazing stt: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("whazing stt: no credentialRef — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "whazing stt: credential %s not found — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }
  const effectiveBaseURL = entry.baseUrl ?? cfg.baseURL;
  if (provider.requiresBaseURL && !effectiveBaseURL) {
    logger.warn(
      "whazing stt: provider %s requires baseURL — skipping",
      cfg.provider,
    );
    return skip("no_base_url");
  }

  let bytes: ArrayBuffer;
  let contentType: string | null;
  try {
    ({ bytes, contentType } = await downloadWhazingMedia(params.mediaUrl, {
      fetchImpl: params.fetchImpl,
    }));
  } catch (e) {
    logger.warn(
      "whazing stt: media download failed (%s): %s",
      params.mediaUrl,
      e instanceof Error ? e.message : String(e),
    );
    return skip("download_failed");
  }

  const raw = await withFlowStage(
    params.flow,
    "stt",
    { provider: cfg.provider, model: cfg.model || provider.defaultModel },
    () =>
      provider.transcribe({
        audio: bytes,
        mimeType: contentType,
        language: cfg.language,
        model: cfg.model || provider.defaultModel,
        apiKey: entry.secret,
        baseURL: effectiveBaseURL,
        fetchImpl: params.fetchImpl ?? fetch,
      }),
  );
  return cleanTranscription(raw);
}

// Loads the vision (image/document extraction) config for an agent. Mirrors
// resolveWhazingSttConfig exactly — same null-on-disabled-or-off contract.
export async function resolveWhazingVisionConfig(
  tenantId: bigint,
  agentId: bigint,
  base: PrismaClient = basePrisma,
): Promise<VisionConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const agent = await db.agent.findUnique({
      where: { id: agentId },
      select: { settings: true },
    });
    if (!agent) return null;
    return readVisionConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface ExtractWhazingImageParams {
  mediaUrl: string;
  cfg: VisionConfig;
  tenantId: bigint;
  base?: PrismaClient;
  flow?: FlowContext;
  fetchImpl?: typeof fetch;
}

export interface WhazingExtractResult {
  kind: VisionKind;
  text: string;
}

// Downloads and extracts a Whazing image/document attachment using the agent's vision provider.
// Mirrors transcribeWhazingAudio: best-effort, returns null on any skip condition (misconfig,
// unsupported mime, download failure, empty result) so a broken vision setup never strands a
// delivery — the caller falls back to the bare "<mensagem-de-imagem />" marker.
export async function extractWhazingImage(
  params: ExtractWhazingImageParams,
): Promise<WhazingExtractResult | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getVisionProvider(cfg.provider);
  if (!provider) {
    logger.warn("whazing vision: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("whazing vision: no credentialRef — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "whazing vision: credential %s not found — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }

  let bytes: ArrayBuffer;
  let contentType: string | null;
  try {
    ({ bytes, contentType } = await downloadWhazingMedia(params.mediaUrl, {
      fetchImpl: params.fetchImpl,
      maxBytes: MAX_IMAGE_BYTES,
    }));
  } catch (e) {
    logger.warn(
      "whazing vision: media download failed (%s): %s",
      params.mediaUrl,
      e instanceof Error ? e.message : String(e),
    );
    return skip("download_failed");
  }

  const kind = visionKindForMime(contentType);
  if (!kind) return skip("unsupported_mime");
  if (kind === "document" && !provider.supportsDocuments) {
    return skip("document_not_supported");
  }

  let text: string;
  try {
    text = (
      await withFlowStage(
        params.flow,
        "vision",
        {
          provider: cfg.provider,
          model: cfg.model || provider.defaultModel,
          detail: { kind },
          errorLevel: "warn",
        },
        () =>
          provider.extract({
            bytes,
            mimeType:
              contentType ??
              (kind === "image" ? "image/jpeg" : "application/pdf"),
            kind,
            prompt: cfg.extractionPrompt,
            model: cfg.model || provider.defaultModel,
            apiKey: entry.secret,
            baseURL: entry.baseUrl ?? cfg.baseURL,
            fetchImpl: params.fetchImpl ?? fetch,
          }),
      )
    ).trim();
  } catch (e) {
    logger.error(
      {
        tenantId: String(params.tenantId),
        provider: cfg.provider,
        mime: contentType,
        err: e instanceof Error ? e.message : String(e),
      },
      "whazing vision extraction failed; leaving attachment unextracted",
    );
    return null;
  }
  if (!text) return null;
  return { kind, text };
}
