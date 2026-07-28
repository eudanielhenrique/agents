// Minimum client interface for transport-agnostic reply delivery.
// ChatwootClient and WhazingClient both satisfy this interface structurally.
// runLoadedTurn and deliverReply depend on it so the agent runtime never
// imports a concrete transport directly.
export interface InboxReplyClient {
  sendMessage(conversationId: number, text: string): Promise<unknown>;
  sendPrivateNote(conversationId: number, text: string): Promise<unknown>;
  sendAudioMessage(
    conversationId: number,
    audio: ArrayBuffer,
    fileName: string,
    mime: string,
    opts?: { transcribedText?: string },
  ): Promise<unknown>;
  toggleTyping(conversationId: number, on: boolean): Promise<unknown>;
}
