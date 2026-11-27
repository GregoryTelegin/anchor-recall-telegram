import { invalid, keys, record, timestamp } from "../../../domain/companion/protocol";
import { readRichCheckboxDemoMessage, richCheckboxDemoCallbacks, richCheckboxDemoView, validateRichCheckboxDemoPayload } from "../../../features/companion/rich-checkbox-demo";
import { canonical } from "./bridge-contract";
import type { Outbound, ServerState } from "./runtime";

function noLearningMetadata(row: Outbound): void {
  invalid(row.snapshotSequence === undefined && row.answerHandle === undefined && row.mediaPlaceholder === undefined
    && row.hintLease === undefined && row.hintPanel === undefined && row.ratingPanel === undefined && row.sessionPanel === undefined
    && row.sessionContent === undefined && row.questionPanel === undefined && row.pollPanel === undefined, "demo cannot carry learning data");
}

/** A demonstration is a fixed synthetic message with six privately owned controls. */
export function validateStoredRichDemo(s: ServerState, row: Outbound): void {
  invalid(row.method === "sendRichMessage" && row.target === undefined && row.after === undefined);
  noLearningMetadata(row);
  const panel = row.richDemoPanel; record(panel); keys(panel, ["selectedOptionIndexes", "checked", "expiresAt"]); timestamp(panel.expiresAt); invalid(panel.expiresAt > 0);
  validateRichCheckboxDemoPayload(row.payload);
  const initial = readRichCheckboxDemoMessage(row.payload.rich_message);
  invalid(initial.selectedOptionIndexes.length === 0 && initial.checked === false, "demo initial source differs");
  richCheckboxDemoView({ ...initial, selectedOptionIndexes: panel.selectedOptionIndexes, checked: panel.checked });
  const callbacks = [...initial.toggleHandles, initial.checkHandle, initial.resetHandle];
  for (let index = 0; index < callbacks.length; index++) {
    const handle = s.handles.find(handle => handle.id === callbacks[index]);
    if (!handle) continue; // Retired controls remain in the immutable historical message.
    const expected = { kind: "rich-demo", panelId: row.id, operation: index < 4 ? "toggle" : index === 4 ? "check" : "reset", ...(index < 4 ? { index } : {}) };
    invalid(handle.sequence === 0 && handle.expiresAt === panel.expiresAt && canonical(handle.action) === canonical(expected), "demo control differs");
  }
}

export function validateStoredRichDemoEdit(s: ServerState, row: Outbound, target: Outbound): void {
  invalid(s.outbox.includes(target) && target.method === "sendRichMessage" && target.status === "sent"
    && Number.isSafeInteger(target.messageId) && Number(target.messageId) > 0 && row.method === "editMessageText"
    && row.target === target.id && row.after === target.id && row.richDemoPanel === undefined, "unowned demo edit");
  noLearningMetadata(row); validateStoredRichDemo(s, target);
  keys(row.payload, ["chat_id", "rich_message"]);
  validateRichCheckboxDemoPayload({ ...row.payload, message_id: target.messageId }, true);
  invalid(row.payload.chat_id === target.payload.chat_id, "demo edit chat differs");
  const callbacks = richCheckboxDemoCallbacks(target.payload.rich_message);
  invalid(canonical(richCheckboxDemoCallbacks(row.payload.rich_message)) === canonical(callbacks), "demo edit controls differ");
  if (row.status === "queued") {
    const panel = target.richDemoPanel!;
    invalid(canonical(row.payload.rich_message) === canonical(richCheckboxDemoView({ ...callbacks, selectedOptionIndexes: panel.selectedOptionIndexes, checked: panel.checked })), "demo edit state differs");
  }
}
