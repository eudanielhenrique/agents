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

const labelCls = "mb-1 block font-medium text-sm text-text-primary";

export interface EditTenantPayload {
  id: string;
  name: string;
}

// SUPER_ADMIN "edit tenant" modal — name only (the slug is the stable identifier and is not editable).
export function EditTenantModal({
  modal,
  onUpdated,
}: {
  modal: ModalController<EditTenantPayload>;
  onUpdated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const payload = modal.payload;

  useOnModalOpen(modal, () => {
    setName(payload?.name ?? "");
    setError("");
  });

  const isDirty =
    !!payload && name.trim() !== payload.name && name.trim() !== "";

  const handleSubmit = async () => {
    if (!payload) return;
    setError("");
    setLoading(true);
    try {
      const { error: apiError } = await api.api.v1
        .tenants({ id: payload.id })
        .patch({ name: name.trim() });
      if (apiError) {
        setError(
          (apiError.value as ApiErrorPayload)?.error ||
            t("tenant.updateFailed", "Could not update the tenant"),
        );
        return;
      }
      onUpdated();
      notifyTenantsChanged();
      modal.close();
    } catch {
      setError(t("tenant.updateFailed", "Could not update the tenant"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      modal={modal}
      title={t("tenant.edit", "Edit tenant")}
      size="md"
      unsavedChanges={isDirty}
    >
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
          <label htmlFor="edit-tenant-name" className={labelCls}>
            {t("tenant.name", "Name")}
          </label>
          <Input
            id="edit-tenant-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
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
            disabled={loading || !isDirty}
          >
            {t("common.save", "Save")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
