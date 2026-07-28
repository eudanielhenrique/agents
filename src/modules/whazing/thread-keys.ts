export function whazingThreadId(
  tenantId: bigint,
  instanceId: bigint,
  ticketId: number,
): string {
  return `tenant:${tenantId}:whazing:${instanceId}:ticket:${ticketId}`;
}

export function whazingContactChannelThreadId(
  tenantId: bigint,
  instanceId: bigint,
  whatsappId: string,
  contactId: number,
): string {
  return `tenant:${tenantId}:whazing:${instanceId}:channel:${whatsappId}:contact:${contactId}`;
}

export function whazingContactPhoneThreadId(
  tenantId: bigint,
  instanceId: bigint,
  normalizedPhone: string,
): string {
  return `tenant:${tenantId}:whazing:${instanceId}:number:${normalizedPhone}`;
}

export function resolveWhazingGraphThreadId(
  tenantId: bigint,
  instanceId: bigint,
  opts: {
    whatsappId?: string | null;
    contactId?: number | null;
    normalizedPhone?: string | null;
    ticketId: number;
  },
): string {
  if (opts.whatsappId && opts.contactId != null) {
    return whazingContactChannelThreadId(
      tenantId,
      instanceId,
      opts.whatsappId,
      opts.contactId,
    );
  }

  if (opts.normalizedPhone) {
    return whazingContactPhoneThreadId(
      tenantId,
      instanceId,
      opts.normalizedPhone,
    );
  }

  return whazingThreadId(tenantId, instanceId, opts.ticketId);
}
