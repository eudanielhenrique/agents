// NOTE: the route token is stored only as its SHA-256 hash (WhazingInstance.webhookRouteTokenHash).
// The plaintext is generated once at provisioning and embedded in the webhook URL configured in
// the Whazing dashboard — it never touches our database in cleartext.
export const WHAZING_WEBHOOK_MOUNT = "/api/v1/whazing/webhook";

export function whazingWebhookUrl(publicUrl: string, routeToken: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${WHAZING_WEBHOOK_MOUNT}/${routeToken}`;
}
