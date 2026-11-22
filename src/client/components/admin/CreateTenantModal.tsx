import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { Input } from "@/client/components/Input";
import {
  Modal,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { notifyTenantsChanged } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import type { ApiErrorPayload } from "@/client/lib/types";
import { isValidSlug, slugify } from "@/client/lib/utils";

// SUPER_ADMIN "create tenant" modal. Optionally seeds the first TENANT_ADMIN via an invite (the
// new-tenant + first-user journey); on success the one-time accept link is shown to copy.
const labelCls = "mb-1 block font-medium text-sm text-text-primary";

export function CreateTenantModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  // The slug auto-derives from the name until the operator edits it directly.
  const [slugEdited, setSlugEdited] = useState(false);
  const [adminEmail, setAdminEmail] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const slugInvalid = slug.length > 0 && !isValidSlug(slug);

  // NOTE: the result view (link set) means the tenant is already saved; the auto-derived slug is
  // not an independent dirty signal, so only count a manually edited slug.
  const isDirty =
    !link &&
    (name.trim() !== "" ||
      (slugEdited && slug.trim() !== "") ||
      adminEmail.trim() !== "");

  useOnModalOpen(modal, () => {
    setName("");
    setSlug("");
    setSlugEdited(false);
    setAdminEmail("");
    setLink(null);
    setCopied(false);
    setError("");
  });

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slugEdited) setSlug(slugify(value));
  };

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const { data, error: apiError } = await api.api.v1.tenants.post({
        name,
        slug,
        adminEmail: adminEmail.trim() || undefined,
      });
      if (apiError) {
        setError(
          (apiError.value as ApiErrorPayload)?.error ||
            t("tenant.createFailed", "Could not create the tenant"),
        );
        return;
      }
      onCreated();
      // Let the header switcher (and any other cached list) refetch so the new tenant is
      // immediately selectable without a full reload.
      notifyTenantsChanged();
      if (data?.invite) {
        setLink(data.invite.acceptUrl);
      } else {
        modal.close();
      }
    } catch {
      setError(t("tenant.createFailed", "Could not create the tenant"));
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard may be unavailable (insecure context); the link stays selectable.
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("tenant.create", "Create tenant")}
      size="md"
      unsavedChanges={isDirty}
    >
      {link ? (
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            {t(
              "invite.linkHint",
              "Send this one-time link to the invitee. It is shown only once.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-text-primary text-xs">
              {link}
            </code>
            <Button size="sm" variant="secondary" onClick={copyLink}>
              {copied ? (
                <Check className="h-4 w-4" aria-hidden="true" />
              ) : (
                <Copy className="h-4 w-4" aria-hidden="true" />
              )}
              {copied ? t("common.copied", "Copied") : t("common.copy", "Copy")}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button onClick={modal.close}>{t("common.done", "Done")}</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading) void handleSubmit();
          }}
        >
          {error && (
            <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
              {error}
            </div>
          )}
          <div>
            <label htmlFor="tenant-name" className={labelCls}>
              {t("tenant.name", "Name")}
            </label>
            <Input
              id="tenant-name"
              type="text"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              required
              disabled={loading}
            />
          </div>
          <div>
            <label htmlFor="tenant-slug" className={labelCls}>
              {t("tenant.slug", "Slug")}
            </label>
            <Input
              id="tenant-slug"
              type="text"
              value={slug}
              onChange={(e) => {
                setSlugEdited(true);
                setSlug(e.target.value);
              }}
              required
              disabled={loading}
              placeholder="acme-co"
              errorMessage={
                slugInvalid
                  ? t(
                      "tenant.slugInvalid",
                      "Use lowercase letters, numbers and single hyphens (no leading/trailing hyphen).",
                    )
                  : undefined
              }
              helperText={t(
                "tenant.slugHint",
                "Lowercase letters, numbers and hyphens.",
              )}
            />
          </div>
          <div>
            <label htmlFor="tenant-admin-email" className={labelCls}>
              {t("tenant.adminEmail", "First admin email (optional)")}
            </label>
            <Input
              id="tenant-admin-email"
              type="email"
              value={adminEmail}
              onChange={(e) => setAdminEmail(e.target.value)}
              disabled={loading}
              placeholder={t("auth.emailPlaceholder", "you@example.com")}
              helperText={t(
                "tenant.adminEmailHint",
                "If set, an invitation link for the tenant admin is generated.",
              )}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={modal.close}
              disabled={loading}
            >
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="submit"
              loading={loading}
              disabled={loading || !name.trim() || !slug.trim() || slugInvalid}
            >
              {t("tenant.create", "Create tenant")}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
